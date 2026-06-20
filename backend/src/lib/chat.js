/**
 * Chat orchestration — runChatTurn (#340 Fase 1).
 *
 * Responsabilidad:
 *   Dado un mensaje del user y una conversation, orquestar el turno completo:
 *     1. Persistir mensaje del user.
 *     2. Cargar historial previo (mensajes anteriores) como contexto.
 *     3. Llamar al modelo (Claude Sonnet) con system + tools + historial + msg nuevo.
 *     4. Si la respuesta contiene tool_use, ejecutar las tools y loopear con
 *        los tool_results hasta que el modelo devuelva texto final.
 *     5. Persistir el mensaje del assistant (con token tracking).
 *     6. Refrescar updated_at de la conversation + setear titulo si era la
 *        primera interacción.
 *     7. Devolver { assistant_message, tokens, model }.
 *
 * Diseño:
 *   - Todo bajo db.withTenant(ctx.tenantId, ...) para que RLS aplique de
 *     punta a punta (lectura de historial + writes de mensajes + ejecución
 *     de tools que ya usan withTenant internamente). Doble withTenant es
 *     seguro: el nested abre su propia tx con su SET LOCAL.
 *   - Prompt caching: marcamos SYSTEM_PROMPT y TOOLS con cache_control =
 *     ephemeral. Anthropic cachea por 5 min — turnos seguidos del mismo user
 *     pagan ~10% del input cost de esos bloques.
 *   - Tool loop bounded (MAX_TOOL_ITERATIONS): defensa contra loops infinitos
 *     si el modelo se obstina en llamar tools sin converger.
 *   - Si Anthropic falla DESPUÉS de persistir el user msg, el user msg queda
 *     guardado pero sin respuesta. Trade-off consciente: preferimos preservar
 *     el input del user (UX: ve que su pregunta llegó, puede reintentar) en
 *     vez de perderlo silenciosamente al hacer rollback.
 *   - Token tracking incluye cache hits (separados) — útil para dashboard
 *     futuro de costo real.
 *
 * Modelo:
 *   - Sonnet 4.5 (claude-sonnet-4-5): mejor calidad/precio para tool use con
 *     queries analíticas. Haiku queda corto para razonamiento multi-step.
 *
 * Out of scope (Fase 1):
 *   - Streaming (SSE / WebSocket): Fase 2.
 *   - Multi-turn de tool_use intercalado complejo: el loop ya lo soporta,
 *     pero no se testeó al extremo.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../config/database');
const logger = require('./logger');
const { SYSTEM_PROMPT, TOOLS, executeTool } = require('./chat-tools');

// Modelo: Sonnet 4.5 — balance calidad / costo para razonamiento + tool use.
//
// 2026-06-21 TANDA 3 #341: env-overridable vía CHAT_MODEL. Casos de uso:
//   · Tests de carga: forzar haiku (claude-haiku-4-5) para no quemar
//     créditos durante un load test contra el bot.
//   · A/B testing entre versiones del modelo sin redeploy.
//   · Hotfix de modelo deprecated: si Anthropic anuncia EOL de un modelo,
//     setear CHAT_MODEL=<nuevo> en Railway sin tener que mergear código.
//
// Default mantiene comportamiento histórico ('claude-sonnet-4-5') — si la
// env var no está seteada, comportamiento idéntico al pre-refactor.
const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-5';

// Límite duro del loop tool_use → tool_result. En la práctica un turno
// converge en 1-2 iteraciones. 5 da headroom para casos legítimos (ej. el
// bot llama get_kpis_hoy y después decide profundizar con get_ventas_top)
// sin abrir la puerta a loops infinitos.
const MAX_TOOL_ITERATIONS = 5;

// Cuántos mensajes previos cargamos como contexto. Cap defensivo: la
// conversación puede crecer y mandar 100 mensajes inflaría costo + latency.
// 20 mensajes ≈ 10 turnos atrás, suficiente para mantener hilo.
// Si necesitamos más en el futuro, evaluar resumir los más viejos.
const HISTORY_LIMIT = 20;

// Singleton del cliente Anthropic. Se inicializa lazy para que el módulo
// pueda cargar incluso sin ANTHROPIC_API_KEY (útil en tests/CI donde no
// queremos depender del env var). Si en runtime se llama runChatTurn sin
// la key, falla explícito con mensaje claro.
let _anthropicClient = null;
function getAnthropicClient() {
  if (_anthropicClient) return _anthropicClient;
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('Asistente no configurado (falta ANTHROPIC_API_KEY).');
    err.status = 503;
    throw err;
  }
  _anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropicClient;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers internos
// ──────────────────────────────────────────────────────────────────────────

/**
 * Carga últimos N mensajes de la conversación, ordenados cronológicamente
 * (más viejos primero — formato esperado por Anthropic).
 *
 * 2026-06-20 TANDA 0 fix #341 P0-1: La query previa hacía ORDER BY ASC LIMIT
 * 20, lo cual tomaba los 20 mensajes MÁS VIEJOS. Apenas la conversación
 * superaba 20 turnos, el user msg recién guardado caía fuera del array
 * enviado a Anthropic → el bot respondía sin ver la pregunta actual o sin
 * contexto reciente. Fix: subquery con DESC LIMIT, luego invertir.
 *
 * Importante: trae los mensajes "tal cual" se guardaron, incluyendo bloques
 * tool_use + tool_result que vivieron en turnos anteriores. Esto preserva el
 * historial de tools call/result para que el modelo entienda qué se consultó
 * antes y no repita queries innecesarias.
 */
async function loadHistory(client, conversationId) {
  const { rows } = await client.query(
    `SELECT role, content
       FROM (
         SELECT role, content, created_at, id
           FROM chat_messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2
       ) AS recent
      ORDER BY created_at ASC, id ASC`,
    [conversationId, HISTORY_LIMIT]
  );
  return rows.map((r) => ({
    role: r.role,
    // content viene como JSONB → ya parseado por node-postgres a array/object.
    // Anthropic espera array de bloques para mensajes con tool_use; para
    // mensajes de texto plano también acepta array [{type:'text', text:...}].
    content: r.content,
  }));
}

/**
 * Persiste un mensaje (user o assistant) en chat_messages.
 * Retorna el id del mensaje insertado.
 */
async function saveMessage(client, conversationId, tenantId, role, content, tokens = {}) {
  const { rows } = await client.query(
    `INSERT INTO chat_messages
       (conversation_id, tenant_id, role, content,
        tokens_input, tokens_output, tokens_cached, model)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     RETURNING id`,
    [
      conversationId,
      tenantId,
      role,
      JSON.stringify(content),
      tokens.input || 0,
      tokens.output || 0,
      tokens.cached || 0,
      tokens.model || null,
    ]
  );
  return rows[0].id;
}

/**
 * Refresca updated_at del header de la conversación (para ordenar
 * "Mis conversaciones recientes" en el widget).
 *
 * Si la conversación NO tiene titulo todavía (primera interacción), lo
 * derivamos del primer mensaje del user — truncado a ~60 chars y limpiado
 * de saltos de línea. El user puede renombrarlo después.
 */
async function touchConversation(client, conversationId, maybeTitleFromUser) {
  if (maybeTitleFromUser) {
    const t = String(maybeTitleFromUser)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    await client.query(
      `UPDATE chat_conversations
          SET updated_at = NOW(),
              titulo = COALESCE(titulo, $2)
        WHERE id = $1`,
      [conversationId, t || null]
    );
  } else {
    await client.query(
      `UPDATE chat_conversations SET updated_at = NOW() WHERE id = $1`,
      [conversationId]
    );
  }
}

/**
 * Extrae texto plano de un assistant message (concatenando bloques type=text).
 * Útil para el frontend que muestra la respuesta como un string, y para
 * logging / observabilidad.
 */
function extractPlainText(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return '';
  return contentBlocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ──────────────────────────────────────────────────────────────────────────
// API principal
// ──────────────────────────────────────────────────────────────────────────

/**
 * Ejecuta un turno completo de chat.
 *
 * @param {object} params
 * @param {number} params.conversationId  — id de chat_conversations (ya creada)
 * @param {string} params.userText        — texto del user (sin formato especial)
 * @param {object} params.ctx
 * @param {number} params.ctx.tenantId    — tenant id (RLS scope)
 * @param {number} params.ctx.userId      — user id (auditoría futura)
 *
 * @returns {Promise<{
 *   text: string,
 *   content: object[],
 *   tokens: { input: number, output: number, cached: number },
 *   model: string,
 *   tool_calls: number,
 * }>}
 */
async function runChatTurn({ conversationId, userText, ctx }) {
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    throw new Error('runChatTurn: conversationId inválido');
  }
  if (typeof userText !== 'string' || userText.trim() === '') {
    throw new Error('runChatTurn: userText vacío');
  }
  if (!ctx || !Number.isInteger(ctx.tenantId) || ctx.tenantId <= 0) {
    throw new Error('runChatTurn: ctx.tenantId requerido');
  }

  const anthropic = getAnthropicClient();
  const tenantId = ctx.tenantId;

  // 1. Persistir user msg + cargar historial (tx corta, dentro de tenant scope).
  //    Hacemos esto en una tx separada de la llamada al modelo (que puede
  //    durar decenas de segundos) para no mantener una conexión PG abierta
  //    mientras esperamos a Anthropic.
  const userContent = [{ type: 'text', text: userText }];

  const { history } = await db.withTenant(tenantId, async (client) => {
    await saveMessage(client, conversationId, tenantId, 'user', userContent);
    const h = await loadHistory(client, conversationId);
    return { history: h };
  });

  // 2. Loop con el modelo: llamar → si hay tool_use, ejecutar tools, agregar
  //    tool_result, repetir. Salir cuando el último response no tiene tool_use
  //    (= respuesta final en texto).
  let messages = history; // ya incluye el user msg recién guardado
  let iterations = 0;
  let lastResponse = null;
  const tokens = { input: 0, output: 0, cached: 0 };
  let toolCallCount = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations += 1;

    let resp;
    try {
      resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        // System prompt + TOOLS con cache_control: Anthropic cachea
        // ephemerally por 5 min. En turnos seguidos del mismo user, esto
        // ahorra ~10x el costo de esos bloques.
        //
        // 2026-06-20 TANDA 0 fix #341 P1-cost: la versión previa pasaba
        // `tools: TOOLS` plano — el comentario decía que se cacheaba pero
        // el array no tenía cache_control marker. Anthropic cachea desde
        // el inicio hasta el ÚLTIMO breakpoint marcado, así que marcamos
        // el último tool del array. Los 14 tool definitions juntos (~3-5k
        // tokens) ahora sí entran al cache.
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: TOOLS.map((t, i) =>
          i === TOOLS.length - 1
            ? { ...t, cache_control: { type: 'ephemeral' } }
            : t
        ),
        messages,
      });
    } catch (err) {
      // Error de Anthropic (timeout, 429, 5xx, contenido inválido, etc.).
      // No persistimos respuesta — el user msg ya quedó guardado arriba para
      // que el user no pierda el contexto y pueda reintentar.
      logger.error(
        { err, conversationId, tenantId, iterations },
        '[chat] error llamando a Anthropic'
      );
      const e = new Error('No pude generar la respuesta. Probá de nuevo en un momento.');
      e.status = 502;
      e.cause = err;
      throw e;
    }

    lastResponse = resp;

    // Acumular tokens. La SDK devuelve usage con input_tokens, output_tokens,
    // cache_creation_input_tokens, cache_read_input_tokens.
    const usage = resp.usage || {};
    tokens.input += Number(usage.input_tokens || 0);
    tokens.output += Number(usage.output_tokens || 0);
    tokens.cached += Number(usage.cache_read_input_tokens || 0);

    // ¿Tool use? Si stop_reason !== 'tool_use' → terminamos.
    if (resp.stop_reason !== 'tool_use') {
      break;
    }

    // Extraer los bloques tool_use del response.
    const toolUseBlocks = (resp.content || []).filter((b) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      // Defensivo: stop_reason dice tool_use pero no hay bloques. Salimos
      // para evitar loop sin progreso.
      logger.warn(
        { conversationId, tenantId, stop_reason: resp.stop_reason },
        '[chat] stop_reason=tool_use pero sin bloques tool_use'
      );
      break;
    }

    // Ejecutar cada tool y armar el siguiente user msg con tool_results.
    // RLS scope viene de ctx.tenantId — cada handler hace su propio
    // withTenant internamente.
    const toolResults = [];
    for (const tu of toolUseBlocks) {
      toolCallCount += 1;
      logger.info(
        { conversationId, tenantId, tool: tu.name, tool_use_id: tu.id },
        '[chat] ejecutando tool'
      );
      const result = await executeTool(tu.name, tu.input || {}, ctx);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        // Anthropic acepta string o array de bloques. Stringificamos JSON
        // para mantener data estructurada legible por el modelo.
        content: JSON.stringify(result),
        // Si el handler devolvió { error }, marcamos is_error para que
        // Claude entienda el contexto y pueda explicarlo al user.
        is_error: !!(result && result.error),
      });
    }

    // Append assistant response (con tool_use) + user msg con tool_results.
    // Estos NO se persisten en DB todavía — solo viven en el array `messages`
    // para el próximo turno del loop. Lo único que persiste al final es el
    // mensaje final del assistant (que incluye su razonamiento completo).
    //
    // Trade-off: si quisiéramos auditoría detallada de cada tool call,
    // habría que persistir los pasos intermedios. Por ahora preferimos
    // tabla más liviana — la respuesta final ya contiene toda la info útil
    // para el user y los logs del backend tienen el detalle de cada tool.
    messages = [
      ...messages,
      { role: 'assistant', content: resp.content },
      { role: 'user', content: toolResults },
    ];
  }

  if (iterations >= MAX_TOOL_ITERATIONS && lastResponse?.stop_reason === 'tool_use') {
    logger.warn(
      { conversationId, tenantId, iterations, toolCallCount },
      '[chat] tool loop alcanzó MAX_TOOL_ITERATIONS sin converger'
    );
  }

  // 3. Persistir assistant msg final + refrescar conversation. Si la conv
  //    todavía no tenía titulo, lo seteamos del primer mensaje del user.
  const assistantContent = lastResponse?.content || [
    { type: 'text', text: 'No pude generar respuesta esta vez.' },
  ];
  const plainText = extractPlainText(assistantContent);

  await db.withTenant(tenantId, async (client) => {
    await saveMessage(
      client,
      conversationId,
      tenantId,
      'assistant',
      assistantContent,
      {
        input: tokens.input,
        output: tokens.output,
        cached: tokens.cached,
        model: MODEL,
      }
    );
    await touchConversation(client, conversationId, userText);
  });

  return {
    text: plainText,
    content: assistantContent,
    tokens,
    model: MODEL,
    tool_calls: toolCallCount,
  };
}

/**
 * Crea una conversación nueva para el user/tenant del ctx.
 * Retorna { id }.
 *
 * Separado de runChatTurn para que el frontend pueda crear la conv ANTES
 * de mandar el primer mensaje (UX: ya muestra el panel vacío mientras el
 * user escribe). El titulo se settea en el primer runChatTurn.
 */
async function createConversation(ctx) {
  if (!ctx || !Number.isInteger(ctx.tenantId) || !Number.isInteger(ctx.userId)) {
    throw new Error('createConversation: ctx.tenantId + ctx.userId requeridos');
  }
  return db.withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO chat_conversations (tenant_id, user_id)
       VALUES ($1, $2)
       RETURNING id, created_at`,
      [ctx.tenantId, ctx.userId]
    );
    return { id: rows[0].id, created_at: rows[0].created_at };
  });
}

/**
 * Lista las conversaciones del user del ctx (más recientes primero).
 * Usa el índice idx_chat_conv_user_updated.
 *
 * Devuelve metadata liviana (sin mensajes) — el frontend pide los mensajes
 * de UNA conversation puntual con loadConversation().
 */
async function listConversations(ctx, { limit = 30 } = {}) {
  if (!ctx || !Number.isInteger(ctx.tenantId) || !Number.isInteger(ctx.userId)) {
    throw new Error('listConversations: ctx.tenantId + ctx.userId requeridos');
  }
  return db.withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, titulo, created_at, updated_at
         FROM chat_conversations
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [ctx.userId, Math.min(Math.max(1, limit), 100)]
    );
    return rows;
  });
}

/**
 * Carga una conversación con sus mensajes (para reabrir desde el widget).
 * RLS garantiza que solo se devuelve si pertenece al tenant del ctx, y el
 * filtro extra por user_id evita que un user vea conversaciones de un
 * compañero del mismo tenant (chat es PERSONAL, no compartido del tenant).
 */
async function loadConversation(ctx, conversationId) {
  if (!ctx || !Number.isInteger(ctx.tenantId) || !Number.isInteger(ctx.userId)) {
    throw new Error('loadConversation: ctx.tenantId + ctx.userId requeridos');
  }
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    throw new Error('loadConversation: conversationId inválido');
  }
  return db.withTenant(ctx.tenantId, async (client) => {
    const { rows: convRows } = await client.query(
      `SELECT id, titulo, created_at, updated_at
         FROM chat_conversations
        WHERE id = $1 AND user_id = $2`,
      [conversationId, ctx.userId]
    );
    if (convRows.length === 0) return null;
    const { rows: msgRows } = await client.query(
      `SELECT id, role, content, created_at
         FROM chat_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC, id ASC`,
      [conversationId]
    );
    return {
      ...convRows[0],
      messages: msgRows,
    };
  });
}

module.exports = {
  runChatTurn,
  createConversation,
  listConversations,
  loadConversation,
  // exportado para tests
  _internal: { MODEL, MAX_TOOL_ITERATIONS, HISTORY_LIMIT },
};

/**
 * Chat Assistant routes (#340 Fase 1).
 *
 * Endpoints (todos requieren auth, sin requirePermission — disponible para
 * cualquier user del tenant en cualquier plan, decisión con Lucas):
 *
 *   POST   /api/chat/conversations
 *          Crea conversación vacía. Body: {}. Devuelve { id, created_at }.
 *
 *   GET    /api/chat/conversations?limit=N
 *          Lista las conversaciones del user (max 100), más recientes primero.
 *          Devuelve [{id, titulo, created_at, updated_at}, ...].
 *
 *   GET    /api/chat/conversations/:id
 *          Carga 1 conversación con todos sus mensajes (orden cronológico).
 *          Devuelve {id, titulo, messages: [...]}.
 *          404 si no existe / no pertenece al user.
 *
 *   POST   /api/chat/conversations/:id/messages
 *          Manda un mensaje al bot, espera respuesta sincronica. Body:
 *          { text: '...' }. Devuelve { text, content, tokens, model }.
 *          Aplica los 3 rate-limits (per-min, per-day-user, per-day-tenant).
 *
 *   DELETE /api/chat/conversations/:id
 *          Borra conversación + cascada a mensajes. RLS + filtro user_id
 *          garantizan que solo el dueño pueda borrar.
 *
 * Rate-limits (decididos con Lucas):
 *   - 5 mensajes/min/user → anti-spam corto plazo. express-rate-limit con
 *     PostgresRateLimitStore (consistente entre réplicas).
 *   - 50 mensajes/día/user → presupuesto sano de uso individual. Implementado
 *     contra chat_rate_limits (tabla custom — reseteo natural por window_start
 *     diario en ART).
 *   - 150 mensajes/día/tenant → cap colectivo (defense vs un solo user que se
 *     pase MUY abajo de su límite y muchos users del mismo tenant lo hagan
 *     todos a la vez → 50×5 users = 250, queremos cap colectivo más bajo).
 *
 * El per-minute lo aplica express-rate-limit (sin tocar DB en el camino feliz).
 * Los daily se chequean+incrementan en una sola UPSERT atómica para evitar
 * races con réplicas concurrentes.
 */

const router = require('express').Router();
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const PostgresRateLimitStore = require('../lib/postgresRateLimitStore');
const db = require('../config/database');
const logger = require('../lib/logger');
const validate = require('../lib/validate');
const chat = require('../lib/chat');
const {
  createConversationSchema,
  sendMessageSchema,
  listConversationsQuerySchema,
} = require('../schemas/chat');

// ──────────────────────────────────────────────────────────────────────────
// Límites configurables (env-overridable para staging / pruebas)
// ──────────────────────────────────────────────────────────────────────────
const MSG_PER_MIN_PER_USER = Number(process.env.CHAT_MSG_PER_MIN_PER_USER || 5);
const MSG_PER_DAY_PER_USER = Number(process.env.CHAT_MSG_PER_DAY_PER_USER || 50);
const MSG_PER_DAY_PER_TENANT = Number(process.env.CHAT_MSG_PER_DAY_PER_TENANT || 150);

const isTestEnv = process.env.NODE_ENV === 'test';

// Store lazy-inicializado para que se pueda inyectar en tests si hace falta.
// Mismo patrón que signupRoutes.setResendStore() en app.js.
let _chatMinuteStore = null;
function getChatMinuteStore() {
  if (isTestEnv) return undefined;
  if (!_chatMinuteStore) {
    _chatMinuteStore = new PostgresRateLimitStore({ db, prefix: 'chat-min', logger });
  }
  return _chatMinuteStore;
}

// Limiter per-minute (defensa contra spam corto plazo). Aplica solo a POST
// de mensajes; el resto de los endpoints (list, load, create vacía) no tienen
// costo significativo.
const minuteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: MSG_PER_MIN_PER_USER,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: `Pasaste el límite de ${MSG_PER_MIN_PER_USER} mensajes por minuto. Esperá un momento antes de seguir.`,
  },
  // Por user_id (no IP) — un NAT compartido no penaliza a otros users del
  // mismo tenant que estén usando el bot en paralelo.
  keyGenerator: (req) =>
    req.user?.id != null ? `u${req.user.id}` : ipKeyGenerator(req),
  skip: () => isTestEnv,
  ...(getChatMinuteStore() && { store: getChatMinuteStore() }),
});

// ──────────────────────────────────────────────────────────────────────────
// Daily rate limit (custom — contra chat_rate_limits)
// ──────────────────────────────────────────────────────────────────────────
/**
 * Calcula el `window_start` para el día actual en ART (UTC-3 sin DST).
 * Postgres lo guarda como TIMESTAMPTZ — almacenamos el momento en UTC pero
 * cortado a las 00:00 ART del día actual. Eso garantiza un reset natural a
 * medianoche en zona horaria del negocio.
 *
 * Implementación: tomamos NOW en UTC, convertimos a ART sumando -3hs, hacemos
 * floor a día, y devolvemos como ISO. Robusto a corridas a otro huso.
 */
function getTodayWindowStartArtIso() {
  const now = new Date();
  // ART = UTC - 3. Sin DST en Argentina desde 2009 → constante.
  const artNow = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  // Floor a día en UTC (que para artNow representa día ART).
  const artDayStart = new Date(Date.UTC(
    artNow.getUTCFullYear(),
    artNow.getUTCMonth(),
    artNow.getUTCDate(),
    0, 0, 0, 0
  ));
  // Convertir de vuelta a UTC absoluto (sumar 3 horas para que sea las
  // 00:00 ART expresado como instante UTC).
  return new Date(artDayStart.getTime() + 3 * 60 * 60 * 1000).toISOString();
}

/**
 * Middleware: chequea + incrementa el counter diario por user Y por tenant.
 * Si alguno excede el límite, devuelve 429 sin contar (rollback de tx).
 *
 * Estrategia: dentro de una sola tx (con RLS por tenant), incrementamos el
 * counter del user y luego sumamos el total del tenant. Si alguno excede
 * límite, el callback devuelve un objeto `{limit, used, max}` (no throw) →
 * la tx hace COMMIT → respondemos 429 con el counter ya bumpeado.
 *
 * Trade-off intencional: el counter SE incrementa aún cuando devolvemos 429
 * — y también si el handler downstream falla (ej. Anthropic 500), porque
 * este middleware corre ANTES. Cuenta "intentos", no "respuestas exitosas".
 * Anti-abuse por encima de UX perfecta: un loop infinito no puede esquivar
 * el cap haciendo que las requests "fallen" después de pasar.
 */
async function enforceDailyChatLimits(req, res, next) {
  if (isTestEnv) return next();

  const windowStart = getTodayWindowStartArtIso();
  const tenantId = req.tenantId;
  const userId = req.user?.id;

  if (!tenantId || !userId) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  try {
    const exceeded = await db.withTenant(tenantId, async (client) => {
      // 1. UPSERT del counter del user. ON CONFLICT incrementa atómicamente.
      const { rows: userRows } = await client.query(
        `INSERT INTO chat_rate_limits (tenant_id, user_id, window_start, messages)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (user_id, window_start) DO UPDATE
           SET messages = chat_rate_limits.messages + 1
         RETURNING messages`,
        [tenantId, userId, windowStart]
      );
      const userMessages = userRows[0].messages;

      if (userMessages > MSG_PER_DAY_PER_USER) {
        return {
          limit: 'user',
          used: userMessages,
          max: MSG_PER_DAY_PER_USER,
        };
      }

      // 2. SUM del tenant para el window actual. RLS filtra al tenant del ctx.
      const { rows: tRows } = await client.query(
        `SELECT COALESCE(SUM(messages), 0)::int AS total
           FROM chat_rate_limits
          WHERE window_start = $1`,
        [windowStart]
      );
      const tenantMessages = tRows[0].total;

      if (tenantMessages > MSG_PER_DAY_PER_TENANT) {
        return {
          limit: 'tenant',
          used: tenantMessages,
          max: MSG_PER_DAY_PER_TENANT,
        };
      }
      return null;
    });

    if (exceeded) {
      const which = exceeded.limit === 'user' ? 'tu límite' : 'el límite del equipo';
      return res.status(429).json({
        error: `Pasaste ${which} diario del bot (${exceeded.used}/${exceeded.max} mensajes). Se reinicia mañana.`,
        limit_kind: exceeded.limit,
      });
    }
    next();
  } catch (err) {
    logger.error({ err, tenantId, userId }, '[chat] error en enforceDailyChatLimits');
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: parsea + valida conversationId del path
// ──────────────────────────────────────────────────────────────────────────
function parseConversationId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'conversationId inválido' });
    return null;
  }
  return id;
}

// Audit 2026-07-06 P1 (chat bot capability gates): el ctx ahora incluye
// caps + role + tenantCapRol para que las tools sensibles del bot puedan
// aplicar el mismo modelo de autorización que el resto del portal.
//
// Diseño:
//   - `caps`: el objeto plano `{ 'ventas.trabajar': true, ... }` que ya
//     viene embebido en el JWT (ver middleware auth). Fast path sin pegar
//     a DB.
//   - `role`: rol de sistema del user. 'admin' bypassea toda cap (mismo
//     comportamiento que requireCapability.js:44).
//   - `tenantCapRol`: rol dentro del tenant. Owner / admin del tenant
//     también bypassean (mismo isBypassRole()).
//
// Con estos 3 campos, `hasCap(ctx, slug)` en chat-tools.js implementa la
// misma lógica que `hasCapability()` del middleware — sin hacer un round-
// trip a DB por cada tool call.
function ctxFromReq(req) {
  return {
    tenantId:     req.tenantId,
    userId:       req.user?.id,
    caps:         req.user?.caps || {},
    role:         req.user?.role || null,
    tenantCapRol: req.user?.tenant_cap_rol || null,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Endpoints
// ──────────────────────────────────────────────────────────────────────────

router.post(
  '/conversations',
  validate(createConversationSchema),
  async (req, res, next) => {
    try {
      const conv = await chat.createConversation(ctxFromReq(req));
      res.status(201).json(conv);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/conversations',
  validate(listConversationsQuerySchema, 'query'),
  async (req, res, next) => {
    try {
      const list = await chat.listConversations(ctxFromReq(req), {
        limit: req.query.limit,
      });
      res.json(list);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/conversations/:id', async (req, res, next) => {
  try {
    const id = parseConversationId(req, res);
    if (id == null) return;
    const conv = await chat.loadConversation(ctxFromReq(req), id);
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
    res.json(conv);
  } catch (err) {
    next(err);
  }
});

router.delete('/conversations/:id', async (req, res, next) => {
  try {
    const id = parseConversationId(req, res);
    if (id == null) return;
    const deleted = await db.withTenant(req.tenantId, async (client) => {
      // RLS filtra por tenant, y filtro extra por user_id porque chat es
      // PERSONAL (un user no puede borrar conv de un compañero del tenant).
      const { rowCount } = await client.query(
        `DELETE FROM chat_conversations WHERE id = $1 AND user_id = $2`,
        [id, req.user.id]
      );
      return rowCount > 0;
    });
    if (!deleted) return res.status(404).json({ error: 'Conversación no encontrada' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post(
  '/conversations/:id/messages',
  minuteLimiter,
  enforceDailyChatLimits,
  validate(sendMessageSchema),
  async (req, res, next) => {
    try {
      const id = parseConversationId(req, res);
      if (id == null) return;

      // Validar que la conv pertenezca al user (RLS + filtro user_id).
      // Lo hacemos acá explícito para devolver 404 limpio en vez de "user
      // metió mensaje en conv ajena que falla silencioso".
      const exists = await db.withTenant(req.tenantId, async (client) => {
        const { rowCount } = await client.query(
          `SELECT 1 FROM chat_conversations WHERE id = $1 AND user_id = $2`,
          [id, req.user.id]
        );
        return rowCount > 0;
      });
      if (!exists) return res.status(404).json({ error: 'Conversación no encontrada' });

      const result = await chat.runChatTurn({
        conversationId: id,
        userText: req.body.text,
        ctx: ctxFromReq(req),
      });

      // Devolvemos solo lo que el frontend necesita renderizar + cost stats
      // opcionales que el cliente puede mostrar al admin (en logs es donde
      // viven los detalles).
      res.json({
        text: result.text,
        content: result.content,
        model: result.model,
        tokens: result.tokens,
        tool_calls: result.tool_calls,
      });
    } catch (err) {
      // Si runChatTurn ya tagueó err.status, respetarlo. Si no, 500 default.
      if (err && err.status) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

module.exports = router;
// Exportado para tests:
module.exports.enforceDailyChatLimits = enforceDailyChatLimits;
module.exports.getTodayWindowStartArtIso = getTodayWindowStartArtIso;
module.exports._limits = {
  MSG_PER_MIN_PER_USER,
  MSG_PER_DAY_PER_USER,
  MSG_PER_DAY_PER_TENANT,
};

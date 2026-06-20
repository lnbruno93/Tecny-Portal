/**
 * Chat assistant tools — definiciones para Anthropic tool use (#340 Fase 1).
 *
 * Estructura:
 *   - SYSTEM_PROMPT: instrucciones generales al bot (idioma, tono, scope).
 *   - TOOLS: array de tool definitions (schema JSON formato Anthropic).
 *   - executeTool(name, input, ctx): dispatcher que ejecuta la tool real
 *     contra la DB, con tenant context propagado vía ctx.tenantId.
 *
 * Diseño:
 *   - Todas las tools son READ-ONLY. Cero mutations. Decisión #340 con Lucas.
 *     Beneficio: prompt injection imposible de convertir en arma — si user
 *     malicioso mete "borrá todo", el bot no tiene tool de mutation → no
 *     puede hacer nada destructivo. Solo lee.
 *   - Tools tenant-aware: cada ejecución corre dentro de db.withTenant(),
 *     RLS filtra automáticamente. Imposible leak cross-tenant.
 *   - Tool returns tienen forma JSON estructurada (no texto markdown crudo)
 *     para que Claude tenga data limpia que procesar y pueda razonar sobre
 *     campos específicos.
 *
 * Para agregar nueva tool:
 *   1. Definición en TOOLS array (name, description rico, input_schema).
 *   2. Implementación en handlers object con misma key.
 *   3. Listo — el dispatcher la ejecuta automáticamente.
 *
 * Convenciones de naming:
 *   - get_*: queries simples de un dominio (ventas, cajas, stock, etc.)
 *   - search_*: queries con filtros / búsqueda libre
 *   - summarize_*: agregaciones multi-dominio (futuro: dashboard completo)
 */

const db = require('../config/database');
const logger = require('./logger');

// ──────────────────────────────────────────────────────────────────────────
// System prompt — instrucciones al bot
// ──────────────────────────────────────────────────────────────────────────
// Diseño del prompt:
//   - Define quién es el bot ("Asistente Tecny") + su scope (solo este negocio).
//   - Aclara tono (cercano, conciso, en español de Argentina).
//   - Define explícitamente lo que NO puede hacer (no completa ventas, no
//     edita data, no responde sobre temas off-topic).
//   - Da pista de cómo usar las tools eficientemente (combinar si tiene
//     sentido, no llamar 10 tools cuando 1 alcanza).
//
// Cached: este prompt se manda en cada turno. Con prompt caching de
// Anthropic activado, se cachea automáticamente y los siguientes llamados
// dentro de 5 min cuestan ~10% del precio normal.
const SYSTEM_PROMPT = `Sos el Asistente Tecny — un bot conversacional analítico integrado al portal de gestión Tecny (sistema operativo para reseller de tecnología en Argentina).

Tu rol:
- Ayudar al usuario a analizar la data y KPIs de SU negocio (ventas, cajas, stock, comprobantes, tarjetas, envíos, etc.).
- Responder preguntas en lenguaje natural en español rioplatense (vos, no tú).
- Tono cercano pero profesional. Sin emojis a menos que el user los use primero.
- Conciso: prefiero 2 oraciones útiles que 5 redundantes.

Lo que SÍ podés hacer:
- Consultar data del tenant del usuario usando las tools disponibles (todas read-only).
- Calcular y comparar (ventas vs período anterior, top productos, saldos, etc.).
- Sugerir próximos pasos basados en la data ("tenés 3 comprobantes pendientes hace +5 días, conviene revisarlos").
- Explicar conceptos del portal si te lo piden ("¿cómo funciona la trazabilidad de cajas?").

Lo que NO podés hacer (importante):
- NO completar ventas, ni registrar pagos, ni modificar nada. Sos solo análisis/lectura.
- NO responder sobre temas que no tengan que ver con el negocio del user (clima, política, etc.) — re-dirigí amablemente al uso del portal.
- NO inventar datos. Si una tool falla o no devuelve info, decílo claramente. No alucines números.
- NO compartir info de OTROS tenants — eso lo asegura el sistema (RLS), pero no asumas y no especules sobre otros negocios.

Uso eficiente de tools:
- Combiná tools cuando tenga sentido (ej. para "comparame vs ayer" probablemente necesités 2 calls de get_kpis_hoy con distintos rangos).
- Si la respuesta del user es ambigua, preguntá antes de llamar tools (ahorra costo y le da control al user).
- Si el user te pide algo que no tenés tool para responder, decílo claramente — no inventes data.

Formato de respuesta:
- Si devolvés números, formatealos con separador de miles ("$ 1.245.300", no "1245300").
- Si devolvés comparativas, mostrá el delta absoluto Y porcentual.
- Si la respuesta tiene varios datos, usá listas o tablas markdown.`;

// ──────────────────────────────────────────────────────────────────────────
// Tool definitions (Anthropic format)
// ──────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_kpis_hoy',
    description:
      'Devuelve KPIs operativos del día actual del tenant del usuario: ' +
      'monto bruto vendido hoy, comprobantes ingresados hoy, retención ' +
      'financiera, y cantidad de envíos activos. Útil para responder ' +
      'preguntas como "cómo vamos hoy", "cuánto vendí hoy", "actividad ' +
      'del día". No requiere parámetros — siempre devuelve los datos del ' +
      'día actual en zona horaria Argentina (UTC-3).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  // Las próximas tools se agregan acá. Mantener orden por dominio:
  // get_kpis_*, get_ventas_*, get_cajas_*, get_stock_*, etc.
];

// ──────────────────────────────────────────────────────────────────────────
// Handlers — implementación real de cada tool
// ──────────────────────────────────────────────────────────────────────────
// Cada handler recibe (input, ctx) donde:
//   input: objeto validado contra input_schema de la tool definition.
//   ctx:   { tenantId, userId, req? } — context para queries tenant-aware.
//
// Cada handler DEBE:
//   - Correr queries dentro de db.withTenant(ctx.tenantId, ...) para RLS.
//   - Devolver JSON serializable (Claude lo lee como string).
//   - En caso de error, throw — el dispatcher captura y devuelve mensaje
//     friendly al bot que puede reportar al user.
const handlers = {
  async get_kpis_hoy(_input, ctx) {
    return db.withTenant(ctx.tenantId, async (client) => {
      // Día actual en ART (UTC-3). Calculamos start/end del día en TZ AR.
      // Postgres maneja bien TIMESTAMPTZ vs zona horaria.
      // Schema real (verificado contra routes/comprobantes.js):
      //   monto             — monto bruto del comprobante
      //   monto_financiera  — comisión retenida por la financiera (= pct % de monto)
      //   monto_neto        — lo efectivamente cobrado (= monto - monto_financiera)
      //
      // c.fecha es DATE (no TIMESTAMPTZ), pero igual lo comparamos contra el
      // día actual en ART para que un user que ingrese un comprobante con
      // fecha=hoy a las 23:55 ART cuente en el día corriente (no en el
      // siguiente UTC). c.fecha::timestamp + AT TIME ZONE fuerza la
      // interpretación.
      const { rows: kpisRows } = await client.query(`
        SELECT
          COALESCE(SUM(c.monto),            0)::numeric AS bruto_hoy,
          COALESCE(SUM(c.monto_financiera), 0)::numeric AS retencion_hoy,
          COALESCE(SUM(c.monto_neto),       0)::numeric AS neto_hoy,
          COUNT(*)::int                                  AS comprobantes_hoy
        FROM comprobantes c
        WHERE c.fecha = (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      `);

      // Envíos activos: estado 'Pendiente' o 'En camino' (no terminados).
      const { rows: enviosRows } = await client.query(`
        SELECT COUNT(*)::int AS envios_activos
        FROM envios
        WHERE estado IN ('Pendiente', 'En camino')
      `);

      // Pct financiera (del tenant) — defensive si no hay config.
      const { rows: configRows } = await client.query(`
        SELECT COALESCE(pct_financiera, 3.0)::numeric AS pct_financiera
        FROM config
        LIMIT 1
      `);

      const kpis = kpisRows[0] || {};
      const envios = enviosRows[0] || {};
      const config = configRows[0] || {};

      return {
        bruto_hoy: Number(kpis.bruto_hoy || 0),
        retencion_hoy: Number(kpis.retencion_hoy || 0),
        neto_hoy: Number(kpis.neto_hoy || 0),
        comprobantes_hoy: kpis.comprobantes_hoy || 0,
        envios_activos: envios.envios_activos || 0,
        pct_financiera: Number(config.pct_financiera || 3.0),
        fecha: new Date()
          .toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }),
      };
    });
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────────
async function executeTool(name, input, ctx) {
  const handler = handlers[name];
  if (!handler) {
    logger.warn({ toolName: name }, '[chat-tools] handler no encontrado');
    return { error: `Tool "${name}" no implementada.` };
  }
  try {
    const result = await handler(input || {}, ctx);
    return result;
  } catch (err) {
    logger.error({ err, toolName: name, tenantId: ctx.tenantId }, '[chat-tools] error ejecutando handler');
    // Devolvemos error como data para que el bot pueda explicarlo al user
    // (en vez de propagar el throw que cortaría la conversación).
    return {
      error: 'Hubo un error obteniendo los datos. Probá de nuevo en un momento.',
      _internal: process.env.NODE_ENV === 'production' ? undefined : err.message,
    };
  }
}

module.exports = {
  SYSTEM_PROMPT,
  TOOLS,
  executeTool,
};

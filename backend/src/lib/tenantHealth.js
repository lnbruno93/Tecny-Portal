/**
 * Tenant health score (#440).
 *
 * Score 0–100 combinando 4 componentes ponderados. Es una métrica de
 * "vista de pájaro" para que el super-admin priorice atención: cuáles
 * cuentas se enfrían, cuáles tienen onboarding incompleto, cuáles están
 * por vencer pago.
 *
 * Fórmula:
 *   salud = 0.30 × actividad     (ventas + bot en últimos 30 días)
 *         + 0.30 × cobros_al_dia  (días hasta vencer pago/trial)
 *         + 0.20 × adopcion       (features que el tenant está usando)
 *         + 0.20 × asientos       (users vs capacity del plan)
 *
 * Override especial: si el tenant tiene <7 días desde signup, categoría
 * pasa a 'onboarding' (color azul, no rojo) y score se eleva a min 50.
 * Esto evita que tenants nuevos legítimos aparezcan "fríos" antes de
 * tener oportunidad de generar actividad.
 *
 * Diseño:
 *   · Función pura: recibe stats, devuelve { score, breakdown, category }.
 *     Sin queries acá — la SQL la hace el caller y nos pasa los counts.
 *     Esto la hace 100% testeable sin DB.
 *   · breakdown se devuelve para que el frontend pueda mostrar las 4
 *     barras desglosadas en el tab Resumen (mostrar "por qué" del score).
 *   · category es una etiqueta humana para el badge (excellent/healthy/
 *     onboarding/at-risk/cold), separada del color para que el componente
 *     decida (mismo dato, formato distinto).
 *
 * Tunables (no exports — cambiar la fórmula es cambiar este archivo).
 * Pesos suman 1.0; si querés rebalancear, mantené esa invariante.
 */

const WEIGHTS = {
  actividad: 0.30,
  cobros:    0.30,
  adopcion:  0.20,
  asientos:  0.20,
};

// Capacidad esperada de asientos por plan. Un trial con 1 user está
// "lleno"; un pro con 1 user está "vacío". El criterio es "qué porcentaje
// de la capacidad del plan está ocupada", no un número absoluto.
const SEATS_BY_PLAN = {
  trial:      2,
  starter:    3,
  pro:       10,
  enterprise: 50,
};

const ONBOARDING_DAYS = 7;
const ACTIVITY_WINDOW_DAYS = 30;

/**
 * Compute health score y breakdown a partir de stats agregadas.
 *
 * @param {Object} input
 * @param {Object} input.tenant — la fila de tenants con created_at, plan,
 *                                 suspended_at, trial_until, paid_until,
 *                                 custom_mrr_usd
 * @param {Object} input.stats — counts agregados:
 *   { ventas_30d, bot_msgs_30d, users_count, productos_count,
 *     contactos_count, cajas_count, alertas_count }
 *
 * @returns {Object} { score, breakdown: { actividad, cobros, adopcion,
 *                     asientos }, category }
 */
function computeHealthScore({ tenant, stats } = {}) {
  // Normalizar inputs: aceptamos null/undefined. JS default params solo
  // disparan en undefined — null pasa derecho y rompe los sub-scorers.
  tenant = tenant || {};
  stats  = stats  || {};

  // Suspendido = salud 0 inmediato. No sigas la fórmula — un tenant
  // suspendido es un caso operativo distinto (bloqueado por el operador).
  if (tenant.suspended_at) {
    return {
      score: 0,
      breakdown: { actividad: 0, cobros: 0, adopcion: 0, asientos: 0 },
      category: 'suspended',
    };
  }

  const actividad = scoreActividad(stats);
  const cobros    = scoreCobros(tenant);
  const adopcion  = scoreAdopcion(stats);
  const asientos  = scoreAsientos(tenant, stats);

  // Promedio ponderado redondeado a entero (mostramos siempre como int).
  const raw = (
    WEIGHTS.actividad * actividad +
    WEIGHTS.cobros    * cobros +
    WEIGHTS.adopcion  * adopcion +
    WEIGHTS.asientos  * asientos
  );
  let score = Math.round(raw);

  // Onboarding override: <7 días desde signup → categoría 'onboarding'
  // + piso de 50pts. Evita que TekHaus aparezca como "frío" en su día 1.
  const daysSinceSignup = daysSince(tenant?.created_at);
  const isOnboarding = daysSinceSignup != null && daysSinceSignup < ONBOARDING_DAYS;
  if (isOnboarding) {
    score = Math.max(score, 50);
    return {
      score,
      breakdown: { actividad, cobros, adopcion, asientos },
      category: 'onboarding',
    };
  }

  return {
    score,
    breakdown: { actividad, cobros, adopcion, asientos },
    category: categorize(score),
  };
}

// ── Sub-scorers (cada uno devuelve 0-100) ──────────────────────────────────

/**
 * Actividad de uso real: ventas + bot en últimos 30 días.
 * Escala log-ish para que pasar de 0 → 1 cuente más que de 100 → 101.
 *
 *   0 ventas + 0 bot      →   0
 *   1 venta o 5 msgs bot  →  40 ("hay vida")
 *   5 ventas o 20 msgs    →  70
 *   20+ ventas o 100+ msg → 100
 */
function scoreActividad(stats = {}) {
  const ventas = Number(stats.ventas_30d) || 0;
  const botMsgs = Number(stats.bot_msgs_30d) || 0;

  let v = 0;
  if (ventas >= 20)      v = 100;
  else if (ventas >= 5)  v =  70;
  else if (ventas >= 1)  v =  40;

  let b = 0;
  if (botMsgs >= 100)    b = 100;
  else if (botMsgs >= 20) b =  70;
  else if (botMsgs >= 5)  b =  40;

  // Max de los dos — una señal fuerte sola es suficiente.
  return Math.max(v, b);
}

/**
 * Cobros al día: mira trial_until / paid_until contra HOY.
 *
 *   Sin fecha de vencimiento conocida → 50 (incierto, neutro)
 *   Vencido                            →  0
 *   Vence en <3 días                   → 30 (warn)
 *   Vence en <7 días                   → 60
 *   Vence en >=30 días                 → 100
 *   Entre 7 y 30 días: lineal entre 60 y 100
 *
 * Trial usa trial_until; paid plans usan paid_until. Enterprise sin
 * paid_until → 100 (grandfathered, contrato anual).
 */
function scoreCobros(tenant = {}) {
  const plan = tenant.plan;
  const referenceDate = plan === 'trial' ? tenant.trial_until : tenant.paid_until;

  // Enterprise grandfathered (sin paid_until + custom_mrr_usd seteado):
  // contrato anual fuera de banda → asumimos "al día".
  if (plan === 'enterprise' && !tenant.paid_until && tenant.custom_mrr_usd != null) {
    return 100;
  }

  if (!referenceDate) {
    // Sin fecha de referencia → neutro (no podemos juzgar).
    return 50;
  }

  const days = daysUntil(referenceDate);
  if (days == null) return 50;       // fecha no parseable
  if (days < 0)     return 0;        // vencido
  if (days < 3)     return 30;       // crítico
  if (days < 7)     return 60;       // warn
  if (days >= 30)   return 100;
  // Lineal entre 7 y 30 días: 60 → 100.
  return Math.round(60 + ((days - 7) / (30 - 7)) * 40);
}

/**
 * Adopción de features: cuántos módulos básicos usó el tenant.
 *
 * Por cada uno suma 20pts (max 100):
 *   - tiene productos cargados
 *   - tiene contactos cargados
 *   - tiene al menos 1 caja
 *   - hizo al menos 1 venta
 *   - configuró al menos una alerta
 */
function scoreAdopcion(stats = {}) {
  let pts = 0;
  if ((stats.productos_count   ?? 0) > 0) pts += 20;
  if ((stats.contactos_count   ?? 0) > 0) pts += 20;
  if ((stats.cajas_count       ?? 0) > 0) pts += 20;
  if ((stats.ventas_total      ?? 0) > 0) pts += 20;
  if ((stats.alertas_count     ?? 0) > 0) pts += 20;
  return pts;
}

/**
 * Asientos ocupados: users vs capacity del plan.
 *
 * Capacity esperada por plan en SEATS_BY_PLAN. 100% ocupado = score 100.
 * Esto da una señal de "el cliente está sacándole jugo a su plan" — útil
 * para detectar candidates a upgrade (asientos al 90%+) y subutilización
 * (asientos <20% en plan caro).
 */
function scoreAsientos(tenant = {}, stats = {}) {
  const users = Number(stats.users_count) || 0;
  const capacity = SEATS_BY_PLAN[tenant.plan] || SEATS_BY_PLAN.pro;
  return Math.min(100, Math.round((users / capacity) * 100));
}

/**
 * Categoría humana del score (excepto onboarding/suspended, manejados aparte).
 * Mismos thresholds que el healthColor del frontend para que el badge y
 * el color matcheen sin lógica duplicada.
 */
function categorize(score) {
  if (score >= 80) return 'excellent';
  if (score >= 55) return 'healthy';
  if (score >= 40) return 'at-risk';
  return 'cold';
}

// ── Helpers de fecha ───────────────────────────────────────────────────────

function daysSince(dateLike) {
  if (!dateLike) return null;
  const ts = new Date(dateLike).getTime();
  if (isNaN(ts)) return null;
  return (Date.now() - ts) / 86400000;
}

function daysUntil(dateLike) {
  if (!dateLike) return null;
  const ts = new Date(dateLike).getTime();
  if (isNaN(ts)) return null;
  return (ts - Date.now()) / 86400000;
}

module.exports = {
  computeHealthScore,
  // Exportados para tests + posible reuso (e.g. tooltip "qué es esto").
  WEIGHTS,
  SEATS_BY_PLAN,
  ONBOARDING_DAYS,
  ACTIVITY_WINDOW_DAYS,
};

/**
 * planPricing — fuente única del precio USD/mes por plan (Sub-fase C.1 #353).
 *
 * Carga inicial desde la tabla `plan_prices` en startup (`primeCache`).
 * Refresca cada 5 minutos automáticamente (`setInterval`, configurable
 * por env). El endpoint admin PATCH `/api/super-admin/plan-prices/:plan`
 * llama a `refreshCache()` después de un UPDATE para que el cambio se
 * vea inmediatamente en este proceso (sin esperar al próximo refresh).
 *
 * Usado por:
 *   - `/api/super-admin/metrics`        — cálculo de MRR total + tenants_by_plan
 *   - `/api/super-admin/tenants[/:id]`  — cálculo de MRR per-tenant en list/detail
 *   - `/api/public/pricing`             — endpoint público para la landing (C.1.2)
 *
 * Multi-instance caveat:
 *   El cache es por-proceso. Si hay >1 réplica del backend, cada una
 *   refresca por su cuenta cada 5min. Cambios desde el admin se ven
 *   inmediato SOLO en la réplica que recibió el PATCH; el resto los
 *   ve en su próximo refresh (max 5min). Si en el futuro se necesita
 *   hot-invalidate cross-instance, migrar a Redis pub/sub — sub-fase
 *   futura. Hoy Railway corre 1-2 réplicas y 5min de drift es aceptable.
 *
 * Fallback en cold-start:
 *   Si la primera llamada a `loadFromDb()` falla (DB down, migration
 *   pendiente, etc.), el cache queda con los valores DEFAULTS (los
 *   mismos que el seed de la migration). Esto evita que el backend
 *   crashee al start si la DB tarda en responder — devuelve precios
 *   conservadores ($0 al final si todo falla, mismo que pre-C.1) y
 *   reintentando en el próximo tick.
 *
 * Por qué no en Redis directamente:
 *   `plan_prices` es config global, baja frecuencia de cambio (Lucas
 *   actualiza pricing mensual/trimestral, no por minuto). Una tabla
 *   SQL es más sólido para auditoría + queries forenses ("¿qué precio
 *   tenía starter el 2026-04-15?" — agregamos `plan_prices_history`
 *   en una fase futura si hace falta).
 */

const db = require('../config/database');
const logger = require('./logger');

// Defaults: matchean el seed de la migration 20260622153000_plan_prices_table.
// Sirven SOLO en cold-start cuando loadFromDb falla. En operación normal el
// cache se llena desde la DB con estos mismos valores (excepto que Lucas los
// haya cambiado desde el admin).
const DEFAULT_PRICES = Object.freeze({
  trial: 0,
  starter: 39,
  pro: 189,
  enterprise: null,
});

// Cache mutable — populado por loadFromDb. Cualquier código que necesite
// leer un precio debe usar getPlanPrices() (no importar esta variable, que
// queda stale por reference si se destructura).
let _cache = { ...DEFAULT_PRICES };

// Timer del refresh periódico. Se inicia en primeCache, se limpia en stop.
let _refreshTimer = null;

// TTL configurable por env (default 5 min). Más bajo = más overhead a DB
// pero menos drift visible al cambiar precios desde el admin.
const REFRESH_INTERVAL_MS = parseInt(process.env.PLAN_PRICES_REFRESH_MS) || 5 * 60 * 1000;

/**
 * Lee `plan_prices` y actualiza el cache local. Llamado por primeCache
 * (startup), refreshCache (post-PATCH), y el interval timer (cada 5min).
 *
 * No throws — solo loguea warn si falla. El cache queda con los valores
 * previos (idempotente bajo failure). Crítico para no crashear el backend
 * en startup si la DB tarda en responder.
 */
async function loadFromDb() {
  try {
    const { rows } = await db.query(
      `SELECT plan, price_usd FROM plan_prices WHERE active = true`
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      logger.warn('[planPricing] plan_prices vacío o no responde — manteniendo cache previo');
      return;
    }
    const next = { ...DEFAULT_PRICES };
    for (const r of rows) {
      // price_usd viene como string del driver pg para NUMERIC. Convertir
      // a number para evitar "$39" + concat string en lugar de aritmética.
      next[r.plan] = r.price_usd === null ? null : Number(r.price_usd);
    }
    _cache = next;
  } catch (err) {
    logger.warn({ err: err.message }, '[planPricing] failed to load from DB — keeping previous cache');
  }
}

/**
 * Inicializa el cache desde DB y arranca el timer de refresh periódico.
 * Llamar UNA vez desde server.js startup. Idempotente — si se llama
 * dos veces, el segundo call resetea el timer (no duplica).
 */
async function primeCache() {
  await loadFromDb();
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(loadFromDb, REFRESH_INTERVAL_MS);
  // unref → no bloquea node exit (importante para tests y graceful shutdown)
  _refreshTimer.unref?.();
  logger.info(
    { interval_ms: REFRESH_INTERVAL_MS, prices: _cache },
    '[planPricing] cache primed'
  );
}

/**
 * Hot-invalidate del cache. Llamado por el endpoint admin después de un
 * UPDATE a plan_prices, para que el operador vea el cambio inmediato sin
 * esperar el próximo refresh periódico (que puede tardar hasta 5min).
 *
 * Multi-instance: solo invalida ESTA réplica. Las otras se enteran en su
 * próximo refresh. Aceptable para uso operativo (Lucas no hace 30
 * actualizaciones por minuto).
 */
async function refreshCache() {
  await loadFromDb();
}

/**
 * Devuelve un snapshot del cache actual. Los callers deben llamar esto
 * en cada request — NO cachear el resultado en una const a nivel módulo,
 * porque el cache se actualiza periódicamente.
 *
 * @returns {object} { trial, starter, pro, enterprise } — enterprise siempre null
 */
function getPlanPrices() {
  return _cache;
}

/**
 * Devuelve el MRR USD/mes de un tenant dado su plan + custom_mrr_usd.
 * SYNC por diseño (lee del cache en memoria) — usado en hot paths del
 * dashboard admin que listan N tenants.
 *
 * @param {string} plan — uno de 'trial' | 'starter' | 'pro' | 'enterprise'
 * @param {number|null} customMrrUsd — solo se usa si plan === 'enterprise'
 * @returns {number} MRR del tenant en USD (0 para trial / desconocido).
 */
function getTenantMrr(plan, customMrrUsd) {
  if (plan === 'enterprise') {
    // Si no se cargó custom_mrr_usd, asumimos 0 (en práctica el admin lo
    // setea al onboardear; pero no queremos NaN en el dashboard).
    return Number(customMrrUsd) || 0;
  }
  const price = _cache[plan];
  return typeof price === 'number' ? price : 0;
}

/**
 * Trial duration default — 14 días desde signup. Confirmado por Lucas
 * en design doc. Si se cambia, cambiar también el comentario del UI.
 */
const TRIAL_DURATION_DAYS = 14;

// ── Compat retroactivo: PLAN_PRICES_USD exportado como getter ────────
// Los consumidores legacy (superAdmin.js antes de C.1) usaban
// `const { PLAN_PRICES_USD } = require('../lib/planPricing')` y leían el
// objeto directamente. Para que sigan funcionando SIN drift de cache,
// exponemos PLAN_PRICES_USD como un getter dinámico que siempre devuelve
// el snapshot actual. Los consumidores nuevos deberían usar
// `getPlanPrices()` explícitamente — más obvio que es una operación de
// lectura del cache.
const exports_ = {
  TRIAL_DURATION_DAYS,
  DEFAULT_PRICES,
  getTenantMrr,
  getPlanPrices,
  primeCache,
  refreshCache,
};
Object.defineProperty(exports_, 'PLAN_PRICES_USD', {
  enumerable: true,
  get() { return _cache; },
});

module.exports = exports_;

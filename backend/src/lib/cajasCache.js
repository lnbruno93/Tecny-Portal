// Caché TTL para GET /api/cajas/cajas.
//
// Perf H3 auditoría 2026-06-06: la lista de cajas se pide MUCHO (dropdowns
// en Ventas/Cajas/Proyectos/Tarjetas/Financiera + dashboard 360 + page-loads).
// Cada call hace LEFT JOIN + GROUP BY sobre caja_movimientos para calcular
// `saldo_actual` — el costo escala lineal con el ledger (que crece todos los
// días). En staging con ~30k movimientos ya se siente; en prod con años de
// histórico va a ser un cuello.
//
// 2026-06-12 P-04 Fase 3.2: cache movido de in-memory local a Redis cross-
// instance. La invalidación post-write (5 callsites en cajas.js) ahora
// propaga a las 2 réplicas Railway en <100ms en lugar del max 15s de TTL
// natural. Significa que cuando admin crea/edita/elimina una caja o
// agrega un movimiento, AMBAS réplicas ven el cambio inmediato.
//
// Fire-and-forget en callers: `invalidateCajas()` ahora devuelve Promise,
// pero los callers no la await — la invalidación es best-effort, no crítica
// para el response. Si Redis cae, el wrapper hace fetch directo a Postgres
// sin cachear (consistency preservada a costo de throughput durante outage).
//
// 2026-06-15 PR 4.9 multi-tenant cleanup: cache ahora es POR TENANT. La key
// de Redis incluye el tenant_id, y cada tenant tiene su propio fetcher
// memoizado en `fetchers` (Map). El fetcher corre la query bajo
// `db.withTenant(tenantId, ...)` para que RLS filtre las cajas del tenant
// correcto. Sin esto, los tenants verían el cache del primer tenant que
// hizo el request. La invalidación también es per-tenant: `invalidateCajas
// (tenantId)` invalida solo ese tenant. Si no se pasa tenantId, loggea
// warning y no invalida (admin scripts sin contexto multi-tenant).

const { createCachedFetcherRedis } = require('./cacheTtl');
const db = require('../config/database');
const logger = require('./logger');

// Query idéntica a la GET /cajas original (cajas.js). Mantener sincronizada
// si se modifica el SELECT del endpoint.
const CAJAS_SQL = `
  SELECT mp.id, mp.nombre, mp.moneda, mp.activo, mp.orden, mp.saldo_inicial, mp.es_financiera,
         mp.es_tarjeta, mp.comision_pct,
         mp.saldo_inicial + COALESCE(SUM(CASE WHEN cm.tipo='ingreso' THEN cm.monto ELSE -cm.monto END), 0) AS saldo_actual,
         COUNT(cm.id) FILTER (WHERE cm.id IS NOT NULL) AS movimientos
    FROM metodos_pago mp
    LEFT JOIN caja_movimientos cm ON cm.caja_id = mp.id AND cm.deleted_at IS NULL
   WHERE mp.deleted_at IS NULL
   GROUP BY mp.id
   ORDER BY mp.orden, mp.nombre`;

// Fetchers memoizados por tenant. Cada tenant tiene su propio
// createCachedFetcherRedis con su propia key Redis. LRU cap simple: si
// superamos MAX_FETCHERS, eliminamos el más viejo. Para 256 tenants
// concurrentes activos es suficiente; si crecemos más, considerar LRU
// library real.
const MAX_FETCHERS = 256;
const fetchers = new Map();

function getFetcherForTenant(tenantId) {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`getCajasList: tenantId inválido (${tenantId})`);
  }
  let fn = fetchers.get(tenantId);
  if (fn) {
    // Bump al final (LRU-ish): re-inserta para que sea el más reciente.
    fetchers.delete(tenantId);
    fetchers.set(tenantId, fn);
    return fn;
  }
  fn = createCachedFetcherRedis(
    `cache:cajas:list:t${tenantId}`,
    15_000,
    async () => {
      // RLS filtra metodos_pago y caja_movimientos por tenant_id gracias
      // al SET LOCAL que pone db.withTenant.
      return db.withTenant(tenantId, async (client) => {
        const { rows } = await client.query(CAJAS_SQL);
        return rows;
      });
    }
  );
  fetchers.set(tenantId, fn);
  if (fetchers.size > MAX_FETCHERS) {
    const oldestKey = fetchers.keys().next().value;
    fetchers.delete(oldestKey);
  }
  return fn;
}

// Devuelve la lista de cajas del tenant especificado, cacheada 15s.
async function getCajasList(tenantId) {
  return getFetcherForTenant(tenantId)();
}

// Invalida el cache de un tenant específico. Async (Promise<void>),
// fire-and-forget en callers. Si no se pasa tenantId, loggea warning y no
// invalida nada — protege contra misuse desde admin scripts que pierden
// contexto de tenant.
async function invalidateCajas(tenantId) {
  if (tenantId == null) {
    logger.warn('invalidateCajas() sin tenantId — no-op. Path probable: script admin sin contexto multi-tenant.');
    return;
  }
  const fn = fetchers.get(tenantId);
  if (fn) await fn.invalidate();
}

module.exports = {
  getCajasList,
  invalidateCajas,
};

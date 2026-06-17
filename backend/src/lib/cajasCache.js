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
// natural.
//
// 2026-06-15 PR 4.9 multi-tenant cleanup: cache POR TENANT con key que
// incluye tenant_id.
//
// TANDA 4 refactor (auditoría 2026-06-17 H3-Hyg): migrado al patrón
// `createTenantScopedCache`. La factory genérica vive en lib/cacheTtl.js y
// reemplaza el Map<tenantId, fetcher> + LRU + factory duplicados en
// 6 archivos del codebase.

const { createTenantScopedCache } = require('./cacheTtl');
const { CAJAS_LIST } = require('./cacheConfig');
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

const cache = createTenantScopedCache({
  ...CAJAS_LIST,
  fetcher: async (tenantId) => {
    const id = Number(tenantId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`getCajasList: tenantId inválido (${tenantId})`);
    }
    // RLS filtra metodos_pago y caja_movimientos por tenant_id gracias
    // al SET LOCAL que pone db.withTenant.
    return db.withTenant(id, async (client) => {
      const { rows } = await client.query(CAJAS_SQL);
      return rows;
    });
  },
});

// Devuelve la lista de cajas del tenant especificado, cacheada 15s.
async function getCajasList(tenantId) {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`getCajasList: tenantId inválido (${tenantId})`);
  }
  return cache.get(tenantId);
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
  return cache.invalidate(tenantId);
}

module.exports = {
  getCajasList,
  invalidateCajas,
};

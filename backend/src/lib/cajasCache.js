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

const { createCachedFetcherRedis } = require('./cacheTtl');
const db = require('../config/database');

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

const getCajasList = createCachedFetcherRedis('cache:cajas:list', 15_000, async () => {
  const { rows } = await db.query(CAJAS_SQL);
  return rows;
});

module.exports = {
  getCajasList,
  // Async (Promise<void>) — el caller puede await si quiere garantía de
  // invalidación pre-response, o fire-and-forget para latencia mínima.
  // En cajas.js se usa fire-and-forget: el response del POST/PATCH/DELETE
  // sale en paralelo, y la invalidación se completa en <100ms (Railway
  // internal Redis). Race de visibilidad cross-instance ≤100ms es invisible
  // para usuarios humanos.
  invalidateCajas: () => getCajasList.invalidate(),
};

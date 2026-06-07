// Caché TTL para GET /api/cajas/cajas.
//
// Perf H3 auditoría 2026-06-06: la lista de cajas se pide MUCHO (dropdowns
// en Ventas/Cajas/Proyectos/Tarjetas/Financiera + dashboard 360 + page-loads).
// Cada call hace LEFT JOIN + GROUP BY sobre caja_movimientos para calcular
// `saldo_actual` — el costo escala lineal con el ledger (que crece todos los
// días). En staging con ~30k movimientos ya se siente; en prod con años de
// histórico va a ser un cuello.
//
// Solución: TTL corto (15s) + invalidación explícita post-write desde
// cajaLedger.js (helper central de movimientos) y desde las rutas que tocan
// metodos_pago o caja_movimientos directamente (cajas.js).
//
// Multi-instance (Railway 2 réplicas): la invalidación es process-local.
// Si la réplica A escribe, la B sigue su TTL natural — máximo 15s de stale.
// Tradeoff aceptable a este TTL; si se vuelve un problema, mover a Redis
// con pub/sub para invalidación cross-instance.

const { createCachedFetcher } = require('./cacheTtl');
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

const getCajasList = createCachedFetcher('cajas:list', 15_000, async () => {
  const { rows } = await db.query(CAJAS_SQL);
  return rows;
});

module.exports = {
  getCajasList,
  invalidateCajas: () => getCajasList.invalidate(),
};

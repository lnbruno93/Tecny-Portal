// Endpoint del Dashboard de Resumen Mensual.
//
// GET /api/dashboard/resumen-mensual?periodo=YYYY-MM&comparar_con=YYYY-MM
//   - `periodo`     (default: mes actual) — período base a analizar.
//   - `comparar_con` (default: mes anterior) — período base para el delta.
//
// Devuelve { actual, comparado, generado_en } — el front calcula los deltas %
// para que el cálculo sea consistente sin importar el cliente.
//
// Cacheado con TTL 60s por par de períodos (los datos mensuales no cambian
// al segundo; 60s da buen tradeoff de freshness vs costo de queries).
//
// 2026-06-12 P-04 Fase 3.4: cache movido de in-memory local a Redis cross-
// instance. Sin invalidación explícita (los datos mensuales solo cambian al
// crear ventas/movimientos del MES actual, y 60s de stale es invisible para
// el usuario humano del dashboard). La Map `fetchers` local se preserva: el
// wrapper Redis tiene dedup intra-réplica (pending promise) y la Map asegura
// que múltiples requests a la misma key dentro de la misma réplica reusen
// el mismo wrapper (evita crear N closures por minuto).

const router = require('express').Router();
const { createCachedFetcherRedis } = require('../lib/cacheTtl');
const { kpisDelPeriodo, rangoMes, mesAnterior } = require('../lib/dashboardMensual');

// Caché de funciones por par (periodo, comparado). Cada llamada al endpoint
// reusa la misma function-instance si las keys coinciden — el dedup interno
// del cacheTtl evita rerunear queries si llegan N requests concurrentes.
//
// LRU cap: si un cliente (o atacante) envía muchos pares distintos, el Map
// crecería sin límite (cada entry retiene una closure con cache state).
// Acotamos a MAX_FETCHERS — al exceder, evictamos la entry más vieja (MRU
// detrás por reinserción en cada acceso). 100 cubre ~8 años de pares mes
// (12 × 8), suficiente para cualquier uso humano.
const MAX_FETCHERS = 100;
const fetchers = new Map();
function getFetcher(periodoActual, periodoComparado) {
  const key = `${periodoActual}|${periodoComparado}`;
  let fn = fetchers.get(key);
  if (fn) {
    // touch: re-insertar para mover al final (MRU) — Map preserva orden de inserción.
    fetchers.delete(key);
    fetchers.set(key, fn);
    return fn;
  }
  fn = createCachedFetcherRedis(
    `cache:dashboard:resumen:${key}`,
    60_000,
    async () => {
      const { desde: dA, hasta: hA } = rangoMes(periodoActual);
      const { desde: dC, hasta: hC } = rangoMes(periodoComparado);
      const [actual, comparado] = await Promise.all([
        kpisDelPeriodo(dA, hA),
        kpisDelPeriodo(dC, hC),
      ]);
      return { actual, comparado, generado_en: new Date().toISOString() };
    }
  );
  fetchers.set(key, fn);
  // Evict LRU si superamos el cap.
  if (fetchers.size > MAX_FETCHERS) {
    const oldestKey = fetchers.keys().next().value;
    fetchers.delete(oldestKey);
  }
  return fn;
}

// Mes actual en YYYY-MM (UTC para consistencia con el resto del backend).
function mesActual() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

router.get('/resumen-mensual', async (req, res, next) => {
  try {
    const periodoActual    = req.query.periodo      || mesActual();
    const periodoComparado = req.query.comparar_con || mesAnterior(periodoActual);
    // Validación temprana: rangoMes lanza si el formato es inválido.
    rangoMes(periodoActual);
    rangoMes(periodoComparado);
    const data = await getFetcher(periodoActual, periodoComparado)();
    res.json(data);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;

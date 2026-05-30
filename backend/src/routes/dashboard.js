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

const router = require('express').Router();
const { createCachedFetcher } = require('../lib/cacheTtl');
const { kpisDelPeriodo, rangoMes, mesAnterior } = require('../lib/dashboardMensual');

// Caché de funciones por par (periodo, comparado). Cada llamada al endpoint
// reusa la misma function-instance si las keys coinciden — el dedup interno
// del cacheTtl evita rerunear queries si llegan N requests concurrentes.
const fetchers = new Map();
function getFetcher(periodoActual, periodoComparado) {
  const key = `${periodoActual}|${periodoComparado}`;
  if (!fetchers.has(key)) {
    fetchers.set(key, createCachedFetcher(
      `dashboard:resumen:${key}`,
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
    ));
  }
  return fetchers.get(key);
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

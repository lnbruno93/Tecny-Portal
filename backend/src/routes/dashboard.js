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
const db = require('../config/database');
// TANDA 4 refactor (auditoría 2026-06-17 H3-Hyg): pattern Map<scopeKey,
// fetcher> + LRU + factory ahora vive en `createTenantScopedCache`.
const { createTenantScopedCache } = require('../lib/cacheTtl');
const { DASHBOARD_MENSUAL } = require('../lib/cacheConfig');
const { kpisDelPeriodo, rangoMes, mesAnterior } = require('../lib/dashboardMensual');
const { hasCapability } = require('../middleware/requireCapability');

// Caché de funciones por (tenant, periodo, comparado). Cada llamada al endpoint
// reusa la misma function-instance si las keys coinciden — el dedup interno
// del cacheTtl evita rerunear queries si llegan N requests concurrentes.
//
// 2026-06-16 multi-tenant: la key ahora prefija el tenantId. Si dos tenants
// pidieran el mismo par (periodo, comparado), un cache compartido devolvería
// los KPIs del primer tenant a ambos — leak crítico. La cache pasa a ser
// per-tenant; cada tenant tiene su propio Redis key namespace.
//
// LRU cap: si un cliente (o atacante) envía muchos pares distintos, el Map
// crecería sin límite (cada entry retiene una closure con cache state).
// Acotamos a MAX_FETCHERS — al exceder, evictamos la entry más vieja (MRU
// detrás por reinserción en cada acceso). 100 cubre ~8 años de pares mes
// (12 × 8) × N tenants pequeños, suficiente para cualquier uso humano.
// Cache scopeado por `${tenantId}|${periodoActual}|${periodoComparado}`.
// El fetcher recibe la scopeKey, la parsea para extraer los componentes,
// y ejecuta la query bajo withTenant para que RLS filtre por tenant.
const cache = createTenantScopedCache({
  ...DASHBOARD_MENSUAL,
  fetcher: async (scopeKey) => {
    const [tenantStr, periodoActual, periodoComparado] = scopeKey.split('|');
    const tenantId = Number(tenantStr);
    const { desde: dA, hasta: hA } = rangoMes(periodoActual);
    const { desde: dC, hasta: hC } = rangoMes(periodoComparado);
    // 2026-06-16 multi-tenant: ambos kpisDelPeriodo corren en UNA sola tx
    // con app.current_tenant seteado vía withTenant. RLS filtra por tenant
    // todas las tablas (ventas, venta_items, caja_movimientos, etc.).
    const { actual, comparado } = await db.withTenant(tenantId, async (client) => {
      const [actual, comparado] = await Promise.all([
        kpisDelPeriodo(client, dA, hA),
        kpisDelPeriodo(client, dC, hC),
      ]);
      return { actual, comparado };
    });
    return { actual, comparado, generado_en: new Date().toISOString() };
  },
});

// Mes actual en YYYY-MM (UTC para consistencia con el resto del backend).
function mesActual() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 2026-07-04 F5b (ver_ganancias): helper para redactar `ganancia_usd` del
// bundle mensual. El bundle tiene 2 sub-bundles idénticos ({actual, comparado})
// — la ganancia vive en `bundle.ventas.ganancia_usd`. Devolvemos un clon
// shallow: NO mutamos porque `data` viene del cache compartido (per-tenant,
// per par de períodos) y otro request con la cap SÍ debería seguir viendo
// ganancia sin recomputar.
function redactGananciaMensual(bundle) {
  if (!bundle || !bundle.ventas) return bundle;
  const { ganancia_usd, ...ventasRest } = bundle.ventas;
  return { ...bundle, ventas: ventasRest };
}

router.get('/resumen-mensual', async (req, res, next) => {
  try {
    const periodoActual    = req.query.periodo      || mesActual();
    const periodoComparado = req.query.comparar_con || mesAnterior(periodoActual);
    // Validación temprana: rangoMes lanza si el formato es inválido.
    rangoMes(periodoActual);
    rangoMes(periodoComparado);
    const data = await cache.get(`${req.tenantId}|${periodoActual}|${periodoComparado}`);

    // 2026-07-04 F5b (ver_ganancias): sin `ventas.ver_ganancias`, sacamos
    // `ganancia_usd` de los bloques `actual` y `comparado`. El frontend
    // Resumen.jsx ya oculta la KpiCard cuando el valor viene undefined.
    // Owner/admin bypass — hasCapability retorna true.
    const canSeeGanancias = await hasCapability(req.user, 'ventas.ver_ganancias');
    if (!canSeeGanancias) {
      return res.json({
        ...data,
        actual:    redactGananciaMensual(data.actual),
        comparado: redactGananciaMensual(data.comparado),
      });
    }
    res.json(data);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;

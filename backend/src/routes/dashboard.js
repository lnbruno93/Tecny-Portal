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
const { kpisDelPeriodo, rangoMes, mesAnterior, ventasAgregadas, egresosAgregados } = require('../lib/dashboardMensual');
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
// Cache scopeado por `${tenantId}|${periodoActual}|${periodoComparado}|${etiquetaId}|${claseId}`.
// El fetcher recibe la scopeKey, la parsea para extraer los componentes,
// y ejecuta la query bajo withTenant para que RLS filtre por tenant.
//
// 2026-08-05 (task #312): scopeKey extendido con etiquetaId + claseId para
// que combinaciones diferentes de filtros NO compartan cache. '_' = sin
// filtro (más legible que empty string y evita colisión con IDs "").
const cache = createTenantScopedCache({
  ...DASHBOARD_MENSUAL,
  fetcher: async (scopeKey) => {
    const [tenantStr, periodoActual, periodoComparado, etiquetaStr, claseStr] = scopeKey.split('|');
    const tenantId = Number(tenantStr);
    const etiquetaId = etiquetaStr && etiquetaStr !== '_' ? Number(etiquetaStr) : null;
    const claseId    = claseStr    && claseStr    !== '_' ? claseStr : null;
    const opts = { etiquetaId, claseId };
    const { desde: dA, hasta: hA } = rangoMes(periodoActual);
    const { desde: dC, hasta: hC } = rangoMes(periodoComparado);
    // 2026-06-16 multi-tenant: ambos kpisDelPeriodo corren en UNA sola tx
    // con app.current_tenant seteado vía withTenant. RLS filtra por tenant
    // todas las tablas (ventas, venta_items, caja_movimientos, etc.).
    const { actual, comparado } = await db.withTenant(tenantId, async (client) => {
      const [actual, comparado] = await Promise.all([
        kpisDelPeriodo(client, dA, hA, hA, opts),
        kpisDelPeriodo(client, dC, hC, hC, opts),
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
    // task #312: filtros opcionales.
    const etiquetaId = req.query.etiqueta_id ? String(req.query.etiqueta_id) : '_';
    const claseId    = req.query.clase_id    ? String(req.query.clase_id)    : '_';
    // Validación temprana: rangoMes lanza si el formato es inválido.
    rangoMes(periodoActual);
    rangoMes(periodoComparado);
    if (etiquetaId !== '_' && !/^\d+$/.test(etiquetaId)) {
      return res.status(400).json({ error: 'etiqueta_id debe ser un entero positivo' });
    }
    if (claseId !== '_' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claseId)) {
      return res.status(400).json({ error: 'clase_id debe ser un UUID válido' });
    }
    const data = await cache.get(`${req.tenantId}|${periodoActual}|${periodoComparado}|${etiquetaId}|${claseId}`);

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

// 2026-08-05 (task #309): serie mensual liviana para el gráfico A1
// (Facturación vs Egresos vs Ganancia neta últimos N meses).
//
// Query params:
//   - `meses`  (default: 6, max: 24) — cuántos meses hacia atrás incluir.
//   - `hasta`  (default: mes actual) — mes final de la serie (YYYY-MM).
//
// Cache: TTL 5 min per-tenant per-rango. Los meses cerrados no cambian, el
// mes actual cambia poco entre requests dentro de esa ventana.
// Cap de meses (24) es defense-in-depth: sin cap, un cliente podría pedir
// 10000 y hacer 10000 queries. En prod razonable 6-12; UI por ahora usa 6.
const serie6mCache = createTenantScopedCache({
  ...DASHBOARD_MENSUAL,
  ttlSec: 300, // 5 min (serie temporal más estable que KPIs del mes actual)
  fetcher: async (scopeKey) => {
    const [tenantStr, hastaStr, mesesStr, etiquetaStr, claseStr] = scopeKey.split('|');
    const tenantId = Number(tenantStr);
    const meses = Math.min(24, Math.max(1, Number(mesesStr) || 6));
    // task #312: filtros opcionales — '_' = sin filtro.
    const etiquetaId = etiquetaStr && etiquetaStr !== '_' ? Number(etiquetaStr) : null;
    const claseId    = claseStr    && claseStr    !== '_' ? claseStr : null;
    const opts = { etiquetaId, claseId };
    // Compone la lista de meses: [hasta, hasta-1, ..., hasta-(N-1)].
    const listaMeses = [];
    let cursor = hastaStr;
    for (let i = 0; i < meses; i++) {
      listaMeses.unshift(cursor); // insert al principio → orden cronológico ascendente
      cursor = mesAnterior(cursor);
    }
    // Bundle liviano por mes: solo ventas.ventas_usd + ventas.ganancia_usd + egresos.total_usd.
    // NO usamos kpisDelPeriodo (más pesado: 11 helpers) — para 6 meses seríamos
    // 66 queries. Con este approach son 12 (2 × 6).
    //
    // 2026-08-05 (task #312): egresos NO se filtran por etiqueta/categoría
    // (son operativos, no ligados a productos ni tags). Si hay filtros
    // activos, egresos_usd sigue siendo global — el frontend debería
    // mostrar warning "egresos no filtrables" para transparencia.
    const data = await db.withTenant(tenantId, async (client) => {
      return Promise.all(listaMeses.map(async (mes) => {
        const { desde, hasta } = rangoMes(mes);
        const [v, e] = await Promise.all([
          ventasAgregadas(client, desde, hasta, opts),
          egresosAgregados(client, desde, hasta),
        ]);
        const gananciaNeta = Number(v.ganancia_usd || 0) - Number(e.total_usd || 0);
        return {
          mes,
          facturacion_usd: Number(v.ventas_usd || 0),
          egresos_usd:     Number(e.total_usd || 0),
          ganancia_neta_usd: Math.round(gananciaNeta * 100) / 100,
        };
      }));
    });
    return { data, generado_en: new Date().toISOString() };
  },
});

router.get('/serie-6-meses', async (req, res, next) => {
  try {
    const hasta = req.query.hasta || mesActual();
    const meses = req.query.meses || '6';
    // task #312: filtros opcionales.
    const etiquetaId = req.query.etiqueta_id ? String(req.query.etiqueta_id) : '_';
    const claseId    = req.query.clase_id    ? String(req.query.clase_id)    : '_';
    rangoMes(hasta);
    if (!/^\d{1,2}$/.test(String(meses)) || Number(meses) < 1 || Number(meses) > 24) {
      return res.status(400).json({ error: 'meses debe ser entero entre 1 y 24' });
    }
    if (etiquetaId !== '_' && !/^\d+$/.test(etiquetaId)) {
      return res.status(400).json({ error: 'etiqueta_id debe ser un entero positivo' });
    }
    if (claseId !== '_' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claseId)) {
      return res.status(400).json({ error: 'clase_id debe ser un UUID válido' });
    }
    const bundle = await serie6mCache.get(`${req.tenantId}|${hasta}|${meses}|${etiquetaId}|${claseId}`);

    // 2026-08-05 (task #309): mismo criterio que resumen-mensual — sin
    // `ventas.ver_ganancias`, redactamos `ganancia_neta_usd` de cada punto
    // de la serie. El frontend graficará solo facturacion vs egresos.
    const canSeeGanancias = await hasCapability(req.user, 'ventas.ver_ganancias');
    if (!canSeeGanancias) {
      return res.json({
        ...bundle,
        data: bundle.data.map(({ ganancia_neta_usd, ...rest }) => rest),
      });
    }
    res.json(bundle);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;

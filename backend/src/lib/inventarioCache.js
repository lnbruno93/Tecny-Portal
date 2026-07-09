// Caché TTL para GET /api/inventario/productos/metricas.
//
// Este endpoint alimenta los KPIs del dashboard de Inventario y Capital
// (Stock Disponible, Inversión Equipos, Inversión Accesorios, En Técnico).
// La query agrega SUM(costo*cantidad) FILTERed por clase/estado/moneda —
// escala con la tabla `productos` que crece con cada recepción.
//
// Antes (junio 2026) el cache estaba inline en routes/inventario.js sin
// invalidación explícita: TTL natural 20s. Cualquier cambio en productos
// (importación, edición, venta, devolución, etc.) NO invalidaba el cache,
// generando valores stale en el dashboard hasta que expiraba el TTL.
//
// Eso causó confusión sistemática durante testing pre-salida — un operador
// que vaciaba + reimportaba inventario veía el valor ANTERIOR como baseline,
// y al hacer una venta le parecía que faltaba plata cuando en realidad era
// stale data.
//
// Solución: módulo separado + función `invalidateMetricas()` exportada,
// llamada desde TODOS los flows que modifican productos:
//   · POST/PUT/DELETE /productos
//   · POST /productos/bulk (importación)
//   · POST /productos/bulk-delete-disponibles (vaciado masivo)
//   · POST /movimientos (venta B2B / devolución / entrega)
//   · DELETE /movimientos/:id (revertir venta B2B)
//   · POST/PUT/DELETE /ventas (ventas retail descontan/devuelven stock)
//
// 2026-06-12 P-04 Fase 3.3: cache movido de in-memory local a Redis cross-
// instance. Las 9 invalidaciones desde ventas.js / cuentas.js / inventario.js
// propagan a las 2 réplicas Railway en <100ms en lugar del max 20s de TTL
// natural. Elimina el bug de "valor stale post-bulk-import" que confundía
// operadores durante el testing pre-salida.
//
// 2026-06-15 PR 4.9 multi-tenant cleanup: cache ahora es POR TENANT —
// mismo patrón que cajasCache.js. La key Redis incluye tenant_id, hay un
// fetcher memoizado por tenant en `fetchers` (Map), y el fetcher corre la
// query bajo `db.withTenant(tenantId, ...)` para que RLS filtre productos
// del tenant correcto.

// TANDA 4 refactor (auditoría 2026-06-17 H3-Hyg): migrado al patrón
// `createTenantScopedCache`. El Map<tenantId, fetcher> + LRU + factory
// duplicados en 6 archivos del codebase quedan en un solo lugar.
const { createTenantScopedCache } = require('./cacheTtl');
const { INVENTARIO_METRICAS } = require('./cacheConfig');
const db = require('../config/database');
const logger = require('./logger');

// Query idéntica a la del routes/inventario.js original. Mantener sincronizada.
//
// 2026-07-08 Fase 1 categorías reales: `clase` pasó de 2 valores (celular /
// accesorio) a 9 (celular_sellado, celular_usado, watch, auriculares, consolas,
// computadoras, ipads, cargadores, accesorios_varios). Los KPIs de dashboard
// siguen agrupando en 2 buckets para no romper la UI actual:
//   · equipos    = celular_sellado + celular_usado (histórico "celular")
//   · accesorios = todo lo demás (7 slugs restantes)
// Fase 2 rediseñará los KPIs con desglose por categoría real.
//
// 2026-07-09 F3.d-3: la columna `productos.clase` VARCHAR se dropeó — la
// clasificación vive en `clases_producto.slug_legacy` linkeada por FK
// `productos.clase_id`. Migramos las agregaciones a un LEFT JOIN. Productos
// sin clase_id (clase_id IS NULL) caen en el bucket "accesorios" por
// backwards-compat con los que antes tenían clase = 'accesorios_varios'
// implícito. RLS filtra clases_producto por tenant vía JOIN también.
//
// 2026-07-09 Fase 2a KPIs reales: adicionamos `inv_por_clase[]` con el
// desglose granular por categoría (1 fila por clase_id + 1 fila "sin
// categoría" agrupando los productos con clase_id NULL). Los campos legacy
// (inv_equipos_*, inv_accesorios_*, equipos_count, accesorios_count) siguen
// devolviéndose sin cambios — la migración es aditiva. Sunset planeado en
// Fase 2c cuando Inventario.jsx y Capital.jsx consuman inv_por_clase[].
const EQUIPOS_CLASES = "('celular_sellado','celular_usado')";
const METRICAS_SQL = `
  SELECT
    COUNT(*)                          FILTER (WHERE p.estado = 'en_tecnico')                                          AS en_tecnico_count,
    COALESCE(SUM(p.costo)             FILTER (WHERE p.estado = 'en_tecnico' AND p.costo_moneda = 'USD'), 0)           AS en_tecnico_usd,
    COALESCE(SUM(p.costo)             FILTER (WHERE p.estado = 'en_tecnico' AND p.costo_moneda = 'ARS'), 0)           AS en_tecnico_ars,
    COALESCE(SUM(p.cantidad)          FILTER (WHERE p.estado = 'disponible'), 0)                                      AS stock_disponible,
    COALESCE(SUM(p.costo * p.cantidad) FILTER (WHERE cp.slug_legacy IN ${EQUIPOS_CLASES}      AND p.estado = 'disponible' AND p.costo_moneda = 'USD'), 0) AS inv_equipos_usd,
    COALESCE(SUM(p.costo * p.cantidad) FILTER (WHERE cp.slug_legacy IN ${EQUIPOS_CLASES}      AND p.estado = 'disponible' AND p.costo_moneda = 'ARS'), 0) AS inv_equipos_ars,
    COALESCE(SUM(p.cantidad)           FILTER (WHERE cp.slug_legacy IN ${EQUIPOS_CLASES}      AND p.estado = 'disponible'), 0)              AS equipos_count,
    COALESCE(SUM(p.costo * p.cantidad) FILTER (WHERE (cp.slug_legacy IS NULL OR cp.slug_legacy NOT IN ${EQUIPOS_CLASES}) AND p.estado = 'disponible' AND p.costo_moneda = 'USD'), 0) AS inv_accesorios_usd,
    COALESCE(SUM(p.costo * p.cantidad) FILTER (WHERE (cp.slug_legacy IS NULL OR cp.slug_legacy NOT IN ${EQUIPOS_CLASES}) AND p.estado = 'disponible' AND p.costo_moneda = 'ARS'), 0) AS inv_accesorios_ars,
    COALESCE(SUM(p.cantidad)           FILTER (WHERE (cp.slug_legacy IS NULL OR cp.slug_legacy NOT IN ${EQUIPOS_CLASES}) AND p.estado = 'disponible'), 0)              AS accesorios_count
  FROM productos p
  LEFT JOIN clases_producto cp ON cp.id = p.clase_id AND cp.deleted_at IS NULL
  WHERE p.deleted_at IS NULL
`;

// 2026-07-09 Fase 2a: breakdown por categoría real. Una fila por `clase_id`
// del catálogo `clases_producto` del tenant + una fila con `clase_id = NULL`
// para productos sin categoría (fallback histórico).
//
// Notas de diseño:
//   · Solo agrega productos EN estado disponible (mismos criterios que los
//     buckets legacy inv_equipos/inv_accesorios). "En técnico" queda fuera
//     porque no es stock a la venta.
//   · Devuelve la categoría aunque su count sea 0 → la UI puede mostrar la
//     card vacía si el user quiere ver que existe la cat. y no tiene stock.
//     Filtrar 0s es decisión del frontend.
//   · Ordena por USD desc (mayor valorizado primero) + nombre alfabético
//     para desempatar. La UI Opción B mostrará el drawer con este orden.
//   · La fila "sin categoría" (clase_id NULL) siempre va al final, incluso
//     si tiene valorizado > 0. Es un placeholder de higiene, no una cat. real.
//   · Coalesce en TODOS los SUM para que categorías vacías devuelvan 0 en
//     vez de NULL — la UI espera números.
//   · Filtro explícito `tenant_id = $1` en ambas partes (productos +
//     clases_producto). RLS ya filtra en prod (pool NOSUPERUSER), pero en
//     tests locales el pool es SUPERUSER y bypassea RLS — sin este filtro
//     el LEFT JOIN traería clases_producto de TODOS los tenants (miles de
//     filas duplicadas). Defense in depth: nunca confiar solo en RLS.
const INV_POR_CLASE_SQL = `
  WITH agg AS (
    SELECT
      p.clase_id,
      COALESCE(SUM(p.cantidad)                                                            , 0)::int AS count,
      COALESCE(SUM(p.costo * p.cantidad) FILTER (WHERE p.costo_moneda = 'USD')            , 0)      AS usd,
      COALESCE(SUM(p.costo * p.cantidad) FILTER (WHERE p.costo_moneda = 'ARS')            , 0)      AS ars
    FROM productos p
    WHERE p.tenant_id = $1
      AND p.deleted_at IS NULL
      AND p.estado = 'disponible'
    GROUP BY p.clase_id
  )
  SELECT
    cp.id                                 AS clase_id,
    COALESCE(cp.nombre, 'Sin categoría')  AS nombre,
    cp.emoji                              AS emoji,
    COALESCE(cp.orden, 999)               AS orden,
    cp.es_base                            AS es_base,
    cp.es_sin_categoria                   AS es_sin_categoria,
    cp.slug_legacy                        AS slug_legacy,
    COALESCE(a.count, 0)                  AS count,
    COALESCE(a.usd, 0)                    AS usd,
    COALESCE(a.ars, 0)                    AS ars
  FROM clases_producto cp
  LEFT JOIN agg a ON a.clase_id = cp.id
  WHERE cp.tenant_id = $1
    AND cp.deleted_at IS NULL
    AND cp.activa = true
  UNION ALL
  SELECT
    NULL                    AS clase_id,
    'Sin categoría'         AS nombre,
    NULL                    AS emoji,
    999999                  AS orden,       -- siempre al final
    false                   AS es_base,
    true                    AS es_sin_categoria,
    NULL                    AS slug_legacy,
    a.count::int            AS count,
    a.usd                   AS usd,
    a.ars                   AS ars
  FROM agg a
  WHERE a.clase_id IS NULL
    AND (a.count > 0 OR a.usd > 0 OR a.ars > 0)
  ORDER BY orden ASC, usd DESC, nombre ASC
`;

const cache = createTenantScopedCache({
  ...INVENTARIO_METRICAS,
  fetcher: async (tenantId) => {
    const id = Number(tenantId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`fetchMetricas: tenantId inválido (${tenantId})`);
    }
    return db.withTenant(id, async (client) => {
      // 2 queries secuenciales dentro del mismo tenant context (RLS aplica).
      // N de categorías por tenant es chico (10-30 típico) — no hay razón
      // para complicar con CTE combinado. Ambas queries hitean el mismo
      // subset de productos, PG cachea páginas en memoria → costo bajo.
      const { rows: metricasRows }     = await client.query(METRICAS_SQL);
      const { rows: invPorClaseRows }  = await client.query(INV_POR_CLASE_SQL, [id]);
      return {
        ...metricasRows[0],
        // Fase 2a: array nuevo. Los campos legacy siguen presentes arriba.
        // Cast numérico explícito para USD/ARS/count — PG los devuelve como
        // string por el SUM sobre numeric. La UI espera Number.
        inv_por_clase: invPorClaseRows.map(r => ({
          clase_id:         r.clase_id,
          nombre:           r.nombre,
          emoji:            r.emoji,
          es_base:          r.es_base === true,
          es_sin_categoria: r.es_sin_categoria === true,
          slug_legacy:      r.slug_legacy,
          count:            Number(r.count) || 0,
          usd:              Number(r.usd)   || 0,
          ars:              Number(r.ars)   || 0,
        })),
      };
    });
  },
});

// Devuelve las métricas del tenant especificado, cacheadas 20s.
async function fetchMetricas(tenantId) {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`fetchMetricas: tenantId inválido (${tenantId})`);
  }
  return cache.get(tenantId);
}

// Invalida el cache de un tenant. Async, fire-and-forget en callers.
// Sin tenantId → no-op + warning (admin scripts sin contexto multi-tenant).
async function invalidateMetricas(tenantId) {
  if (tenantId == null) {
    logger.warn('invalidateMetricas() sin tenantId — no-op. Path probable: script admin sin contexto multi-tenant.');
    return;
  }
  return cache.invalidate(tenantId);
}

module.exports = {
  fetchMetricas,
  invalidateMetricas,
};

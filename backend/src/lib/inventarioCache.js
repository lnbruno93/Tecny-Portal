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
const METRICAS_SQL = `
  SELECT
    COUNT(*)                          FILTER (WHERE estado = 'en_tecnico')                                          AS en_tecnico_count,
    COALESCE(SUM(costo)               FILTER (WHERE estado = 'en_tecnico' AND costo_moneda = 'USD'), 0)             AS en_tecnico_usd,
    COALESCE(SUM(costo)               FILTER (WHERE estado = 'en_tecnico' AND costo_moneda = 'ARS'), 0)             AS en_tecnico_ars,
    COALESCE(SUM(cantidad)            FILTER (WHERE estado = 'disponible'), 0)                                      AS stock_disponible,
    COALESCE(SUM(costo * cantidad)    FILTER (WHERE clase = 'celular'   AND estado = 'disponible' AND costo_moneda = 'USD'), 0) AS inv_equipos_usd,
    COALESCE(SUM(costo * cantidad)    FILTER (WHERE clase = 'celular'   AND estado = 'disponible' AND costo_moneda = 'ARS'), 0) AS inv_equipos_ars,
    COALESCE(SUM(cantidad)            FILTER (WHERE clase = 'celular'   AND estado = 'disponible'), 0)              AS equipos_count,
    COALESCE(SUM(costo * cantidad)    FILTER (WHERE clase = 'accesorio' AND estado = 'disponible' AND costo_moneda = 'USD'), 0) AS inv_accesorios_usd,
    COALESCE(SUM(costo * cantidad)    FILTER (WHERE clase = 'accesorio' AND estado = 'disponible' AND costo_moneda = 'ARS'), 0) AS inv_accesorios_ars,
    COALESCE(SUM(cantidad)            FILTER (WHERE clase = 'accesorio' AND estado = 'disponible'), 0)              AS accesorios_count
  FROM productos
  WHERE deleted_at IS NULL
`;

const cache = createTenantScopedCache({
  ...INVENTARIO_METRICAS,
  fetcher: async (tenantId) => {
    const id = Number(tenantId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`fetchMetricas: tenantId inválido (${tenantId})`);
    }
    return db.withTenant(id, async (client) => {
      const { rows } = await client.query(METRICAS_SQL);
      return rows[0];
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

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
// Multi-instance (Railway 2 réplicas): la invalidación es process-local.
// Si la réplica A escribe, la B sigue su TTL natural — máximo 20s de stale.
// Tradeoff aceptable; si se vuelve un problema, mover a Redis con pub/sub.

const { createCachedFetcher } = require('./cacheTtl');
const db = require('../config/database');

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

const fetchMetricas = createCachedFetcher('inv:metricas', 20_000, async () => {
  const { rows } = await db.query(METRICAS_SQL);
  return rows[0];
});

module.exports = {
  fetchMetricas,
  invalidateMetricas: () => fetchMetricas.invalidate(),
};

// Configuración central de TODOS los caches Redis del backend.
//
// TANDA 4 refactor H4-Hyg auditoría 2026-06-17.
//
// Antes los TTLs y maxFetchers estaban hardcoded en 6 archivos distintos
// (userAuthCache.js, cajasCache.js, inventarioCache.js, routes/dashboard.js,
// routes/ventas.js). Tunear cualquiera implicaba grep + edit en N lugares.
// Acá viven todos en un solo lugar con comentario sobre cada decisión.
//
// Para usar: importar el config y pasarlo a `createTenantScopedCache`:
//
//   const { USER_AUTH } = require('./cacheConfig');
//   const cache = createTenantScopedCache({ ...USER_AUTH, fetcher: ... });
//
// Decisiones de TTL:
//   - Cortos (15-30s): datos que cambian con writes frecuentes (cajas, inv,
//     ventas dashboard) — costo de stale window es UX percibida.
//   - Largos (60s): datos que cambian con baja frecuencia (auth meta del user,
//     dashboard mensual) — el stale window es invisible al user típico.
//
// Decisiones de maxFetchers:
//   - 256: tenants concurrentes activos esperables (caches per-tenant).
//   - 1024: users concurrentes (caches per-user — más cardinalidad).
//   - 100: keys compuestas (tenant × período) con muchas combinaciones
//     posibles pero pocas activas a la vez.
//
// Si crecemos más allá de estos números, considerar LRU library real
// (lru-cache) en lugar del Map manual.

module.exports = {
  // requireAuth meta del user — password_changed_at + email_verified_at.
  // Cache de mayor frecuencia (cada request autenticado).
  USER_AUTH: {
    keyPrefix: 'cache:user_auth:u',
    ttlMs: 60_000,
    maxFetchers: 1024,
  },

  // Lista de cajas con saldos (LEFT JOIN + GROUP BY sobre caja_movimientos).
  // TTL corto (15s) porque las cajas se ven en dropdowns que el operador
  // espera ver actualizados rápido post-movimiento.
  CAJAS_LIST: {
    keyPrefix: 'cache:cajas:list:t',
    ttlMs: 15_000,
    maxFetchers: 256,
  },

  // Métricas dashboard inventario (SUM por categorías).
  INVENTARIO_METRICAS: {
    keyPrefix: 'cache:inv:metricas:t',
    ttlMs: 20_000,
    maxFetchers: 256,
  },

  // Dashboard mensual (kpisDelPeriodo × 2 con `Promise.all`).
  // Key compuesta: `${tenantId}|${periodoActual}|${periodoComparado}`.
  DASHBOARD_MENSUAL: {
    keyPrefix: 'cache:dashboard:resumen:',
    ttlMs: 60_000,
    maxFetchers: 100,
  },

  // Dashboard ventas (KPIs por rango fechas).
  // Key compuesta: `${tenantId}|${desde}|${hasta}`.
  DASHBOARD_VENTAS: {
    keyPrefix: 'cache:ventas:dashboard:',
    ttlMs: 30_000,
    maxFetchers: 100,
  },

  // Resumen Inversiones + Deudas para Cajas (2 queries paralelas).
  // Sin invalidación explícita — TTL-based recovery (mismo semantics que
  // pre-refactor cuando era createCachedFetcher local). Si en el futuro
  // queremos freshness inmediata post-write de inversiones/deudas, agregar
  // invalidate desde routes/proveedores.js + routes/inversiones.js.
  CAJAS_RESUMEN: {
    keyPrefix: 'cache:cajas:resumen:t',
    ttlMs: 20_000,
    maxFetchers: 256,
  },
};

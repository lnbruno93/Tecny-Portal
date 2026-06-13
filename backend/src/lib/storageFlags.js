'use strict';

// storageFlags — wrappers para los feature flags `storage_r2_*` que controlan
// el rollout entity-by-entity del migration a Cloudflare R2 (P-03).
//
// Patrón idéntico al de audit.isAsyncEnabled() (P-07): lee el flag desde la
// tabla `feature_flags`, cachea con Redis TTL 60s para evitar query DB en
// cada upload, y expone una función de invalidación que se llama desde el
// PATCH de feature-flags.js.
//
// Decisión: un módulo por flag-set (no un genérico) porque cada uno tiene su
// propia invalidación, su propio test bypass, y porque hay solo 3. Si en el
// futuro el set crece a 10+, vale la pena un wrapper genérico — por ahora,
// duplicar las 3 funciones es más legible que abstraer.
//
// Test bypass: NODE_ENV=test no toca DB ni Redis. Devuelve el valor del
// override (default false) — los tests pueden setear `_setEnabledForTest`
// para forzar ON. Mismo patrón que audit.js.
//
// Fail-safe: si la tabla feature_flags no existe (DB pre-M-08) o la query
// falla por cualquier motivo, devolvemos `false` (= R2 OFF) — es el path
// más conservador. Sin esto, una falla transitoria de DB durante un upload
// podría hacer fallar el endpoint entero.

const db = require('../config/database');
const logger = require('./logger');
const { createCachedFetcherRedis } = require('./cacheTtl');

const FLAG_TTL_MS = 60_000;

// Lista de flags soportados. Si agregás uno nuevo, sumalo acá.
const FLAGS = [
  'storage_r2_comprobantes',
  'storage_r2_productos',
  'storage_r2_ventas_comprobantes',
];

// Test overrides — uno por flag. Default false (R2 OFF en tests, mismo que
// el path de producción al deploy).
const _testOverrides = Object.fromEntries(FLAGS.map(f => [f, false]));

// Generic fetcher — leer cualquier flag por nombre, fail-safe.
async function _fetchFlagFromDb(flagName) {
  try {
    const { rows } = await db.query(
      'SELECT enabled FROM feature_flags WHERE name = $1',
      [flagName],
    );
    return rows[0]?.enabled === true;
  } catch (err) {
    // Tabla feature_flags no existe, flag no existe, conexión rota:
    // fail-safe a OFF (no escalamos a R2). NO propagamos el error.
    logger.warn(
      { err: err?.message, flag: flagName },
      'storageFlags: lectura de flag falló, fallback a OFF',
    );
    return false;
  }
}

// Un fetcher cacheado por flag. La key de Redis es por flag-name → invalidar
// `storage_r2_comprobantes` no invalida los otros (rollout independiente).
const _fetchers = {};
for (const flag of FLAGS) {
  _fetchers[flag] = createCachedFetcherRedis(
    `cache:flag:${flag}`,
    FLAG_TTL_MS,
    () => _fetchFlagFromDb(flag),
  );
}

// API pública.
//
// Devuelve true si el flag está ON. En tests, devuelve el override.
async function isEnabled(flagName) {
  if (!FLAGS.includes(flagName)) {
    throw new Error(`storageFlags: flag desconocido '${flagName}'`);
  }
  if (process.env.NODE_ENV === 'test') return _testOverrides[flagName] === true;
  return _fetchers[flagName]();
}

// Invalida el cache de un flag específico. Async — el caller puede await si
// quiere garantía de invalidación pre-response, o fire-and-forget para
// latencia mínima. Llamado desde el PATCH de feature-flags.js cuando un
// admin cambia un flag storage_r2_*.
async function invalidate(flagName) {
  if (!FLAGS.includes(flagName)) return;
  return _fetchers[flagName].invalidate();
}

// Test helpers — los tests integration de comprobantes/productos/ventas
// llaman `_setEnabledForTest('storage_r2_comprobantes', true)` para forzar
// el path R2 sin tocar la tabla feature_flags.
function _setEnabledForTest(flagName, value) {
  if (!FLAGS.includes(flagName)) {
    throw new Error(`storageFlags: flag desconocido '${flagName}'`);
  }
  _testOverrides[flagName] = value === true;
}

function _resetTestOverrides() {
  for (const flag of FLAGS) _testOverrides[flag] = false;
}

module.exports = {
  isEnabled,
  invalidate,
  FLAGS,
  _setEnabledForTest,
  _resetTestOverrides,
};

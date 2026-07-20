'use strict';

// storageFlags — wrappers para los feature flags `storage_r2_*` que controlan
// el rollout entity-by-entity del migration a Cloudflare R2 (P-03).
//
// 2026-07-20 F3 Rec proactiva #3: migrados al resolver de F1 (isFeatureEnabled)
// para respetar overrides tenant/plan/rollout. Antes: solo binario global —
// no había forma de activar R2 para un cliente específico como canary.
// Después: se puede activar R2 en Tek Haus antes de rollout global sin tocar
// el resto de tenants.
//
// La interfaz externa se mantiene:
//   · `isEnabled(flagName, tenantId?)` — tenantId opcional para backward
//     compat de los call sites viejos. Los routes nuevos deben pasarlo.
//   · `invalidate(flagName)` — delega al invalidador de F1 (global).
//   · `FLAGS` — const array de flag names.
//   · `_setEnabledForTest` / `_resetTestOverrides` — bypass NODE_ENV=test.
//
// Test bypass: preservado (short-circuit ANTES del resolver). Sin él, cada
// upload en test hace lookup DB/Redis → tests de comprobantes/productos/
// ventas caerían por saturación del pool.
//
// Fail-safe: `isFeatureEnabled` es fail-closed (false en error). Path R2
// OFF = fallback a `archivo_data` legacy — comportamiento pre-P-03. Sin
// regresión posible.

const featureFlagsLib = require('./featureFlags');

// Lista de flags soportados. Si agregás uno nuevo, sumalo acá — pero también
// insertalo en `feature_flags` via migración (los flags nuevos empiezan
// desconocidos para el resolver, que fail-closed a false).
const FLAGS = [
  'storage_r2_comprobantes',
  'storage_r2_productos',
  'storage_r2_ventas_comprobantes',
];

// Test overrides — uno por flag. Default false (R2 OFF en tests, mismo que
// el path de producción al deploy).
const _testOverrides = Object.fromEntries(FLAGS.map(f => [f, false]));

// API pública.
//
// Devuelve true si el flag está ON para el tenant dado (respetando
// overrides tenant/plan/rollout). En tests, devuelve el override sin
// consultar DB/Redis.
//
// `tenantId` es opcional para backward compat: si el caller no lo pasa,
// el resolver evalúa solo el default global (sin overrides tenant/plan/
// rollout). Los routes nuevos deben pasar `req.tenantId` para aprovechar
// la precedencia completa.
async function isEnabled(flagName, tenantId = null) {
  if (!FLAGS.includes(flagName)) {
    throw new Error(`storageFlags: flag desconocido '${flagName}'`);
  }
  if (process.env.NODE_ENV === 'test') return _testOverrides[flagName] === true;
  return featureFlagsLib.isFeatureEnabled(flagName, tenantId);
}

// Invalida el cache del flag. Delega al invalidador de F1 con `tenantId=null`
// — invalida el key global (`ff:<flag>:null`). Los cambios per-tenant (F2)
// hacen su propia invalidación con `invalidateFeatureCache(name, tenantId)`
// desde el endpoint admin. Este handler cubre el path viejo
// (routes/feature-flags.js PATCH) que no conoce tenants.
//
// Devuelve Promise para preservar la interfaz async previa.
async function invalidate(flagName) {
  if (!FLAGS.includes(flagName)) return;
  return featureFlagsLib.invalidateFeatureCache(flagName, null);
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

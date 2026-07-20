// featureFlags.js — resolver de feature flags con precedencia tenant > plan > rollout > global.
//
// F1 del Rec proactiva #3 post-audit 2026-07-20.
// Design doc: docs/design/feature-flags-per-tenant.md
//
// ── API ────────────────────────────────────────────────────────────────
//
//   await isFeatureEnabled(flagName, tenantId, opts?)
//     → boolean
//
//   opts = { skipCache: false }
//
// ── Precedencia ────────────────────────────────────────────────────────
//
// Para cada `(flagName, tenantId)`:
//   1. tenant override      (feature_flags_tenants) — el más específico
//   2. plan override        (feature_flags_plans, matchea tenants.plan)
//   3. rollout %            (feature_flags.rollout_pct + hash tenant_id)
//   4. default global       (feature_flags.enabled)
//   5. fail-closed → false  (flag no existe, DB inaccesible, etc.)
//
// El primer match gana. Ejemplos:
//   · Flag global OFF pero override tenant=42 ON  → 42 tiene la feature.
//   · Flag global ON pero override tenant=42 OFF → 42 NO tiene (kill switch).
//   · Rollout 30% + override plan 'pro' ON       → todos los `pro` ON,
//                                                    los demás por rollout.
//
// ── Cache ──────────────────────────────────────────────────────────────
//
// Key: `ff:{flagName}:{tenantId}`, TTL 300s (5min).
// Sin pub-sub por ahora — para kill switch de emergencia:
//   · Bajar TTL a 30s temporarily.
//   · O llamar `invalidateFeatureCache(flag, tenantId?)` desde el endpoint
//     que setea el override (F2).
//
// ── Hash determinístico ────────────────────────────────────────────────
//
// bucketFor(flagName, tenantId) = sha256(`${flagName}:${tenantId}`) % 100
//
// Propiedades:
//   · Determinístico: mismo input → mismo bucket para siempre.
//   · Distribución uniforme sobre >1000 tenants (test lo verifica).
//   · Independiente por flag: un tenant puede estar en el 30% del flag A y
//     no en el 30% del flag B. Evita que "los mismos tenants tempranos"
//     acumulen todas las features canary.
//
// ── Fail-safe ──────────────────────────────────────────────────────────
//
// Errores de DB (timeout, tabla no existe) → return false + log.warn.
// Nunca throw: un flag no debería tirar 500 al usuario. La feature queda
// OFF por defecto (fail-closed) para no exponer código no validado.
//
// Errores de Redis → cache miss, procede con DB (redisClient.get devuelve
// null en error). Log ya lo hace redisClient con rate-limit.

const crypto = require('crypto');
const db = require('../config/database');
const redisClient = require('./redisClient');
const logger = require('./logger');

// Cache TTL — 5 min es OK para no-canaries. Para kill switch bajar a 30s.
// Configurable via env var por si necesitamos ajuste sin redeploy en un
// incident (ej. subir a 3600 para reducir carga DB en outage temporal).
const CACHE_TTL_SEC = parseInt(process.env.FEATURE_FLAGS_TTL_SEC, 10) || 300;

// Prefijo del cache key. Cambiarlo invalida TODO el cache — útil como
// nuclear option post-incident.
const CACHE_PREFIX = 'ff:';

// ── Hash bucketing ─────────────────────────────────────────────────────

/**
 * Bucket 0-99 determinístico para (flagName, tenantId). Usado para rollout %.
 *
 * Propiedades:
 *   · Mismo input → mismo bucket siempre (idempotente).
 *   · Distribución uniforme sobre >1000 tenants (~1% por bucket).
 *   · Independiente por flag: bucketFor('flagA', 1) != bucketFor('flagB', 1).
 *
 * Uso: `bucketFor(flag, tenant) < rollout_pct` → enabled.
 *
 * SHA-256 vs md5: SHA es slightly slower pero indistinguible en este uso
 * (Node native crypto, ~1μs por llamada). Preferimos SHA por higiene.
 *
 * @param {string} flagName
 * @param {number} tenantId
 * @returns {number} 0..99
 */
function bucketFor(flagName, tenantId) {
  const input = `${flagName}:${tenantId}`;
  const hash = crypto.createHash('sha256').update(input).digest();
  // Tomamos los primeros 4 bytes → 32-bit unsigned int → mod 100.
  // No usamos toString('hex') + parseInt porque `readUInt32BE` es más rápido
  // (evita conversión a string).
  return hash.readUInt32BE(0) % 100;
}

// ── Cache helpers ──────────────────────────────────────────────────────

function cacheKey(flagName, tenantId) {
  return `${CACHE_PREFIX}${flagName}:${tenantId}`;
}

async function getCached(flagName, tenantId) {
  try {
    const val = await redisClient.get(cacheKey(flagName, tenantId));
    if (val === null || val === undefined) return null;
    return val === '1';
  } catch {
    return null;
  }
}

async function setCached(flagName, tenantId, enabled) {
  try {
    await redisClient.setEx(cacheKey(flagName, tenantId), CACHE_TTL_SEC, enabled ? '1' : '0');
  } catch {
    /* fallback silencioso — cache miss no rompe el resolver */
  }
}

/**
 * Invalida el cache de un flag para un tenant específico, o todos los tenants
 * si `tenantId` es undefined. Útil desde los endpoints de F2 cuando cambian
 * un override o desde runbooks de kill switch.
 *
 * NOTA: la variante "todos los tenants" (SCAN + DEL) es cara en Redis grandes
 * y NO se implementa acá por ahora. Sin pub-sub cross-instance, el kill
 * switch efectivo requiere:
 *   1. Cambiar el override en DB
 *   2. Esperar TTL (max 5 min) O
 *   3. Restart de todos los pods (Railway lo puede hacer con "redeploy").
 *
 * @param {string} flagName
 * @param {number} tenantId
 */
async function invalidateFeatureCache(flagName, tenantId) {
  try {
    await redisClient.del(cacheKey(flagName, tenantId));
  } catch {
    /* Redis down, el cache se auto-expira por TTL */
  }
}

// ── Resolver principal ─────────────────────────────────────────────────

/**
 * Resuelve si una feature está habilitada para un tenant específico,
 * aplicando la precedencia definida arriba.
 *
 * @param {string} flagName - snake_case (matchea feature_flags.name).
 * @param {number|null} tenantId - null → solo evalúa el default global.
 * @param {object} [opts]
 * @param {boolean} [opts.skipCache=false] - true → siempre lee DB, no cachea.
 * @returns {Promise<boolean>}
 */
async function isFeatureEnabled(flagName, tenantId, opts = {}) {
  const skipCache = opts.skipCache === true;

  // Validación defensiva — un flag sin nombre nunca debería llegar acá,
  // pero fail-safe: return false.
  if (typeof flagName !== 'string' || flagName.length === 0) {
    return false;
  }

  // tenantId null → sin resolver por tenant, ir directo al global.
  // Uso raro (endpoints públicos que aún así consultan flags), pero cubierto.
  if (tenantId == null) {
    return _resolveGlobal(flagName);
  }

  // Cache hit rápido — evita ~4 queries si el flag es "caliente".
  if (!skipCache) {
    const cached = await getCached(flagName, tenantId);
    if (cached !== null) return cached;
  }

  // Cache miss o skipCache → resolver full desde DB.
  const resolved = await _resolveFromDb(flagName, tenantId);

  if (!skipCache) {
    // Fire-and-forget — no bloqueamos la respuesta esperando el set.
    setCached(flagName, tenantId, resolved).catch(() => {});
  }

  return resolved;
}

/**
 * Resuelve la precedencia contra DB (sin cache).
 * @private
 */
async function _resolveFromDb(flagName, tenantId) {
  try {
    // 1. Tenant override — el más específico. Si existe, gana.
    // Usar db.adminQuery porque feature_flags no es tenant-scoped en RLS
    // (es config global) y evitamos setup de `withTenant` para lookup rápido.
    const tenantOverride = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT enabled FROM feature_flags_tenants
          WHERE flag_name = $1 AND tenant_id = $2`,
        [flagName, tenantId]
      );
      return rows[0]?.enabled;
    });
    if (tenantOverride !== undefined) return tenantOverride;

    // 2. Plan override — segundo lugar. Necesita conocer el plan del tenant.
    // Query combinada: JOIN tenants → feature_flags_plans en un roundtrip.
    // Devuelve enabled si hay match, undefined si el tenant no tiene plan
    // o el plan no tiene override para este flag.
    const planOverride = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT ffp.enabled
           FROM tenants t
           JOIN feature_flags_plans ffp
             ON ffp.plan_id = t.plan AND ffp.flag_name = $1
          WHERE t.id = $2`,
        [flagName, tenantId]
      );
      return rows[0]?.enabled;
    });
    if (planOverride !== undefined) return planOverride;

    // 3. Rollout % + 4. Global default — combinamos en 1 query.
    // Si rollout_pct es NULL, usar enabled (default global).
    // Si rollout_pct está seteado, calcular bucket y comparar.
    const flag = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT enabled, rollout_pct FROM feature_flags WHERE name = $1`,
        [flagName]
      );
      return rows[0];
    });

    if (!flag) {
      // Flag no existe en la tabla → fail-closed. Distinto de un flag que
      // existe con enabled=false, semánticamente ("desconocemos" vs "off").
      // Ambos casos devuelven false; el log distingue por causa.
      logger.warn({ flagName }, '[featureFlags] flag no existe en DB, fail-closed');
      return false;
    }

    // 3. Rollout %: si rollout_pct está seteado, ignoramos `enabled` global
    // y solo miramos el bucket.
    if (flag.rollout_pct !== null && flag.rollout_pct !== undefined) {
      return bucketFor(flagName, tenantId) < flag.rollout_pct;
    }

    // 4. Default global — sin overrides, sin rollout.
    return flag.enabled === true;
  } catch (err) {
    // DB error → fail-closed. Log para investigar; nunca throw al caller.
    logger.warn(
      { err: err.message, flagName, tenantId },
      '[featureFlags] error resolviendo flag, fail-closed'
    );
    return false;
  }
}

/**
 * Resuelve solo el default global (usado cuando tenantId es null).
 * Sin cache — cases raros que no valen la penalidad de mantener otro key.
 * @private
 */
async function _resolveGlobal(flagName) {
  try {
    const enabled = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT enabled FROM feature_flags WHERE name = $1`,
        [flagName]
      );
      return rows[0]?.enabled;
    });
    return enabled === true;
  } catch (err) {
    logger.warn(
      { err: err.message, flagName },
      '[featureFlags] error resolviendo global, fail-closed'
    );
    return false;
  }
}

module.exports = {
  isFeatureEnabled,
  invalidateFeatureCache,
  // Exportados para tests + para caller que necesite el hash puro (ej.
  // preview en admin: "¿este tenant caería en el 30%?").
  bucketFor,
};

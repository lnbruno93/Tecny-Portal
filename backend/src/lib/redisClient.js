// Redis client singleton para iPro.
//
// Diseño: ver docs/design/p04-redis-caching.md.
//
// Comportamiento:
//   · Lazy init: el client no se conecta hasta el primer get/set/del.
//     Sin REDIS_URL configurada, todas las operaciones devuelven null/false
//     SIN error (fallback graceful — el caller decide qué hacer con cache miss).
//   · Timeout 500ms en cada operación: si Redis lagueado, no bloquea el
//     request por más de 0.5s; falla a null y el caller fetchea directo.
//   · Connection retry exponencial (manejado por ioredis): si Redis cae,
//     intenta reconectar en background sin tirar errores al caller.
//   · Sentry integration: errores de conexión se reportan UNA vez por minuto
//     (rate-limited) para no spammear en outages prolongados.
//
// API:
//   · get(key) → string | null. null si miss, error, timeout, o REDIS_URL no
//     configurada.
//   · setEx(key, ttlSec, value) → boolean. true si guardado, false si error.
//   · del(key) → boolean. true si invalidación corrida (no garantiza que
//     existía).
//   · ping() → boolean. true si Redis respondió en 500ms. Para /health/redis.
//   · isEnabled() → boolean. true si REDIS_URL está set Y el último ping
//     fue exitoso. Útil para que el caller decida usar redis o local cache.
//
// En NODE_ENV=test el client NO se conecta — todas las operaciones devuelven
// null/false. Los tests que necesitan Redis real lo levantan con un mock o
// con una instancia local.

const Redis = require('ioredis');
const logger = require('./logger');

// ──────────────────────── Config ────────────────────────
const REDIS_URL = process.env.REDIS_URL || null;
const ENABLED = REDIS_URL !== null && process.env.NODE_ENV !== 'test';
const OPERATION_TIMEOUT_MS = 500;
const PING_TIMEOUT_MS = 1000;

// Sentry rate limit: máximo 1 error report por minuto.
let _lastSentryReport = 0;
const SENTRY_REPORT_INTERVAL_MS = 60_000;

function _reportToSentry(err, context) {
  const now = Date.now();
  if (now - _lastSentryReport < SENTRY_REPORT_INTERVAL_MS) return;
  _lastSentryReport = now;
  try {
    const Sentry = require('@sentry/node');
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(err, { tags: { component: 'redis', ...context } });
    }
  } catch { /* Sentry no disponible — no propagar */ }
}

// ──────────────────────── Lazy singleton ────────────────────────
let _client = null;
let _connecting = false;
let _connected = false;
// _testOverride: true cuando los tests inyectaron un mock via _setClientForTest.
// Permite que isEnabled()/get()/etc. operen sobre el mock aunque ENABLED sea
// false por NODE_ENV=test. No-op en producción (los tests son los únicos que
// llaman _setClientForTest).
let _testOverride = false;

function _getClient() {
  if (_testOverride) return _client; // mock inyectado por tests — tiene prioridad
  if (!ENABLED) return null;
  if (_client) return _client;
  if (_connecting) return _client; // race-safe, ioredis ya está conectando

  _connecting = true;
  _client = new Redis(REDIS_URL, {
    // Reintento exponencial: 50ms → 100ms → 200ms ... max 2s.
    retryStrategy: (times) => Math.min(50 * Math.pow(2, times), 2000),
    // Máximo 10 reintentos por minuto. Después de eso, marca como down y deja
    // que la siguiente operación dispare reconnect.
    maxRetriesPerRequest: 3,
    // Si no podemos conectar en el primer intento, no bloqueamos el proceso.
    lazyConnect: false,
    // Connection timeout — Redis no responde en 5s = timeout.
    connectTimeout: 5_000,
    // Comando-level timeout en cada operación. Caller usa Promise.race
    // para timeout más agresivo (500ms), pero esto es el techo absoluto.
    commandTimeout: 2_000,
  });

  _client.on('connect', () => {
    _connected = true;
    logger.info('redis: connected');
  });
  _client.on('error', (err) => {
    _connected = false;
    logger.warn({ err: err.message }, 'redis: connection error');
    _reportToSentry(err, { phase: 'connection' });
  });
  _client.on('close', () => {
    _connected = false;
    logger.warn('redis: connection closed');
  });

  return _client;
}

// ──────────────────────── Operation wrapper con timeout ────────────────────────
//
// Race entre la operación real y un timeout. Si el timeout gana, devolvemos
// fallback SIN bloquear (la promise real sigue en background y se resuelve sola).
async function _withTimeout(promise, timeoutMs, fallback) {
  return Promise.race([
    promise.catch((err) => {
      logger.debug({ err: err.message }, 'redis: operation error');
      return fallback;
    }),
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

// ──────────────────────── Public API ────────────────────────

/**
 * Get a value from Redis.
 * @param {string} key
 * @returns {Promise<string|null>} null si miss, error, timeout, o no enabled.
 */
async function get(key) {
  const client = _getClient();
  if (!client) return null;
  return _withTimeout(client.get(key), OPERATION_TIMEOUT_MS, null);
}

/**
 * Set a value with TTL (seconds).
 * @param {string} key
 * @param {number} ttlSec
 * @param {string} value (JSON.stringify si es objeto — el caller decide formato)
 * @returns {Promise<boolean>} true si guardado, false si error/timeout/disabled.
 */
async function setEx(key, ttlSec, value) {
  const client = _getClient();
  if (!client) return false;
  const result = await _withTimeout(
    client.setex(key, ttlSec, value),
    OPERATION_TIMEOUT_MS,
    null
  );
  return result === 'OK';
}

/**
 * Delete a key (invalidación).
 * @param {string} key
 * @returns {Promise<boolean>} true si la operación corrió (no implica que existía).
 */
async function del(key) {
  const client = _getClient();
  if (!client) return false;
  const result = await _withTimeout(client.del(key), OPERATION_TIMEOUT_MS, null);
  return result !== null;
}

/**
 * Delete by pattern (e.g., "cache:cajas:*"). Usa SCAN para evitar bloquear
 * Redis con KEYS en datasets grandes. Devuelve la cantidad de keys borradas.
 * @param {string} pattern
 * @returns {Promise<number>}
 */
async function delPattern(pattern) {
  const client = _getClient();
  if (!client) return 0;
  let deleted = 0;
  try {
    const stream = client.scanStream({ match: pattern, count: 100 });
    await new Promise((resolve, reject) => {
      stream.on('data', async (keys) => {
        if (keys.length === 0) return;
        try {
          const result = await client.del(...keys);
          deleted += result;
        } catch (err) {
          logger.warn({ err: err.message, pattern }, 'redis: delPattern batch error');
        }
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  } catch (err) {
    logger.warn({ err: err.message, pattern }, 'redis: delPattern failed');
  }
  return deleted;
}

/**
 * Health check ping. Para /health/redis.
 * @returns {Promise<boolean>} true si responde en 1s, false si no.
 */
async function ping() {
  const client = _getClient();
  if (!client) return false;
  const result = await _withTimeout(client.ping(), PING_TIMEOUT_MS, null);
  return result === 'PONG';
}

/**
 * @returns {boolean} true si Redis está configurado (REDIS_URL set, no test env)
 *   o si los tests inyectaron un mock.
 */
function isEnabled() {
  return ENABLED || _testOverride;
}

/**
 * @returns {boolean} true si el último evento fue connect (best-effort).
 *   No hace ping — usar ping() para verificación activa.
 */
function isConnected() {
  return _connected;
}

/**
 * Cierra la conexión (para graceful shutdown).
 */
async function disconnect() {
  if (!_client) return;
  try {
    await _client.quit();
  } catch (err) {
    logger.warn({ err: err.message }, 'redis: quit error');
  }
  _client = null;
  _connected = false;
  _connecting = false;
}

// ──────────────────────── Test helpers ────────────────────────
//
// _setClientForTest(mock) — reemplaza el singleton con un mock. Usado por
// los tests para inyectar comportamiento sin necesidad de un Redis real.
// El mock debe implementar get/setex/del/ping/scanStream.
function _setClientForTest(mock) {
  _client = mock;
  _testOverride = mock !== null;
  _connected = mock !== null;
}

module.exports = {
  get,
  setEx,
  del,
  delPattern,
  ping,
  isEnabled,
  isConnected,
  disconnect,
  _setClientForTest,
};

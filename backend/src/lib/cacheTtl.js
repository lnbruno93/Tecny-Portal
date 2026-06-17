// Caché in-memory con TTL para queries de lectura caras + opcional Redis
// cross-instance.
//
// Diseño general: ver docs/design/p04-redis-caching.md.
//
// Hay 2 wrappers públicos:
//   · createCachedFetcher(key, ttlMs, fetcher) — cache LOCAL (in-memory).
//     Compatible 100% con la API original. No cambia comportamiento.
//   · createCachedFetcherRedis(key, ttlMs, fetcher) — cache compartido en
//     Redis. Mismo API; invalidación cross-instance vía redisClient.del().
//     Si Redis no responde, fallback a fetch directo (sin cachear) —
//     preserva consistency a costo de throughput.
//
// El caller elige cuál usar al crear el fetcher. La migración progresiva
// (P-04 Fase 3) cambia call-sites de createCachedFetcher → createCachedFetcherRedis
// por feature flag.
//
// Concurrencia (ambos wrappers): si llegan N requests al mismo tiempo con
// el cache expirado, se hace UNA sola fetch y todos esperan (deduplicación
// via promise pending). Patrón "single-flight" estándar.
//
// El fetcher devuelto expone `.invalidate()` para forzar refresh post-write
// dentro del mismo proceso (local) o cross-instance (Redis).

const redis = require('./redisClient');
const logger = require('./logger');

// ────────────────────────────────────────────────────────────────
// createCachedFetcher — versión local (in-memory)
// ────────────────────────────────────────────────────────────────
//
// Sin cambios respecto a la implementación pre-P-04. Sigue siendo el path
// por default hasta que migremos cada call-site a Redis.
function createCachedFetcher(key, ttlMs, fetcher) {
  // En tests, los assertions esperan ver cambios al instante. Para no introducir
  // race conditions falsas, desactivamos el caché bajo NODE_ENV=test.
  const disabled = process.env.NODE_ENV === 'test' || !ttlMs;
  let entry = null; // { value, expiresAt } | null
  let pending = null;
  async function getCached() {
    if (disabled) return fetcher();
    const now = Date.now();
    if (entry && entry.expiresAt > now) return entry.value;
    if (pending) return pending;
    pending = (async () => {
      try {
        const value = await fetcher();
        entry = { value, expiresAt: Date.now() + ttlMs };
        return value;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }
  // Invalidación manual: el próximo get() refetchea. El pending in-flight
  // (si hay) NO se cancela — espera y lo que devuelva es el valor stale,
  // pero el SIGUIENTE call después de invalidate ya refetchea. Es ok para
  // el caso "writer invalida luego de COMMIT": no hay pending nuevo hasta
  // que llega el próximo GET.
  getCached.invalidate = () => { entry = null; };
  return getCached;
}

// ────────────────────────────────────────────────────────────────
// createCachedFetcherRedis — versión cross-instance (Redis)
// ────────────────────────────────────────────────────────────────
//
// Mismo API que createCachedFetcher pero respaldado por Redis. Patrón:
//   1. getCached() → SI Redis enabled, GET key → si hit, JSON.parse y devolver.
//   2. Si miss/timeout/error: fetcher() → JSON.stringify → SETEX key ttl.
//      Si SETEX falla, devolvemos el valor igual (sin cachear).
//   3. .invalidate() → DEL key. Cross-instance: cualquier réplica que haga
//      get después ve cache miss y refetchea.
//
// Tombstone anti-stale-write (TANDA 0 hotfix BLOCKER B1 auditoría 2026-06-17):
//   Sin tombstone existe un race:
//     T1: replicaA's requestA1 → MISS → arranca fetcher() (in-flight)
//     T2: replicaB hace invalidate() → redis.del(key)  (key aún no existe)
//     T3: replicaA's pending resuelve → SETEX key con valor PRE-T2 (stale)
//     T4..T64: Redis cachea valor stale por hasta `ttlMs`.
//   Resultado: tokens viejos siguen aceptados post-logout / cambios no se ven.
//   Rompe la invariante "invalidación cross-instance se ve en <100ms".
//
//   Fix: invalidate() también escribe un tombstone con TTL 2s (un poco mayor
//   que el wall-clock máximo esperable de un fetcher típico — ~500ms-1s).
//   Antes de SETEX, chequeamos el tombstone; si existe, no escribimos. El
//   próximo getCached() verá MISS y refetcheará con datos frescos. El
//   tombstone expira solo sin operación adicional.
//
// Fallback graceful: si Redis está down (REDIS_URL no set, timeout, etc.),
// CADA llamada hace fetch directo a Postgres. NO cacheamos en memoria local
// porque eso traería de vuelta el problema de fragmentación que P-04
// arregla. Tradeoff: durante outage de Redis, baja throughput pero la
// consistencia entre réplicas se mantiene.
//
// Concurrencia: single-flight dedup local (igual que createCachedFetcher) —
// si llegan N requests con cache miss, hacemos UNA sola fetch.
//
// En NODE_ENV=test el cache se desactiva (fetcher() siempre). Tests que
// quieran verificar el path Redis usan `_setClientForTest` en redisClient.js.

// Tombstone TTL: 2s cubre el wall-clock típico de un fetcher (~500ms-1s
// incluyendo Postgres roundtrip). Si un fetcher es excepcionalmente lento
// (>2s), igualmente vamos a refetchear correcto al próximo MISS — el TTL del
// tombstone solo controla "cuánto tiempo bloqueamos writes post-invalidate".
const TOMBSTONE_TTL_SEC = 2;
const tombstoneKey = (key) => `cache:tombstone:${key}`;

function createCachedFetcherRedis(key, ttlMs, fetcher) {
  const disabled = process.env.NODE_ENV === 'test' || !ttlMs;
  const ttlSec = Math.max(1, Math.floor(ttlMs / 1000));
  const tsKey = tombstoneKey(key);
  let pending = null;

  async function getCached() {
    if (disabled) return fetcher();

    // 1. Try Redis read.
    if (redis.isEnabled()) {
      const cached = await redis.get(key);
      if (cached !== null) {
        try {
          return JSON.parse(cached);
        } catch (err) {
          logger.warn({ err: err.message, key }, 'cacheTtl: JSON.parse del cache Redis falló — refetch');
          // Cache corrupto: invalidamos y refetcheamos.
          await redis.del(key);
        }
      }
    }

    // 2. Cache miss / Redis down / parse error → single-flight fetch.
    if (pending) return pending;
    pending = (async () => {
      try {
        const value = await fetcher();
        // 3. Try to cache, salvo que un invalidate() corrió mientras
        // fetchábamos (tombstone presente). Esto previene el stale-write race.
        if (redis.isEnabled()) {
          try {
            const tombstoned = await redis.get(tsKey);
            if (tombstoned !== null) {
              logger.debug({ key }, 'cacheTtl: tombstone activo — skip SETEX (anti-stale-write)');
            } else {
              await redis.setEx(key, ttlSec, JSON.stringify(value));
            }
          } catch (err) {
            logger.debug({ err: err.message, key }, 'cacheTtl: SETEX falló — devolvemos valor sin cachear');
          }
        }
        return value;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  // Invalidación cross-instance. Setea tombstone (TTL 2s) ANTES del DEL para
  // bloquear stale-writes de fetchers in-flight en otras réplicas; después
  // borra el key. Cualquier réplica que haga getCached() después ve MISS y
  // refetchea desde Postgres. Si Redis está down, ambas operaciones son no-op
  // pero igual estamos sin cache → consistency preservada.
  getCached.invalidate = async () => {
    if (redis.isEnabled()) {
      // Orden: tombstone primero, DEL después. Si alguien escribe ENTRE
      // tombstone y DEL, el DEL se lo come. Si la fetch in-flight resuelve
      // DESPUÉS de ambos, ve tombstone y skip SETEX.
      try {
        await redis.setEx(tsKey, TOMBSTONE_TTL_SEC, '1');
      } catch (err) {
        logger.debug({ err: err.message, key }, 'cacheTtl: SETEX tombstone falló');
      }
      await redis.del(key);
    }
  };

  return getCached;
}

module.exports = { createCachedFetcher, createCachedFetcherRedis };

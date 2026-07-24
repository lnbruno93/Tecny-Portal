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
              // TANDA 4 fix HIGH P1/H3-Sol auditoría 2026-06-17: jitter ±20%
              // del TTL al SETEX. Sin esto, las 2 réplicas Railway escriben
              // valores que expiran en el MISMO instante → cuando expira, AMBAS
              // hacen MISS y disparan fetch() paralelo → 2x amplificación
              // (cache stampede cross-instance). El single-flight `pending`
              // dedupea per-replica pero no cross-instance. El jitter
              // desincroniza naturalmente la expiración para que solo una
              // réplica refetchee al boundary, la otra siga sirviendo cached
              // por ~20% más, y al expirar la 2da, la 1ra ya cacheó valor
              // nuevo. Reducción esperada de queries-en-borde: ~50%.
              //
              // Solo hacemos jitter hacia ABAJO (80-100% del TTL) para nunca
              // exceder la garantía de freshness diseñada por el caller.
              const jitterSec = Math.floor(ttlSec * 0.2 * Math.random());
              const effectiveTtl = Math.max(1, ttlSec - jitterSec);
              await redis.setEx(key, effectiveTtl, JSON.stringify(value));
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

// ────────────────────────────────────────────────────────────────
// createTenantScopedCache — factory para caches scopeados por tenant/user/etc
// ────────────────────────────────────────────────────────────────
//
// TANDA 4 refactor H3/H4-Hyg auditoría 2026-06-17.
//
// Antes este patrón estaba copiado ~6 veces en el codebase (userAuthCache,
// cajasCache, inventarioCache, dashboard mensual, dashboard ventas):
//   - Map<scopeKey, fetcher> con eviction LRU
//   - Cada miss crea un createCachedFetcherRedis nuevo con la key scopeada
//   - Bump LRU al hit (delete + set)
//   - Cap MAX_FETCHERS, evicción del más viejo
//
// Esta factory generaliza el patrón. Cada cache module concreto solo declara:
//   - `keyPrefix` (string fijo: 'cache:user_auth:u', 'cache:cajas:list:t', etc.)
//   - `ttlMs`
//   - `maxFetchers` (cap del Map LRU)
//   - `fetcher(scopeKey)` que computa el valor desde Postgres
//
// Devuelve un objeto con:
//   - `get(scopeKey)` → valor cacheado o computado.
//   - `invalidate(scopeKey)` → DEL cross-instance + tombstone (vía wrapper).
//     Si no hay fetcher local pero la otra réplica sí, crea lazy para
//     disparar redis.del — el fix de cross-instance del wrapper interno.
//   - `_resetForTest()` → clear del Map (útil para tests con beforeEach).
//
// Key resultante: `${keyPrefix}${scopeKey}` (sin separador — el keyPrefix
// incluye el separador final si quiere). Esto preserva exactly las keys
// que cada cache module usaba antes del refactor.
//
// Validación: scopeKey debe ser string no vacío. Si pasan número, los
// callers son responsables de toString — defensive porque las keys de
// Redis son strings y la concatenación implícita ya estaba dando false-
// positives en tests con `userId` int.
function createTenantScopedCache({ keyPrefix, ttlMs, maxFetchers = 256, fetcher }) {
  if (typeof keyPrefix !== 'string' || !keyPrefix) {
    throw new Error('createTenantScopedCache: keyPrefix requerido');
  }
  if (typeof fetcher !== 'function') {
    throw new Error('createTenantScopedCache: fetcher requerido');
  }
  const fetchers = new Map();

  function getFetcherForScope(scopeKey) {
    const sk = String(scopeKey);
    if (sk === '' || sk === 'undefined' || sk === 'null') {
      throw new Error(`createTenantScopedCache(${keyPrefix}): scopeKey inválido (${scopeKey})`);
    }
    let fn = fetchers.get(sk);
    if (fn) {
      // Bump LRU: re-insertar para que sea el más reciente.
      fetchers.delete(sk);
      fetchers.set(sk, fn);
      return fn;
    }
    fn = createCachedFetcherRedis(
      `${keyPrefix}${sk}`,
      ttlMs,
      () => fetcher(sk)
    );
    fetchers.set(sk, fn);
    if (fetchers.size > maxFetchers) {
      // LRU eviction: el más viejo es el primer key insertado.
      const oldest = fetchers.keys().next().value;
      fetchers.delete(oldest);
    }
    return fn;
  }

  return {
    async get(scopeKey) {
      return getFetcherForScope(scopeKey)();
    },

    // Invalida el cache de un scopeKey específico. Cross-instance vía Redis DEL
    // + tombstone (anti-stale-write race). Loggea errores internamente para
    // observabilidad sin propagar al caller (fire-and-forget en hot paths).
    async invalidate(scopeKey) {
      if (scopeKey == null) {
        logger.warn({ keyPrefix }, 'createTenantScopedCache.invalidate() sin scopeKey — no-op.');
        return;
      }
      try {
        const sk = String(scopeKey);
        const fn = fetchers.get(sk);
        if (fn) {
          await fn.invalidate();
          return;
        }
        // Cross-instance: la otra réplica puede tener el row cacheado.
        // Creamos fetcher lazy para tener handle de invalidate (redis.del).
        const tmp = getFetcherForScope(scopeKey);
        await tmp.invalidate();
      } catch (err) {
        logger.warn({ err: err.message, keyPrefix, scopeKey },
          'createTenantScopedCache invalidate falló — cache stale hasta TTL');
      }
    },

    // Invalida TODOS los scopeKeys que comienzan con `prefix`.
    // Útil para caches con compound key (ej. `{tenantId}|{desde}|{hasta}`)
    // donde no conocés los sufijos exactos al hacer una mutation. Pasás
    // el prefix `{tenantId}|` y se invalidan todas las date ranges cacheadas
    // para ese tenant.
    //
    // 2026-07-24 (cache audit P2 — DASHBOARD_VENTAS): agregado para poder
    // invalidar el dashboard de ventas de un tenant sin conocer el rango
    // de fechas específico que tenía cacheado.
    //
    // Limitación de cross-instance: solo invalida keys que este proceso ya
    // vio (están en el local Map). Keys cacheadas por OTRA réplica que este
    // proceso nunca tocó no se invalidan — quedan stale hasta el TTL natural.
    // En la práctica los operadores usan pocas date ranges (día actual + mes
    // actual), por lo que el hit-rate del local Map es alto y la ventana
    // cross-instance es acotada por el TTL corto (30s para dashboard).
    // Fix "real" cross-instance requiere generation counter en Redis — no
    // vale la pena para el 90% de casos que resuelve este approach simple.
    async invalidatePrefix(prefix) {
      if (typeof prefix !== 'string' || !prefix) {
        logger.warn({ keyPrefix }, 'createTenantScopedCache.invalidatePrefix() sin prefix — no-op.');
        return;
      }
      const toInvalidate = [];
      for (const sk of fetchers.keys()) {
        if (sk.startsWith(prefix)) toInvalidate.push(sk);
      }
      // Fire-and-forget en paralelo — cada invalidate() ya cataloga sus
      // propios errores internamente vía el catch del método invalidate().
      await Promise.all(toInvalidate.map((sk) => this.invalidate(sk)));
    },

    // Solo para tests: limpia el Map. Las entries del wrapper interno y de
    // Redis (si hay client real) no se tocan — necesario porque Jest comparte
    // módulos entre describes.
    _resetForTest() { fetchers.clear(); },
  };
}

module.exports = { createCachedFetcher, createCachedFetcherRedis, createTenantScopedCache };

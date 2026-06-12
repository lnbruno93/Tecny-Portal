const { createCachedFetcher, createCachedFetcherRedis } = require('../src/lib/cacheTtl');
const redisClient = require('../src/lib/redisClient');

describe('createCachedFetcher (local)', () => {
  // Por defecto el caché está deshabilitado bajo NODE_ENV=test (los tests assertean
  // estado inmediato). Forzamos el modo "prod" levantando temporariamente NODE_ENV.
  const withProdEnv = async (fn) => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { await fn(); } finally { process.env.NODE_ENV = prev; }
  };

  test('llama al fetcher una sola vez dentro del TTL', async () => {
    await withProdEnv(async () => {
      let calls = 0;
      const get = createCachedFetcher('k', 5000, async () => { calls++; return { v: calls }; });
      const a = await get();
      const b = await get();
      expect(calls).toBe(1);
      expect(a).toEqual({ v: 1 });
      expect(b).toEqual({ v: 1 });
    });
  });

  test('dedup concurrente: N requests simultáneos disparan UNA sola query', async () => {
    await withProdEnv(async () => {
      let calls = 0;
      const get = createCachedFetcher('k', 5000, async () => {
        calls++;
        await new Promise(r => setTimeout(r, 10));
        return calls;
      });
      const results = await Promise.all([get(), get(), get(), get()]);
      expect(calls).toBe(1);
      expect(new Set(results).size).toBe(1);
    });
  });

  test('si el fetcher tira error, no se cachea (próxima llamada vuelve a intentar)', async () => {
    await withProdEnv(async () => {
      let attempts = 0;
      const get = createCachedFetcher('k', 5000, async () => {
        attempts++;
        if (attempts === 1) throw new Error('boom');
        return 'ok';
      });
      await expect(get()).rejects.toThrow('boom');
      await expect(get()).resolves.toBe('ok');
    });
  });

  test('bajo NODE_ENV=test el caché está deshabilitado (refleja cambios al instante)', async () => {
    let v = 1;
    const get = createCachedFetcher('k', 5000, async () => v);
    expect(await get()).toBe(1);
    v = 2;
    expect(await get()).toBe(2);
  });

  test('invalidate() fuerza refetch en la próxima llamada (Perf H3 cajas)', async () => {
    await withProdEnv(async () => {
      let calls = 0;
      const get = createCachedFetcher('k', 5000, async () => ++calls);
      await get();
      await get();
      expect(calls).toBe(1);          // cacheado
      get.invalidate();
      await get();
      expect(calls).toBe(2);          // refetch tras invalidate
    });
  });
});

// ────────────────────────────────────────────────────────────────
// createCachedFetcherRedis — P-04 Fase 2
// ────────────────────────────────────────────────────────────────
//
// Tests con mock de Redis. Inyectamos un mock vía `_setClientForTest` en
// redisClient.js. El mock implementa get/setex/del + tracking de llamadas.
// Esto evita necesitar un Redis real en CI.
//
// Forzamos NODE_ENV=production para activar el path Redis (en test está
// deshabilitado por diseño — los tests assertean inmediatez).
describe('createCachedFetcherRedis (Redis backend)', () => {
  // Mock factory: store interno + tracking de llamadas.
  function makeMockRedis() {
    const store = new Map();
    const calls = { get: 0, setex: 0, del: 0 };
    const mock = {
      get: jest.fn(async (key) => {
        calls.get++;
        return store.has(key) ? store.get(key) : null;
      }),
      setex: jest.fn(async (key, ttlSec, value) => {
        calls.setex++;
        store.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key) => {
        calls.del++;
        const had = store.has(key);
        store.delete(key);
        return had ? 1 : 0;
      }),
      ping: jest.fn(async () => 'PONG'),
      scanStream: jest.fn(() => ({
        on: jest.fn((event, cb) => {
          if (event === 'end') setImmediate(cb);
        }),
      })),
    };
    return { mock, store, calls };
  }

  const withProdEnv = async (fn) => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { await fn(); } finally {
      process.env.NODE_ENV = prev;
      redisClient._setClientForTest(null);
    }
  };

  test('cache hit: GET devuelve valor cacheado sin llamar al fetcher', async () => {
    await withProdEnv(async () => {
      const { mock, store, calls } = makeMockRedis();
      redisClient._setClientForTest(mock);
      // Pre-populate el store interno (no usamos mockResolvedValueOnce porque
      // ese override anula nuestro contador `calls.get`).
      store.set('cache:test:k1', JSON.stringify({ v: 99 }));

      let fetcherCalls = 0;
      const get = createCachedFetcherRedis('cache:test:k1', 5000, async () => {
        fetcherCalls++;
        return { v: 1 };
      });

      const result = await get();
      expect(result).toEqual({ v: 99 });
      expect(fetcherCalls).toBe(0);     // no se llamó al fetcher
      expect(calls.get).toBe(1);        // 1 GET a Redis
      expect(calls.setex).toBe(0);      // no se cacheó nada nuevo
    });
  });

  test('cache miss: GET retorna null, fetcher corre, valor se cachea con SETEX', async () => {
    await withProdEnv(async () => {
      const { mock, calls, store } = makeMockRedis();
      redisClient._setClientForTest(mock);

      let fetcherCalls = 0;
      const get = createCachedFetcherRedis('cache:test:k2', 5000, async () => {
        fetcherCalls++;
        return { v: 42 };
      });

      const result = await get();
      expect(result).toEqual({ v: 42 });
      expect(fetcherCalls).toBe(1);
      expect(calls.get).toBe(1);
      expect(calls.setex).toBe(1);
      // Verificar contenido cacheado
      expect(JSON.parse(store.get('cache:test:k2'))).toEqual({ v: 42 });
    });
  });

  test('dedup concurrente: N requests con miss disparan UNA sola fetch', async () => {
    await withProdEnv(async () => {
      const { mock } = makeMockRedis();
      redisClient._setClientForTest(mock);

      let fetcherCalls = 0;
      const get = createCachedFetcherRedis('cache:test:k3', 5000, async () => {
        fetcherCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return fetcherCalls;
      });

      const results = await Promise.all([get(), get(), get(), get()]);
      expect(fetcherCalls).toBe(1);
      expect(new Set(results).size).toBe(1);
    });
  });

  test('invalidate() llama redis.del — cross-instance se reflejará en el próximo get', async () => {
    await withProdEnv(async () => {
      const { mock, calls } = makeMockRedis();
      redisClient._setClientForTest(mock);

      const get = createCachedFetcherRedis('cache:test:k4', 5000, async () => 'value');
      await get();
      expect(calls.setex).toBe(1);

      await get.invalidate();
      expect(calls.del).toBe(1);
    });
  });

  test('Redis disabled (no client): cada get hace fetch directo, no se cachea nada', async () => {
    await withProdEnv(async () => {
      redisClient._setClientForTest(null);

      let fetcherCalls = 0;
      const get = createCachedFetcherRedis('cache:test:k5', 5000, async () => {
        fetcherCalls++;
        return fetcherCalls;
      });

      const a = await get();
      const b = await get();
      // Sin Redis, NO cacheamos en memoria local (preserva consistency
      // cross-instance). Cada call hace fetch.
      expect(fetcherCalls).toBe(2);
      expect(a).toBe(1);
      expect(b).toBe(2);
    });
  });

  test('cache corrupto (JSON inválido): invalidamos y refetcheamos', async () => {
    await withProdEnv(async () => {
      const { mock, calls } = makeMockRedis();
      redisClient._setClientForTest(mock);
      mock.get.mockResolvedValueOnce('not-valid-json{{{');

      let fetcherCalls = 0;
      const get = createCachedFetcherRedis('cache:test:k6', 5000, async () => {
        fetcherCalls++;
        return { recovered: true };
      });

      const result = await get();
      expect(result).toEqual({ recovered: true });
      expect(fetcherCalls).toBe(1);
      expect(calls.del).toBeGreaterThanOrEqual(1); // se invalidó el cache corrupto
    });
  });

  test('bajo NODE_ENV=test el cache Redis está deshabilitado (igual que local)', async () => {
    const { mock } = makeMockRedis();
    redisClient._setClientForTest(mock);

    let v = 1;
    const get = createCachedFetcherRedis('cache:test:k7', 5000, async () => v);
    expect(await get()).toBe(1);
    v = 2;
    expect(await get()).toBe(2);   // sin TTL, refleja cambios al instante
    redisClient._setClientForTest(null);
  });
});

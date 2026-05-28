const { createCachedFetcher } = require('../src/lib/cacheTtl');

describe('createCachedFetcher', () => {
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
});

// Caché in-memory minimalista con TTL: para queries de lectura que
// son caras (full-table SUM, agregados por contacto) y se piden mucho
// (dashboard, KPIs). NO sirve para queries con filtros por usuario;
// es process-local (no compartida entre instancias).
//
// Patrón: const get = createCachedFetcher('key', ttlMs, async () => db.query(...));
//         router.get('/x', async (_req, res) => res.json(await get()));
//
// Concurrencia: si llegan N requests al mismo tiempo con el caché expirado,
// se hace UNA sola query y todos esperan (deduplicación con promise pending).

function createCachedFetcher(key, ttlMs, fetcher) {
  // En tests, los assertions esperan ver cambios al instante. Para no introducir
  // race conditions falsas, desactivamos el caché bajo NODE_ENV=test.
  const disabled = process.env.NODE_ENV === 'test' || !ttlMs;
  let entry = null; // { value, expiresAt } | null
  let pending = null;
  return async function getCached() {
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
  };
}

module.exports = { createCachedFetcher };

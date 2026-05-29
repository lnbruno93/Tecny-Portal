/**
 * Tests unitarios de withTx (auditoría #R-02).
 *
 * Mockeamos un pool minimalista para verificar que:
 *   - BEGIN / COMMIT se ejecutan en happy path
 *   - ROLLBACK se ejecuta cuando fn() tira
 *   - release() se llama SIEMPRE (incluso si ROLLBACK falla)
 *   - El error original se propaga, no el de ROLLBACK
 */
const withTx = require('../src/lib/withTx');

function mkClient() {
  const queries = [];
  const client = {
    query: jest.fn(async (sql) => { queries.push(sql); return { rows: [] }; }),
    release: jest.fn(),
  };
  return { client, queries };
}
function mkPool(client) { return { connect: jest.fn(async () => client) }; }

describe('withTx', () => {
  it('happy path: BEGIN + fn + COMMIT + release', async () => {
    const { client, queries } = mkClient();
    const pool = mkPool(client);
    const result = await withTx(pool, async (c) => {
      await c.query('SELECT 1');
      return { ok: true };
    });
    expect(result).toEqual({ ok: true });
    expect(queries).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('fn tira: ROLLBACK + release, error se propaga', async () => {
    const { client, queries } = mkClient();
    const pool = mkPool(client);
    await expect(withTx(pool, async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    expect(queries).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('ROLLBACK falla: release igual se llama, error original (no de ROLLBACK)', async () => {
    const client = {
      query: jest.fn(async (sql) => {
        if (sql === 'ROLLBACK') throw new Error('rollback failed');
        if (sql === 'BEGIN') return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = mkPool(client);
    await expect(withTx(pool, async () => { throw new Error('original error'); }))
      .rejects.toThrow('original error');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('fn retorna undefined: COMMIT igual se llama', async () => {
    const { client, queries } = mkClient();
    const pool = mkPool(client);
    const result = await withTx(pool, async () => {});
    expect(result).toBeUndefined();
    expect(queries).toEqual(['BEGIN', 'COMMIT']);
  });

  it('fn es síncrono que retorna promise: funciona', async () => {
    const { client, queries } = mkClient();
    const pool = mkPool(client);
    const result = await withTx(pool, (c) => c.query('INSERT').then(() => 42));
    expect(result).toBe(42);
    expect(queries).toEqual(['BEGIN', 'INSERT', 'COMMIT']);
  });
});

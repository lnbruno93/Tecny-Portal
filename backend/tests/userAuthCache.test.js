/**
 * Tests del cache Redis para `users.{password_changed_at, email_verified_at}`.
 *
 * Cubre:
 *   - getUserAuth devuelve el row del DB.
 *   - User no existente / soft-deleted devuelve null.
 *   - invalidateUserAuth con userId null es no-op (no rompe).
 *   - El flujo end-to-end de invalidación funciona post-COMMIT (smoke).
 *
 * NOTA: en NODE_ENV=test el wrapper Redis está deshabilitado (no cachea),
 * así que estos tests verifican que la LECTURA funciona correctamente. La
 * lógica de cache propiamente dicha está cubierta en cacheTtl.test.js.
 * Acá testeamos solo el adapter — query SQL, normalización de timestamps,
 * manejo de null.
 */

const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const { getUserAuth, invalidateUserAuth, _resetForTest } = require('../src/lib/userAuthCache');
const bcrypt = require('bcrypt');

let pool;
let userId;

beforeAll(async () => {
  pool = await setupTestDb();
  // Crear un user específico para estos tests — no usamos testadmin (id 1)
  // para evitar choques con tests que esperan estado consistente del admin.
  const hash = await bcrypt.hash('cachepwd123', 10);
  const { rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role)
       VALUES ('CacheTest', 'cachetest', 'cache@test.local', $1, 'op')
     RETURNING id`,
    [hash]
  );
  userId = rows[0].id;
});

afterAll(async () => { await teardownTestDb(pool); });

beforeEach(() => _resetForTest());

describe('userAuthCache.getUserAuth', () => {
  it('devuelve { password_changed_at, email_verified_at } del user existente', async () => {
    // Asegurarnos de un estado conocido.
    await pool.query(
      `UPDATE users SET password_changed_at = '2026-06-01T10:00:00Z',
                        email_verified_at  = '2026-06-02T11:00:00Z'
       WHERE id = $1`,
      [userId]
    );

    const data = await getUserAuth(userId);
    expect(data).not.toBeNull();
    expect(data.password_changed_at).toBe('2026-06-01T10:00:00.000Z');
    expect(data.email_verified_at).toBe('2026-06-02T11:00:00.000Z');
  });

  it('normaliza timestamps a ISO strings (no Date objects)', async () => {
    // Si el wrapper devolviera Date objects, el round-trip JSON.parse/stringify
    // del cache Redis daría tipos distintos entre hit/miss. Normalizamos a
    // string siempre.
    const data = await getUserAuth(userId);
    expect(typeof data.password_changed_at).toBe('string');
    expect(typeof data.email_verified_at).toBe('string');
  });

  it('user inexistente → null', async () => {
    const data = await getUserAuth(99999);
    expect(data).toBeNull();
  });

  it('user soft-deleted → null (deleted_at IS NOT NULL filtra el row)', async () => {
    // Soft-delete temporal del user de cache para chequear el filtro.
    await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [userId]);
    try {
      const data = await getUserAuth(userId);
      expect(data).toBeNull();
    } finally {
      // Restaurar para no romper tests siguientes.
      await pool.query('UPDATE users SET deleted_at = NULL WHERE id = $1', [userId]);
    }
  });

  it('password_changed_at = null cuando el field no está seteado', async () => {
    await pool.query(
      `UPDATE users SET password_changed_at = NULL, email_verified_at = NULL WHERE id = $1`,
      [userId]
    );
    const data = await getUserAuth(userId);
    expect(data).not.toBeNull();
    expect(data.password_changed_at).toBeNull();
    expect(data.email_verified_at).toBeNull();
  });

  it('userId inválido (no entero / negativo / cero) → throws', async () => {
    await expect(getUserAuth('abc')).rejects.toThrow(/userId inválido/);
    await expect(getUserAuth(-1)).rejects.toThrow(/userId inválido/);
    await expect(getUserAuth(0)).rejects.toThrow(/userId inválido/);
    await expect(getUserAuth(null)).rejects.toThrow(/userId inválido/);
  });
});

describe('userAuthCache.invalidateUserAuth', () => {
  it('userId null/undefined → no-op (no lanza)', async () => {
    await expect(invalidateUserAuth(null)).resolves.toBeUndefined();
    await expect(invalidateUserAuth(undefined)).resolves.toBeUndefined();
  });

  it('user no cacheado todavía → no-op silencioso (crea fetcher para invalidar igual)', async () => {
    // Esto chequea la rama "no fn en Map" → creamos fetcher temporal y
    // disparamos invalidate para que la otra réplica (que sí podría tener
    // cached) reciba el DEL.
    await expect(invalidateUserAuth(userId)).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// T1-T3 (TANDA 1 fix Tests auditoría 2026-06-17): tests con Redis mock
// ────────────────────────────────────────────────────────────────
//
// Los tests anteriores corren con NODE_ENV=test → cache deshabilitado → solo
// verifican el adapter (query + normalización). Los tests de abajo fuerzan
// NODE_ENV=production + Redis mock para ejercitar el path REAL:
//   - T1: invalidación observada end-to-end (UPDATE → invalidate → fresh read)
//   - T2: cross-instance (réplica B sin fetcher local → invalidate hace redis.del)
//   - T3: Redis-down → fallback a fetch directo sin romper
describe('userAuthCache con Redis mock (NODE_ENV=production)', () => {
  const redisClient = require('../src/lib/redisClient');

  function makeMockRedis() {
    const store = new Map();
    const calls = { get: 0, setex: 0, del: 0 };
    return {
      mock: {
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
          on: jest.fn((event, cb) => { if (event === 'end') setImmediate(cb); }),
        })),
      },
      store,
      calls,
    };
  }

  const withProdEnv = async (fn) => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { await fn(); } finally {
      process.env.NODE_ENV = prev;
      redisClient._setClientForTest(null);
      _resetForTest();
    }
  };

  it('T1: invalidación end-to-end — UPDATE DB → invalidate → siguiente getUserAuth ve fresh', async () => {
    await withProdEnv(async () => {
      const { mock, calls } = makeMockRedis();
      redisClient._setClientForTest(mock);

      // Estado inicial.
      await pool.query(
        `UPDATE users SET password_changed_at = '2026-05-01T00:00:00Z' WHERE id = $1`,
        [userId]
      );

      const a = await getUserAuth(userId);
      expect(a.password_changed_at).toBe('2026-05-01T00:00:00.000Z');
      expect(calls.setex).toBeGreaterThanOrEqual(1); // se cacheó

      // UPDATE en DB + invalidate.
      await pool.query(
        `UPDATE users SET password_changed_at = '2026-06-15T00:00:00Z' WHERE id = $1`,
        [userId]
      );
      await invalidateUserAuth(userId);
      expect(calls.del).toBeGreaterThanOrEqual(1); // se borró key

      // Próximo read debe refetchear de Postgres.
      const b = await getUserAuth(userId);
      expect(b.password_changed_at).toBe('2026-06-15T00:00:00.000Z');
    });
  });

  it('T2: cross-instance — réplica B (sin fetcher local) sigue disparando redis.del', async () => {
    // Simula el caso real de prod: réplica A hizo logout y bumpeó
    // password_changed_at + invalidate. Réplica B (este test) jamás cacheó
    // este user pero TIENE que disparar redis.del para que su PROPIA réplica
    // refetchee al próximo getUserAuth, además de propagar la invalidación
    // cross-instance.
    await withProdEnv(async () => {
      const { mock, calls } = makeMockRedis();
      redisClient._setClientForTest(mock);

      // _resetForTest ya corrió en beforeEach → fetchers Map vacío.
      // Llamamos invalidate SIN antes hacer getUserAuth → no hay fetcher local.
      await invalidateUserAuth(userId);

      // La rama "no fn local" crea fetcher lazy → llama .invalidate() → redis.del.
      expect(calls.del).toBeGreaterThanOrEqual(1);
      expect(mock.del.mock.calls[0][0]).toBe(`cache:user_auth:u${userId}`);
    });
  });

  it('T3: Redis-down → fallback a fetch directo, no rompe', async () => {
    await withProdEnv(async () => {
      // Sin client Redis: redis.isEnabled() devuelve false en redisClient.js.
      redisClient._setClientForTest(null);

      // Estado conocido.
      await pool.query(
        `UPDATE users SET password_changed_at = '2026-07-01T00:00:00Z' WHERE id = $1`,
        [userId]
      );

      const a = await getUserAuth(userId);
      expect(a).not.toBeNull();
      expect(a.password_changed_at).toBe('2026-07-01T00:00:00.000Z');

      // Cada call hace fetch directo (sin Redis no cacheamos en memoria local).
      const b = await getUserAuth(userId);
      expect(b.password_changed_at).toBe('2026-07-01T00:00:00.000Z');
      // Y invalidateUserAuth tampoco lanza si Redis está down.
      await expect(invalidateUserAuth(userId)).resolves.toBeUndefined();
    });
  });
});

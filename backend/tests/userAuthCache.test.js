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

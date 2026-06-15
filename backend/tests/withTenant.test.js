/**
 * Tests del helper db.withTenant (PR 3 multi-tenant).
 *
 * Valida que cuando un endpoint USA withTenant, RLS filtra automáticamente
 * por el tenant_id especificado — independientemente del WHERE explícito de
 * la query. Es la prueba que confirma que el aislamiento funciona end-to-end
 * con Postgres RLS + tx-scoped SET LOCAL.
 *
 * Caveat: en local los tests corren con un superuser que BYPASSA RLS. Para
 * obligar a Postgres a aplicar RLS incluso al owner/superuser, este test
 * crea explícitamente un user no-superuser ("rls_tester"), le da grants
 * granulares, y ejecuta las queries con SET ROLE. En staging/prod ese paso
 * no es necesario (el role de la app ya es no-super).
 */
const { Pool } = require('pg');
const db = require('../src/config/database');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;

const ROLE_NAME = 'rls_tester_pr3';

beforeAll(async () => {
  pool = await setupTestDb();

  // Crear el role de test (no-superuser) con grants para validar RLS real.
  await pool.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);
  await pool.query(`CREATE ROLE ${ROLE_NAME} LOGIN NOSUPERUSER`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${ROLE_NAME}`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${ROLE_NAME}`);

  // Tenant adicional para los tests (el tenant 1 ya viene de la migration de PR 1).
  await pool.query(`
    INSERT INTO tenants (id, nombre, slug, plan) VALUES (777, 'Test Tenant 777', 'test777', 'pro')
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 777))`);
});

afterAll(async () => {
  // Cleanup: el role queda con privilegios sobre tablas — hay que revoke antes de drop.
  try {
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE_NAME}`);
    await pool.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${ROLE_NAME}`);
    await pool.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);
  } catch (_) { /* swallow — no bloquear teardown si el role tiene deps */ }
  await pool.query(`DELETE FROM categorias WHERE nombre LIKE 'RLS_TEST_%'`);
  await pool.query(`DELETE FROM tenants WHERE id = 777`);
  await teardownTestDb(pool);
});

describe('db.withTenant — aislamiento RLS', () => {
  beforeEach(async () => {
    // Limpiar categorías de tests previos
    await pool.query(`DELETE FROM categorias WHERE nombre LIKE 'RLS_TEST_%'`);
    // Sembrar 1 categoría en cada tenant
    await pool.query(`INSERT INTO categorias (nombre, tenant_id) VALUES ('RLS_TEST_T1', 1)`);
    await pool.query(`INSERT INTO categorias (nombre, tenant_id) VALUES ('RLS_TEST_T777', 777)`);
  });

  it('rechaza tenantId inválido (no entero positivo)', async () => {
    await expect(db.withTenant(0, async () => {})).rejects.toThrow(/inválido/);
    await expect(db.withTenant(-1, async () => {})).rejects.toThrow(/inválido/);
    await expect(db.withTenant(1.5, async () => {})).rejects.toThrow(/inválido/);
    await expect(db.withTenant('1', async () => {})).rejects.toThrow(/inválido/);
    await expect(db.withTenant(null, async () => {})).rejects.toThrow(/inválido/);
  });

  it('commit normal: ejecuta callback y libera client al pool', async () => {
    const result = await db.withTenant(1, async (client) => {
      const { rows } = await client.query(`SELECT 1 AS uno`);
      return rows[0].uno;
    });
    expect(result).toBe(1);
  });

  it('rollback en error: tx se revierte, error se propaga', async () => {
    // Insert que después tiraremos para verificar rollback
    await expect(db.withTenant(1, async (client) => {
      await client.query(`INSERT INTO categorias (nombre, tenant_id) VALUES ('RLS_TEST_RBK', 1)`);
      throw new Error('boom');
    })).rejects.toThrow('boom');

    // La fila NO debe persistir (rollback funcionó)
    const { rows } = await pool.query(`SELECT * FROM categorias WHERE nombre = 'RLS_TEST_RBK'`);
    expect(rows).toHaveLength(0);
  });

  // ── RLS real con role no-superuser ───────────────────────────────────────
  // Nota: usamos pool.connect() + SET ROLE para que las queries de aislamiento
  // corran como rls_tester (no-super). El helper db.withTenant usa el pool
  // global que sí es super en local — por eso replicamos la lógica acá.

  it('como user no-super: tenantId=1 SOLO ve la cat de tenant 1', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '1'`);
      const { rows } = await client.query(`SELECT nombre, tenant_id FROM categorias WHERE nombre LIKE 'RLS_TEST_%'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].nombre).toBe('RLS_TEST_T1');
      expect(rows[0].tenant_id).toBe(1);
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  });

  it('como user no-super: tenantId=777 SOLO ve la cat de tenant 777', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '777'`);
      const { rows } = await client.query(`SELECT nombre, tenant_id FROM categorias WHERE nombre LIKE 'RLS_TEST_%'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].nombre).toBe('RLS_TEST_T777');
      expect(rows[0].tenant_id).toBe(777);
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  });

  it('como user no-super: INSERT con tenant ajeno es bloqueado por WITH CHECK', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '1'`);
      // Intento insertar una cat con tenant_id=777 estando en sesión de tenant 1.
      // La policy WITH CHECK debe rechazarlo.
      await expect(
        client.query(`INSERT INTO categorias (nombre, tenant_id) VALUES ('RLS_TEST_CROSS', 777)`)
      ).rejects.toThrow(/row-level security/i);
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  });

  it('post-withTenant: el client vuelve al pool sin app.current_tenant seteado', async () => {
    // Después de un withTenant, el SIGUIENTE pool.connect() recibe un client
    // limpio. Validamos que current_setting() vuelve a '' (default).
    await db.withTenant(777, async (client) => {
      const { rows } = await client.query(`SELECT current_setting('app.current_tenant', true) AS t`);
      expect(rows[0].t).toBe('777');
    });
    // El client ya fue release()-ado. Sacamos otro y verificamos.
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`SELECT current_setting('app.current_tenant', true) AS t`);
      // Después del COMMIT del SET LOCAL, la setting se descarta. Postgres
      // devuelve '' (string vacío) cuando la setting no fue seteada en sesión.
      expect(rows[0].t).toBe('');
    } finally {
      client.release();
    }
  });
});

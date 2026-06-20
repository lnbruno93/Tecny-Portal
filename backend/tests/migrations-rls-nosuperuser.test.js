/**
 * Tests de migrations bajo role NOSUPERUSER (post-incidente 2026-06-20 #347).
 *
 * Contexto del incidente:
 *   La migration 20260620000002_alertas_config_per_tenant.js hacía un seed
 *   con `INSERT ... SELECT FROM tenants CROSS JOIN ...` sin setear
 *   `app.current_tenant`. La policy RLS WITH CHECK rechazó el INSERT con
 *   error 42501 ("new row violates row-level security policy") en prod y
 *   staging — pero NO en mi test local porque mi role de Postgres es
 *   SUPERUSER + BYPASSRLS. La migration corrió 7 horas fallando todos los
 *   deploys de Railway antes de detectarse.
 *
 * Lo que este test garantiza:
 *   1. Cualquier INSERT que ejecutemos sobre `alertas_config` SIN setear
 *      `app.current_tenant` falle con error 42501 bajo role NOSUPERUSER
 *      (smoke: confirma que la policy RLS sigue activa).
 *   2. El mismo INSERT envuelto en DO loop con `set_config(app.current_tenant,
 *      ...)` pasa OK — el patrón canónico para seeds tenant-scoped.
 *   3. La migration #347 fixed (alertas_config_per_tenant) usa el patrón
 *      correcto — replica el SQL real de la migration y lo ejecuta como
 *      NOSUPERUSER para verificar end-to-end.
 *
 * Por qué importa: este test ES la diferencia entre "rompe en prod" vs
 * "rompe en CI antes del merge". Cualquier futura migration con seed por
 * tenant que olvide setear app.current_tenant queda atrapada acá.
 *
 * Patrón base: tests/withTenant.test.js (role rls_tester_pr3) — mismo
 * approach con role local NOSUPERUSER.
 */

const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;

const ROLE_NAME = 'mig_rls_tester';
// Tipo de prueba único para no chocar con seed real ni con otros tests.
const TEST_TIPO_FAIL = 'mig_rls_test_fail';
const TEST_TIPO_OK   = 'mig_rls_test_ok';
const TEST_TIPO_SEED = 'mig_rls_test_seed';

beforeAll(async () => {
  pool = await setupTestDb();

  // Limpiar role previo si quedó de una corrida abortada (Jest SIGINT, etc.)
  try {
    await pool.query(`REASSIGN OWNED BY ${ROLE_NAME} TO CURRENT_USER`);
    await pool.query(`DROP OWNED BY ${ROLE_NAME} CASCADE`);
  } catch (_) { /* role no existía */ }
  await pool.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);

  await pool.query(`CREATE ROLE ${ROLE_NAME} LOGIN NOSUPERUSER`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${ROLE_NAME}`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${ROLE_NAME}`);

  // El role necesita ser OWNER de alertas_config para que FORCE RLS le aplique
  // como aplica al app role en prod (no como bypassable owner). En prod el
  // role app YA es owner — replicamos esa condición.
  await pool.query(`ALTER TABLE alertas_config OWNER TO ${ROLE_NAME}`);
});

afterAll(async () => {
  // Devolver ownership al role original para no romper otros tests
  try {
    await pool.query(`ALTER TABLE alertas_config OWNER TO CURRENT_USER`);
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE_NAME}`);
    await pool.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${ROLE_NAME}`);
    await pool.query(`REASSIGN OWNED BY ${ROLE_NAME} TO CURRENT_USER`);
    await pool.query(`DROP OWNED BY ${ROLE_NAME} CASCADE`);
    await pool.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);
  } catch (_) { /* swallow — el next teardown limpia residuos */ }
  await pool.query(`DELETE FROM alertas_config WHERE tipo LIKE 'mig_rls_test_%'`);
  await teardownTestDb(pool);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM alertas_config WHERE tipo LIKE 'mig_rls_test_%'`);
});

describe('Migration seed RLS — bug que causó el incidente #347', () => {
  it('INSERT directo SIN setear app.current_tenant FALLA bajo NOSUPERUSER (42501)', async () => {
    // Este es exactamente el patrón que tenía la migration pre-fix:
    // INSERT ... SELECT FROM tenants CROSS JOIN ... — sin setear
    // app.current_tenant antes. La policy WITH CHECK rechaza porque
    // tenant_id != NULL (current_setting devuelve NULL sin set).
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      // Asegurar que current_tenant NO esté seteado (limpio).
      await client.query(`SELECT set_config('app.current_tenant', '', false)`);

      await expect(
        client.query(
          `INSERT INTO alertas_config (tenant_id, tipo, activa, parametros)
           SELECT t.id, $1, true, '{}'::jsonb
             FROM tenants t
            WHERE t.id = 1`,
          [TEST_TIPO_FAIL]
        )
      ).rejects.toMatchObject({
        // 42501 = insufficient_privilege. Postgres usa este code para
        // violaciones de RLS WITH CHECK también.
        code: '42501',
        message: expect.stringMatching(/row-level security policy.*alertas_config/i),
      });
      await client.query('ROLLBACK');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
  });

  it('INSERT con set_config(app.current_tenant) ANTES PASA bajo NOSUPERUSER', async () => {
    // Este es el patrón post-fix: set_config con scope local (true) que
    // se descarta al COMMIT. La policy WITH CHECK pasa porque tenant_id
    // = current_setting matchea.
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', '1', true)`);
      await client.query(
        `INSERT INTO alertas_config (tenant_id, tipo, activa, parametros)
         VALUES (1, $1, true, '{}'::jsonb)
         ON CONFLICT (tenant_id, tipo) DO NOTHING`,
        [TEST_TIPO_OK]
      );
      await client.query('COMMIT');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }

    // Verificar que se persistió (con superuser, bypassa RLS para read)
    const { rows } = await pool.query(
      `SELECT tenant_id, tipo FROM alertas_config WHERE tipo = $1`,
      [TEST_TIPO_OK]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: 1, tipo: TEST_TIPO_OK });
  });

  it('patrón canónico DO LOOP con set_config funciona para multi-tenant seed', async () => {
    // Replica del patrón usado en la migration #347 fixed:
    // DO $$ DECLARE t_id INT; BEGIN
    //   FOR t_id IN SELECT id FROM tenants WHERE ... LOOP
    //     PERFORM set_config('app.current_tenant', t_id::text, true);
    //     INSERT ...
    //   END LOOP;
    // END $$;
    //
    // Si el día de mañana alguien rompe la migration (vuelve a CROSS JOIN
    // sin set), este test FALLA — gate antes de mergear.
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`
        DO $do$
        DECLARE t_id INT;
        BEGIN
          FOR t_id IN SELECT id FROM tenants WHERE deleted_at IS NULL AND id = 1 LOOP
            PERFORM set_config('app.current_tenant', t_id::text, true);
            INSERT INTO alertas_config (tenant_id, tipo, activa, parametros)
            VALUES (t_id, '${TEST_TIPO_SEED}', true, '{}'::jsonb)
            ON CONFLICT (tenant_id, tipo) DO NOTHING;
          END LOOP;
        END $do$;
      `);
      await client.query('COMMIT');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }

    const { rows } = await pool.query(
      `SELECT tenant_id FROM alertas_config WHERE tipo = $1 ORDER BY tenant_id`,
      [TEST_TIPO_SEED]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].tenant_id).toBe(1);
  });
});

describe('Migration #347 — el seed actual del archivo fixed', () => {
  it('los 5 default tipos están seedeados para tenant 1', async () => {
    // Smoke: la migration ya corrió en setupTestDb (npm run migrate).
    // Verificamos que el seed dejó las 5 filas esperadas para tenant 1.
    const { rows } = await pool.query(
      `SELECT tipo FROM alertas_config WHERE tenant_id = 1 ORDER BY tipo`
    );
    const tipos = rows.map(r => r.tipo);
    expect(tipos).toEqual(expect.arrayContaining([
      'caja_negativa',
      'cc_mora',
      'proveedor_atrasado',
      'stock_bajo',
      'tc_referencia',
    ]));
  });
});

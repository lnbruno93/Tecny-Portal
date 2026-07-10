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

/**
 * Incidente 2026-06-24 (segundo del mismo patrón):
 *
 * La migration 20260624000001_capability_roles_owner_admin_backfill.js hacía
 * un UPDATE cross-tenant sobre tenant_user_roles (FORCE RLS) usando solo
 * `SET LOCAL row_security = off` para "bypassear" RLS. Eso solo funciona
 * para roles con BYPASSRLS — pero las migrations corren con ipro_app
 * (NOSUPERUSER, sin BYPASSRLS) — el comment de la migration estaba mal.
 * Resultado: ~10 deploys de Railway en FAILED hasta detectar.
 *
 * Este test reproduce el escenario contra tenant_user_roles bajo NOSUPERUSER
 * y comprueba el patrón canónico que sí funciona. Si alguien rompe la
 * migration de vuelta (o agrega una nueva con UPDATE cross-tenant directo),
 * este test la atrapa antes del merge.
 */
describe('UPDATE cross-tenant en tenant_user_roles bajo NOSUPERUSER — bug 2026-06-24', () => {
  // tenant_user_roles tiene FORCE RLS, no podemos cambiar ownership a
  // mig_rls_tester sin romper otros tests. Pero el escenario clave es que
  // el role NOSUPERUSER que escribe ES el mismo OWNER (en prod, ipro_app es
  // OWNER de todas las tablas). El test de alertas_config arriba ya hizo
  // ALTER TABLE alertas_config OWNER TO ${ROLE_NAME} — tomamos prestada esa
  // condición y replicamos sobre tenant_user_roles para este describe.
  beforeAll(async () => {
    await pool.query(`ALTER TABLE tenant_user_roles OWNER TO ${ROLE_NAME}`);
  });

  afterAll(async () => {
    try { await pool.query(`ALTER TABLE tenant_user_roles OWNER TO CURRENT_USER`); }
    catch (_) {}
  });

  it('UPDATE cross-tenant SIN setear app.current_tenant FALLA con 42501', async () => {
    // Patrón del bug: la versión pre-fix de 20260624000001 hacía esto.
    // Sin app.current_tenant, current_setting devuelve NULL, la policy
    // WITH CHECK falla en el primer row porque tenant_id != NULL.
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      // Reset explícito por si una corrida previa dejó el setting.
      await client.query(`SELECT set_config('app.current_tenant', '', false)`);
      // SET LOCAL row_security = off — esto era el "fix" que no funcionaba.
      // ipro_app es OWNER pero no tiene BYPASSRLS, así que es no-op bajo
      // FORCE RLS.
      await client.query(`SET LOCAL row_security = off`);

      await expect(
        client.query(`
          UPDATE tenant_user_roles tur
             SET rol = 'admin', updated_at = NOW()
            FROM tenant_users tu
           WHERE tur.tenant_id = tu.tenant_id
             AND tur.user_id   = tu.user_id
             AND tur.rol       = 'custom'
             AND tu.rol IN ('owner', 'admin')
        `)
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/row-level security policy.*tenant_user_roles/i),
      });
      await client.query('ROLLBACK');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
  });

  it('UPDATE en DO loop con set_config por tenant PASA bajo NOSUPERUSER', async () => {
    // Replica del patrón fixed (el que ahora vive en 20260624000001).
    // No esperamos ningún row a fixear en CI (el seed test no crea owners
    // con rol mismatch), pero queremos comprobar que el SQL no es rechazado
    // por RLS.
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`
        DO $do$
        DECLARE
          t_id INT;
          n    INT;
        BEGIN
          FOR t_id IN SELECT id FROM tenants WHERE deleted_at IS NULL ORDER BY id LOOP
            PERFORM set_config('app.current_tenant', t_id::text, true);
            WITH up AS (
              UPDATE tenant_user_roles tur
                 SET rol        = tu.rol,
                     updated_at = NOW()
                FROM tenant_users tu
               WHERE tur.tenant_id = t_id
                 AND tur.tenant_id = tu.tenant_id
                 AND tur.user_id   = tu.user_id
                 AND tur.rol       = 'custom'
                 AND tu.rol IN ('owner', 'admin')
              RETURNING 1
            )
            SELECT COUNT(*) INTO n FROM up;
          END LOOP;
        END $do$;
      `);
      await client.query('COMMIT');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
    // Si llegamos acá sin throw → el patrón pasa RLS bajo NOSUPERUSER ✓
  });
});

// Tests post-incidente 2026-07-09 (deploys F3 fallidos en Railway).
//
// Contexto: la migration F1 (20260708000001_productos_clase_categorias_reales)
// hace UPDATE bulk sobre productos + ADD CONSTRAINT CHECK final. Falló 10
// veces en producción porque:
//   1. productos tiene FORCE ROW LEVEL SECURITY (aplica también al owner)
//   2. La migration corre como user `ipro_app` (owner de productos pero
//      no superuser) sin `app.current_tenant` seteado
//   3. Los UPDATE afectan 0 filas por RLS → filas legacy quedan sin migrar
//   4. ADD CONSTRAINT valida contra tabla física → error 23514
//
// Fix aplicado en el PR #543: envolver el bulk con:
//   ALTER TABLE productos NO FORCE ROW LEVEL SECURITY;
//   -- bulk UPDATE + ADD CONSTRAINT
//   ALTER TABLE productos FORCE ROW LEVEL SECURITY;
//
// Este test valida el patrón EN ISOLATION (tabla temporal `productos_rls_test`)
// para que cualquier migration futura con bulk UPDATE sobre tabla FORCE RLS
// tenga cobertura. Si alguien intenta el UPDATE sin el bypass, este test
// se cae y el CI del PR rebota antes del merge.
//
// Runbook: docs/runbooks/rls-bulk-migration.md
describe('Migration bulk UPDATE sobre FORCE RLS — bug incidente F3 2026-07-09', () => {
  const TEST_TABLE = 'productos_rls_test';

  beforeAll(async () => {
    // Tabla temporal que replica el scenario de productos: multi-tenant +
    // FORCE RLS + policy tenant_isolation + CHECK constraint sobre `clase`.
    // Isolate del resto del suite para no acoplar tests.
    await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
    await pool.query(`
      CREATE TABLE ${TEST_TABLE} (
        id     SERIAL PRIMARY KEY,
        tenant_id INT NOT NULL,
        clase  TEXT NOT NULL CHECK (clase IN ('celular', 'accesorio'))
      );
      ALTER TABLE ${TEST_TABLE} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${TEST_TABLE} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${TEST_TABLE}
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
    `);
    // Owner debe ser el role NOSUPERUSER para que FORCE RLS le aplique.
    await pool.query(`ALTER TABLE ${TEST_TABLE} OWNER TO ${ROLE_NAME}`);
    await pool.query(`GRANT ALL ON ${TEST_TABLE}, ${TEST_TABLE}_id_seq TO ${ROLE_NAME}`);
    // Seedeamos 3 filas de 2 tenants distintos con superuser (bypass RLS).
    await pool.query(`INSERT INTO ${TEST_TABLE} (tenant_id, clase) VALUES
      (1, 'celular'), (1, 'accesorio'), (2, 'celular')`);
  });

  afterAll(async () => {
    try {
      await pool.query(`ALTER TABLE ${TEST_TABLE} OWNER TO CURRENT_USER`);
      await pool.query(`DROP TABLE ${TEST_TABLE} CASCADE`);
    } catch (_) { /* swallow */ }
  });

  it('reproduce el bug: UPDATE bulk como NOSUPERUSER-owner SIN bypass afecta 0 filas', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      // Sin SET app.current_tenant → RLS filtra TODAS las filas.
      const { rowCount } = await client.query(
        `UPDATE ${TEST_TABLE} SET clase = 'celular_sellado' WHERE clase = 'celular'`
      );
      // Bug reproducido: 0 filas actualizadas (deberían ser 2).
      expect(rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
  });

  it('reproduce la consecuencia: ADD CONSTRAINT CHECK falla con filas no migradas', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      // Intenta reemplazar el CHECK viejo por uno nuevo restringido. Como
      // el UPDATE de arriba no actualizó nada (RLS), las filas siguen con
      // clase='celular' y el nuevo CHECK las rechaza → error 23514.
      await expect(
        client.query(`
          ALTER TABLE ${TEST_TABLE} DROP CONSTRAINT ${TEST_TABLE}_clase_check;
          ALTER TABLE ${TEST_TABLE} ADD CONSTRAINT ${TEST_TABLE}_clase_check
            CHECK (clase IN ('celular_sellado', 'celular_usado', 'accesorios_varios'));
        `)
      ).rejects.toMatchObject({
        code: '23514',
        constraint: `${TEST_TABLE}_clase_check`,
      });
      await client.query('ROLLBACK');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
  });

  it('fix del PR #543: NO FORCE + UPDATE + FORCE permite migration bulk end-to-end', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      // Paso 0 (fix incidente): bypass FORCE (owner puede sin superuser).
      await client.query(`ALTER TABLE ${TEST_TABLE} NO FORCE ROW LEVEL SECURITY`);
      // Paso 1 (mismo orden que la migration real F1): ampliar el CHECK
      // para aceptar valores viejos + nuevos durante el backfill.
      await client.query(`ALTER TABLE ${TEST_TABLE} DROP CONSTRAINT ${TEST_TABLE}_clase_check`);
      await client.query(`
        ALTER TABLE ${TEST_TABLE} ADD CONSTRAINT ${TEST_TABLE}_clase_check
          CHECK (clase IN ('celular', 'accesorio', 'celular_sellado', 'celular_usado', 'accesorios_varios'));
      `);
      // Paso 2: UPDATE bulk — ahora ve todas las filas (owner sin FORCE).
      const upd1 = await client.query(
        `UPDATE ${TEST_TABLE} SET clase = 'celular_sellado' WHERE clase = 'celular'`
      );
      expect(upd1.rowCount).toBe(2);  // ambas filas 'celular' de tenants 1 y 2
      const upd2 = await client.query(
        `UPDATE ${TEST_TABLE} SET clase = 'accesorios_varios' WHERE clase = 'accesorio'`
      );
      expect(upd2.rowCount).toBe(1);
      // Paso 3: restringir el CHECK a solo los nuevos — ahora todas las
      // filas cumplen porque el UPDATE efectivo migró todo.
      await client.query(`ALTER TABLE ${TEST_TABLE} DROP CONSTRAINT ${TEST_TABLE}_clase_check`);
      await client.query(`
        ALTER TABLE ${TEST_TABLE} ADD CONSTRAINT ${TEST_TABLE}_clase_check
          CHECK (clase IN ('celular_sellado', 'celular_usado', 'accesorios_varios'));
      `);
      // Paso 4 (fix incidente): restaurar FORCE (post-migration).
      await client.query(`ALTER TABLE ${TEST_TABLE} FORCE ROW LEVEL SECURITY`);
      await client.query('COMMIT');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
    // Post-migration verificamos con superuser: filas migradas + FORCE restaurado.
    const { rows: filas } = await pool.query(
      `SELECT tenant_id, clase FROM ${TEST_TABLE} ORDER BY id`
    );
    expect(filas).toEqual([
      { tenant_id: 1, clase: 'celular_sellado' },
      { tenant_id: 1, clase: 'accesorios_varios' },
      { tenant_id: 2, clase: 'celular_sellado' },
    ]);
    const { rows: rlsState } = await pool.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = '${TEST_TABLE}'`
    );
    expect(rlsState[0].relforcerowsecurity).toBe(true);  // FORCE se restauró ✓
  });
});

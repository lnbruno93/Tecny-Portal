/**
 * Tests con pool conectado DIRECTAMENTE como NOSUPERUSER (Plataforma P1-2).
 *
 * 2026-07-12 (auditoría TOTAL Plataforma P1-2):
 *
 * Contexto: ya existe `migrations-rls-nosuperuser.test.js` que corre con
 * `SET ROLE mig_rls_tester` DENTRO del pool superuser. Ese approach cubre
 * escenarios F1 (bug bulk UPDATE) y #347 (INSERT sin tenant seteado), pero
 * NO cubre problemas de:
 *   · Setup Docker: ¿arranca el CI con la env correcta?
 *   · Grants faltantes en tablas nuevas (defensive default privileges)
 *   · Casos donde `SET ROLE` bypassea algo que el pool directo no
 *
 * Este file corre en un job CI SEPARADO (`nosuperuser-rls` en ci.yml) donde
 * el pool se conecta directo como `ipro_app` NOSUPERUSER — misma condición
 * que prod. Si el setup del CI está roto (env faltante, script no corrió,
 * etc.), este suite falla el CI antes del merge.
 *
 * Cuándo skipea: si `DATABASE_URL_NOSUPERUSER` no está en el env, el suite
 * se skipea (localmente, o en el job `test` normal que NO tiene este var).
 * Solo el job dedicado del CI lo tiene seteado.
 *
 * Setup:
 *   1. Job CI corre `scripts/ci-setup-app-role.sql` DESPUÉS de las migrations
 *      (que se aplican con el superuser default `ipro`).
 *   2. Setea `DATABASE_URL_NOSUPERUSER=postgresql://ipro_app:...@localhost/db`.
 *   3. Este suite corre con jest y valida el escenario real.
 */

const { Pool } = require('pg');
const { TABLAS_TENANT_SCOPED } = require('../src/lib/rlsCanonical');

const NOSUPERUSER_URL = process.env.DATABASE_URL_NOSUPERUSER;

// Skip todo el file si no está la env. Corre solo en el job dedicado del CI.
const describeIfNosuperuser = NOSUPERUSER_URL ? describe : describe.skip;

describeIfNosuperuser('Pool conectado directo como NOSUPERUSER (Plataforma P1-2)', () => {
  let pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: NOSUPERUSER_URL });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  // ─── Sanity: el role es efectivamente NOSUPERUSER ───
  it('el role de conexión es NOSUPERUSER (no bypassea RLS)', async () => {
    const { rows } = await pool.query(
      `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`
    );
    expect(rows[0]).toBeDefined();
    expect(rows[0].rolsuper).toBe(false);
  });

  // ─── Todas las tablas canónicas tienen FORCE RLS ───
  //
  // assertRlsCoverage() del startup lo valida a nivel app, pero acá lo
  // replicamos como test explícito para que el CI muestre EN CLARO qué
  // tabla está mal si algo falla.
  it('todas las TABLAS_TENANT_SCOPED tienen forcerowsecurity=true', async () => {
    const { rows } = await pool.query(
      `SELECT pg_class.relname AS tablename,
              pg_class.relforcerowsecurity AS forced
         FROM pg_class
         JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
        WHERE pg_namespace.nspname = 'public'
          AND pg_class.relname = ANY($1::text[])`,
      [TABLAS_TENANT_SCOPED]
    );
    const missing = [];
    for (const t of TABLAS_TENANT_SCOPED) {
      const row = rows.find(r => r.tablename === t);
      if (!row || !row.forced) missing.push(t);
    }
    expect(missing).toEqual([]);
  });

  // ─── Todas las tablas canónicas tienen policy tenant_isolation ───
  it('todas las TABLAS_TENANT_SCOPED tienen policy `tenant_isolation`', async () => {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname = 'tenant_isolation'
          AND tablename = ANY($1::text[])`,
      [TABLAS_TENANT_SCOPED]
    );
    const found = new Set(rows.map(r => r.tablename));
    const missing = TABLAS_TENANT_SCOPED.filter(t => !found.has(t));
    expect(missing).toEqual([]);
  });

  // ─── Fail-closed: SELECT sin tenant seteado → 0 rows visibles ───
  //
  // Escenario del incident F1 (2026-07-09): una migration hace SELECT/UPDATE
  // sobre tabla FORCE RLS sin haber seteado app.current_tenant → RLS filtra
  // todo → 0 rows visibles. Bajo superuser esto pasaría a "todas las rows"
  // (bypass), enmascarando el bug.
  it('FORCE RLS bloquea SELECT sin `app.current_tenant` seteado', async () => {
    const client = await pool.connect();
    try {
      // Reset explícito por si el pool reusa una conexión con GUC previa.
      await client.query(`RESET app.current_tenant`);
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM metodos_pago WHERE deleted_at IS NULL`
      );
      // metodos_pago se puebla al seedearse el tenant test — con RLS
      // fail-closed sin tenant seteado → 0.
      expect(rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  // ─── Con tenant seteado, ve solo las filas de ese tenant ───
  it('SET LOCAL app.current_tenant = 1 devuelve solo tenant=1', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = 1`);
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE tenant_id <> 1)::int AS wrong_tenant
         FROM metodos_pago WHERE deleted_at IS NULL`
      );
      expect(rows[0].n).toBeGreaterThan(0);
      expect(rows[0].wrong_tenant).toBe(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  // ─── INSERT sin tenant seteado → rechazado por WITH CHECK ───
  //
  // El escenario "backfill sin tenant" que rompió F1 y #347. La policy
  // WITH CHECK con PREDICATE_CLOSED evalúa `tenant_id = NULLIF(...)::int`
  // como false cuando la GUC no está seteada → INSERT rechazado con 42501.
  it('INSERT sin `app.current_tenant` seteado → error 42501 (RLS policy)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`RESET app.current_tenant`);
      // Intentamos INSERT en cualquier tabla del scope. Usamos `alertas_config`
      // que es la que rompió #347 — el bug histórico está reproducido acá.
      let caughtError = null;
      try {
        await client.query(
          `INSERT INTO alertas_config (tenant_id, tipo, activa, parametros)
           VALUES (1, 'nosuperuser_pool_test', true, '{}'::jsonb)`
        );
      } catch (err) {
        caughtError = err;
      }
      expect(caughtError).not.toBeNull();
      expect(caughtError.code).toBe('42501');
      expect(caughtError.message).toMatch(/row-level security policy/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

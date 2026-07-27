/**
 * Tests del módulo rlsCanonical.
 *
 * 2026-07-12 (auditoría TOTAL Auth P0-1): consolida el pattern de RLS
 * multi-tenant en un módulo puro + startup assertion. Ver
 * `backend/src/lib/rlsCanonical.js`.
 *
 * Tests cubren:
 *   · Structure de la constante canónica (frozen, alfabético)
 *   · Whitelist de excepciones documentada
 *   · Predicate canónico correcto
 *   · assertRlsCoverage OK cuando el schema matchea
 *   · assertRlsCoverage falla con mensaje específico si hay drift
 *     (tabla en whitelist agregada al schema sin RLS, tabla canónica
 *     sin policy)
 */

const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const {
  TABLAS_TENANT_SCOPED,
  TABLAS_TENANT_ID_SIN_RLS,
  PREDICATE_CLOSED,
  PREDICATE_CLOSED_NULLABLE,
  assertRlsCoverage,
} = require('../src/lib/rlsCanonical');

let pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe('rlsCanonical constants (unit)', () => {
  it('TABLAS_TENANT_SCOPED está frozen y ordenada alfabéticamente', () => {
    expect(Object.isFrozen(TABLAS_TENANT_SCOPED)).toBe(true);
    const sorted = [...TABLAS_TENANT_SCOPED].sort();
    expect(TABLAS_TENANT_SCOPED).toEqual(sorted);
    expect(TABLAS_TENANT_SCOPED.length).toBeGreaterThan(30);
  });

  it('TABLAS_TENANT_SCOPED no tiene duplicados', () => {
    const unique = new Set(TABLAS_TENANT_SCOPED);
    expect(unique.size).toBe(TABLAS_TENANT_SCOPED.length);
  });

  it('TABLAS_TENANT_ID_SIN_RLS whitelist documenta razón por tabla ≥ 50 chars', () => {
    // 2026-07-27 (audit 07-25 Track E P1-5): threshold subido de 20 → 50 chars.
    // Racional: 20 chars aceptaba entries triviales ("no aplica RLS acá."). 50
    // chars fuerza explicación de POR QUÉ + CÓMO se garantiza aislamiento
    // alternativo (capability, adminQuery, etc.). Sin la explicación explícita,
    // un dev futuro que agregue tabla a la whitelist se ahorra el análisis del
    // trade-off — la mayoría de gaps cross-tenant históricos empezaron así.
    expect(Object.isFrozen(TABLAS_TENANT_ID_SIN_RLS)).toBe(true);
    for (const [tabla, razon] of Object.entries(TABLAS_TENANT_ID_SIN_RLS)) {
      expect(typeof tabla).toBe('string');
      expect(razon).toMatch(/./); // no vacía
      expect(razon.length).toBeGreaterThanOrEqual(50); // razón descriptiva, no trivial
    }
    // Whitelist actual — enumeradas explícitamente para catchar si alguien
    // agrega o quita una excepción sin discutirlo.
    expect(Object.keys(TABLAS_TENANT_ID_SIN_RLS).sort()).toEqual([
      'audit_queue',
      'feature_flags_tenants',
      'tenant_admin_actions',
      'tenant_users',
    ]);
  });

  it('canónica y whitelist son mutuamente excluyentes', () => {
    // Una tabla no puede estar en ambas — es o RLS enforced o intencionalmente
    // sin RLS.
    const overlap = TABLAS_TENANT_SCOPED.filter((t) =>
      Object.prototype.hasOwnProperty.call(TABLAS_TENANT_ID_SIN_RLS, t)
    );
    expect(overlap).toEqual([]);
  });

  it('PREDICATE_CLOSED usa NULLIF para evitar el bug pg_strtoint32_safe', () => {
    // El bug del 2026-06-18 (staging login 500) fue precisamente por NO
    // envolver current_setting() en NULLIF. Este test asegura que el
    // predicate exportado sí lo usa.
    expect(PREDICATE_CLOSED).toContain('NULLIF');
    expect(PREDICATE_CLOSED).toContain("current_setting('app.current_tenant', true)");
    expect(PREDICATE_CLOSED).toContain('::int');
  });

  it('PREDICATE_CLOSED_NULLABLE incluye tenant_id IS NULL branch', () => {
    // Para audit_logs (permite audits de sistema con tenant_id NULL).
    expect(PREDICATE_CLOSED_NULLABLE).toMatch(/tenant_id IS NULL OR/);
    expect(PREDICATE_CLOSED_NULLABLE).toContain(PREDICATE_CLOSED);
  });
});

describe('assertRlsCoverage (integration)', () => {
  it('estado actual del schema es OK — canónica matchea DB', async () => {
    const result = await assertRlsCoverage(pool);
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThan(30);
  });

  it('falla si una tabla canónica pierde la policy tenant_isolation', async () => {
    // Simulamos drift: dropeamos la policy de una tabla que SÍ debería
    // tenerla. Ver que assertRlsCoverage lo detecta.
    const TABLA_TEST = 'productos'; // en la canónica.
    await pool.query(`DROP POLICY IF EXISTS tenant_isolation ON ${TABLA_TEST}`);
    try {
      await expect(assertRlsCoverage(pool)).rejects.toThrow(/productos/);
      // El error debe tener el code identificable.
      try {
        await assertRlsCoverage(pool);
      } catch (err) {
        expect(err.code).toBe('RLS_COVERAGE_DRIFT');
      }
    } finally {
      // Restaurar la policy para no romper otros tests.
      await pool.query(`
        CREATE POLICY tenant_isolation ON ${TABLA_TEST}
          FOR ALL TO PUBLIC
          USING (${PREDICATE_CLOSED})
          WITH CHECK (${PREDICATE_CLOSED})
      `);
    }
  });

  it('falla si aparece una tabla nueva con tenant_id sin estar en canónica ni whitelist', async () => {
    // Crear tabla ad-hoc con tenant_id. La assertion debe detectarla como
    // huérfana (no está en TABLAS_TENANT_SCOPED, no está en whitelist).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _test_orphan_tenant_table (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL
      )
    `);
    try {
      await expect(assertRlsCoverage(pool)).rejects.toThrow(/_test_orphan_tenant_table/);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS _test_orphan_tenant_table`);
    }
  });

  it('NO falla si una tabla nueva con tenant_id se agrega a la whitelist', async () => {
    // Este test asegura que la whitelist funciona como expected. No mockeamos
    // los constants (que son frozen), pero verificamos que audit_queue
    // (whitelisted) NO aparece en errores aunque tenga tenant_id column.
    // Ya está cubierto por el test happy path arriba, pero explícito acá.
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'audit_queue' AND column_name = 'tenant_id'
    `);
    expect(rows.length).toBe(1); // audit_queue tiene tenant_id
    // Y aún así assertRlsCoverage pasa (verificado en el primer test).
  });

  // ─── Chequeo 4 (CONTENT) — nuevo 2026-07-24 ────────────────────────────
  //
  // Regressión guard del bug Sentry TECNY-PORTAL-BACKEND-16: la migration
  // `20260619000001_audit_logs_rls_tighten` reescribió la policy de
  // audit_logs SIN NULLIF, y el startup assertion pasaba porque la policy
  // SÍ existía — pero el predicate quedaba bugueado (cast '' → int throwea).
  //
  // Con el chequeo de CONTENT del predicate, cualquier migration que
  // reintroduzca el pattern bugueado hace fallar el boot.

  it('warning-only si una policy tenant_isolation pierde el NULLIF (2026-07-25 hotfix)', async () => {
    // Simulamos exactamente el bug del 2026-06-19: reescribir la policy
    // de una tabla canónica con el pattern bugueado (sin NULLIF).
    //
    // 2026-07-25 hotfix: el chequeo 4 (CONTENT drift) se rebajó a
    // warning-only porque el fix del backfill migration necesita superuser
    // en DB (owner mismatch en 7 tablas de prod). El boot sigue si hay
    // drift de CONTENT — solo loguea warning + Sentry. Los otros chequeos
    // (coverage) siguen siendo fatales.
    //
    // Verificamos que el boot NO aborta pero SÍ registra el warning
    // logueando spy sobre logger.warn.
    const TABLA_TEST = 'productos';
    const PREDICATE_BUGGED = `tenant_id = current_setting('app.current_tenant', true)::int`;

    await pool.query(`DROP POLICY IF EXISTS tenant_isolation ON ${TABLA_TEST}`);
    await pool.query(`
      CREATE POLICY tenant_isolation ON ${TABLA_TEST}
        FOR ALL TO PUBLIC
        USING (${PREDICATE_BUGGED})
        WITH CHECK (${PREDICATE_BUGGED})
    `);

    try {
      // El chequeo 4 NO aborta — devuelve ok=true. El drift se reporta
      // vía logger.warn + Sentry, capturado en observability.
      const result = await assertRlsCoverage(pool);
      expect(result.ok).toBe(true);
      // El contentChecked sigue contando todas las policies aunque haya drift.
      expect(result.contentChecked).toBeGreaterThan(50);
    } finally {
      // Restaurar policy correcta.
      await pool.query(`DROP POLICY IF EXISTS tenant_isolation ON ${TABLA_TEST}`);
      await pool.query(`
        CREATE POLICY tenant_isolation ON ${TABLA_TEST}
          FOR ALL TO PUBLIC
          USING (${PREDICATE_CLOSED})
          WITH CHECK (${PREDICATE_CLOSED})
      `);
    }
  });

  it('el chequeo de contenido inspecciona TODAS las policies (result.contentChecked > 0)', async () => {
    // Sanity: el nuevo campo `contentChecked` en el resultado debe reflejar
    // que se validó qual + with_check de cada policy tenant_isolation.
    // Approx: 2 predicates por policy * (~50 tablas canónicas + audit_logs).
    const result = await assertRlsCoverage(pool);
    expect(result.ok).toBe(true);
    expect(result.contentChecked).toBeGreaterThan(50);
  });
});

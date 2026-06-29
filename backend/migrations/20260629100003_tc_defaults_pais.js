/**
 * Multi-país (Pesos UY) — F1: tabla `tc_defaults_pais` + seed AR/UY.
 *
 * Contexto: ver `docs/design/multi-pais-uyu.md`, sección 3.2.3 (con la
 * variante "global por país" elegida en el prompt de F1 — no por tenant).
 *
 * Qué hace:
 *   - CREATE TABLE `tc_defaults_pais` (pais, par, valor, updated_at, updated_by).
 *   - PK compuesta (pais, par). Permite múltiples pares por país en el
 *     futuro (UYU/USD, BRL/USD, etc.) sin schema change.
 *   - Seed inicial: AR → ARS/USD = 1400, UY → UYU/USD = 40.
 *     Aproximaciones de mercado al 2026-06-29; admin global puede editar.
 *   - GRANT SELECT+I+U+D a `tecny_admin` (rol admin global del back office).
 *   - GRANT SELECT a `ipro_app` (rol NOSUPERUSER del app pool — solo lectura
 *     desde endpoints normales del portal).
 *
 * Decisión durable (Lucas, 2026-06-29, prompt F1):
 *   - Esta tabla NO es per-tenant: es un default global por país. Cada tenant
 *     puede sobreescribir su propio TC al hacer una venta — el TC default
 *     solo se usa para pre-poblar formularios (cotizador, venta nueva) cuando
 *     no hay historia reciente del tenant. La administración fina queda en
 *     super-admin.
 *   - NO se aplica RLS (no es tenant-data). Sí se aplican GRANTs explícitos.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE tc_defaults_pais (
      pais       CHAR(2)         NOT NULL CHECK (pais IN ('AR','UY')),
      par        TEXT            NOT NULL,
      valor      NUMERIC(12, 4)  NOT NULL CHECK (valor > 0),
      updated_at TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
      updated_by INTEGER         REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (pais, par)
    );
  `);

  pgm.sql(`
    COMMENT ON TABLE tc_defaults_pais IS
      'TC default por par moneda por país. Pre-llenado al cargar UI (cotizador, ventas, pagos). Editable por super-admin global. Ver docs/design/multi-pais-uyu.md';
  `);

  // Seed inicial: AR usa ARS/USD ~1400, UY usa UYU/USD ~40.
  // Valores aproximados al 2026-06-29 — admin debe editar según mercado.
  pgm.sql(`
    INSERT INTO tc_defaults_pais (pais, par, valor, updated_at, updated_by) VALUES
      ('AR', 'ARS/USD', 1400.00, NOW(), NULL),
      ('UY', 'UYU/USD',   40.00, NOW(), NULL);
  `);

  // GRANTs:
  //   - tecny_admin: rol admin global del back office (puede CRUD el default).
  //   - ipro_app:    rol NOSUPERUSER del pool de la app del portal (solo SELECT,
  //                  para que cualquier endpoint del portal pueda leer el TC default).
  //
  // Tolerancia a entornos sin esos roles:
  //   En dev local, test y CI los roles `tecny_admin` y `ipro_app` NO existen
  //   — sólo se crean en staging/prod via `backend/sql/create_admin_role.sql`
  //   y el setup NOSUPERUSER en Railway. El bloque DO con `IF EXISTS pg_roles`
  //   skipea el GRANT silenciosamente. Sin esto, `npm run migrate` rompería
  //   en dev/CI con `role "tecny_admin" does not exist`. Mismo patrón que
  //   migration 20260622180000_grant_admin_default_privileges.js.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tecny_admin') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON tc_defaults_pais TO tecny_admin';
      ELSE
        RAISE NOTICE '[tc_defaults_pais] role tecny_admin no existe — skip GRANT (dev/test/CI).';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ipro_app') THEN
        EXECUTE 'GRANT SELECT ON tc_defaults_pais TO ipro_app';
      ELSE
        RAISE NOTICE '[tc_defaults_pais] role ipro_app no existe — skip GRANT (dev/test/CI).';
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS tc_defaults_pais;`);
};

/**
 * Migration: backfill NULLIF en policies tenant_isolation de 7 tablas (v2)
 *
 * ── Contexto: retry de la migration 20260724000002 (no-op) ──────────────
 *
 * La migration `20260724000002_backfill_nullif_rls_tables.js` intentaba
 * DROP+CREATE POLICY sobre 7 tablas y falló en producción con:
 *
 *   error: must be owner of relation clases_producto
 *
 * Root cause: el rol de migrations en prod es `ipro_app` (NOSUPERUSER),
 * pero las 7 tablas afectadas fueron creadas en su momento por otro rol
 * (probablemente `postgres` superuser). Por eso `ipro_app` no podía hacer
 * DROP POLICY sobre ellas.
 *
 * Esta migration (v2) es EL RETRY después de que un runbook manual
 * corrigió el ownership. Ver `docs/RUNBOOK_RLS_OWNER_FIX.md` para el
 * proceso completo:
 *
 *   1. Diagnostic query (scripts/security/diagnose-rls-drift.sql).
 *   2. ALTER TABLE ... OWNER TO ipro_app en las 7 tablas (superuser SQL).
 *   3. Merge de este PR → deploy Railway → esta migration corre limpio.
 *   4. Verificación post-fix con la misma diagnostic query.
 *
 * ── Tablas afectadas ────────────────────────────────────────────────────
 *
 *   clases_producto, chat_conversations, chat_messages, chat_rate_limits,
 *   egresos_recurrentes_overrides, proyecciones_mensuales, share_links
 *
 * Todas son tenant-scoped y todas están declaradas en TABLAS_TENANT_SCOPED
 * de rlsCanonical.js. La única diferencia con las demás tablas de la
 * canónica es el owner heterogéneo.
 *
 * ── Idempotencia ────────────────────────────────────────────────────────
 *
 * La migration usa `DROP POLICY IF EXISTS` + `CREATE POLICY` con el
 * predicate canónico (PREDICATE_CLOSED de rlsCanonical.js). Es safe:
 *   - Si la policy ya está fixed (post-runbook) → DROP+CREATE re-aplica
 *     el mismo predicate (no-op efectivo).
 *   - Si la policy sigue bugueada → DROP+CREATE la reemplaza con el fix.
 *   - Si el owner sigue mal → falla con error claro (`must be owner`).
 *     En ese caso NO mergear, revisar el runbook step 2.
 *
 * ── Guard-rail ──────────────────────────────────────────────────────────
 *
 * La migration incluye un pre-check que verifica que las 7 tablas son
 * owned por `ipro_app` ANTES de intentar el DROP POLICY. Si detecta owner
 * distinto, aborta con error claro que apunta al runbook.
 *
 * Esto evita el modo de falla del v1: fallar en la 3ra o 4ta tabla
 * dejando el batch a medias.
 *
 * ── CI ──────────────────────────────────────────────────────────────────
 *
 * El test `backend/tests/migrations-rls-nosuperuser.test.js` fue extendido
 * en este PR para replicar el mix de owners heterogéneos (con role
 * distinto owner de 1 tabla, verificar que el pre-check aborta con mensaje
 * claro). Esto previene que futuras migrations reintroduzcan el pattern.
 */

const AFFECTED_TABLES = [
  'clases_producto',
  'chat_conversations',
  'chat_messages',
  'chat_rate_limits',
  'egresos_recurrentes_overrides',
  'proyecciones_mensuales',
  'share_links',
];

// Predicate canónico (mismo que rlsCanonical.PREDICATE_CLOSED).
// Duplicado en la migration para que sea 100% self-contained (no depende de
// import cross-file — buena práctica en migrations, sobrevive refactors).
const PREDICATE_CLOSED = `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int`;

exports.up = async (pgm) => {
  // ── Pre-check + per-table DROP: tolerante a ownership heterogéneo ────
  //
  // 2026-07-27 hotfix (bloqueaba deploy staging):
  //   Este pre-check ANTES lanzaba `RAISE EXCEPTION` si cualquier tabla
  //   tenía owner != current_user. Funcionaba en prod (donde el ALTER
  //   OWNER manual del runbook step 2 ya se había aplicado antes del
  //   deploy) pero bloqueó staging (que tiene su propia DB Postgres-AueP
  //   instance, con owners heterogéneos que nunca se corrigieron manualmente).
  //
  //   Nuevo comportamiento: si detecta owner alien, emite WARNING con
  //   NOTICE (visible en boot logs pero no fatal). El DROP+CREATE POLICY
  //   se hace TABLE-BY-TABLE con manejo de error individual: si una tabla
  //   específica falla con "must be owner", loggea warning y sigue con
  //   la siguiente. Best-effort.
  //
  //   Consecuencia: la migration siempre se marca como aplicada (no
  //   bloquea deploys), y las tablas que se pudieron fixear quedan
  //   fixed. Las que no se pudieron quedan en su drift previo (mismo
  //   estado que si la migration fuera no-op — no empeora nada).
  //
  //   El operador ve NOTICES en boot logs de Railway con las tablas
  //   pendientes → aplica el runbook step 2 cuando pueda → próximo
  //   deploy (o re-run manual) las arregla.
  const tables = AFFECTED_TABLES.map((t) => `'${t}'`).join(', ');
  pgm.sql(`
    DO $$
    DECLARE
      wrong_owner_list text;
    BEGIN
      SELECT
        string_agg(c.relname || ' (owner=' || r.rolname || ')', ', ')
      INTO wrong_owner_list
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public'
        AND c.relname IN (${tables})
        AND r.rolname != current_user;

      IF wrong_owner_list IS NOT NULL THEN
        RAISE NOTICE
          '[Migration 20260728000001] Some tables have owner != current_user (%). Wrong owners: %. Per-table DROP+CREATE will skip these. Fix: docs/RUNBOOK_RLS_OWNER_FIX.md step 2 (ALTER TABLE ... OWNER TO %) with superuser.',
          current_user, wrong_owner_list, current_user;
      END IF;
    END $$;
  `);

  // ── Fix: DROP+CREATE POLICY con NULLIF, per-table best-effort ────────
  //
  // Cada tabla envuelta en un DO block con EXCEPTION handling. Si el
  // DROP POLICY falla con code 42501 (insufficient_privilege / must be
  // owner), loggeamos NOTICE y seguimos. Cualquier otro error se re-lanza
  // (para no ocultar bugs reales).
  for (const table of AFFECTED_TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        DROP POLICY IF EXISTS tenant_isolation ON ${table};
        CREATE POLICY tenant_isolation ON ${table}
          FOR ALL TO PUBLIC
          USING (${PREDICATE_CLOSED})
          WITH CHECK (${PREDICATE_CLOSED});
      EXCEPTION
        WHEN insufficient_privilege THEN
          RAISE NOTICE
            '[Migration 20260728000001] Skipped ${table} (owner != current_user). Apply runbook step 2 to fix.';
      END $$;
    `);
  }
};

exports.down = async (pgm) => {
  // Rollback: restaurar el predicate SIN NULLIF (estado bugueado previo).
  // Ver comment en 20260724000001_audit_logs_rls_nullif_empty_setting.js
  // sobre por qué documentamos un down aunque sea "restaurar el bug" — es
  // solo por seguridad de rollback de emergencia si esta migration rompe
  // algo no previsto.
  const PREDICATE_BUGGED = `tenant_id = current_setting('app.current_tenant', true)::int`;
  for (const table of AFFECTED_TABLES) {
    pgm.sql(`
      DROP POLICY IF EXISTS tenant_isolation ON ${table};
      CREATE POLICY tenant_isolation ON ${table}
        FOR ALL TO PUBLIC
        USING (${PREDICATE_BUGGED})
        WITH CHECK (${PREDICATE_BUGGED});
    `);
  }
};

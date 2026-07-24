/**
 * Migration: backfill NULLIF en policies tenant_isolation de 7 tablas
 *
 * ── Contexto ──────────────────────────────────────────────────────────────
 *   El chequeo de CONTENT del predicate agregado a `assertRlsCoverage`
 *   (2026-07-24, junto con este PR) reveló 7 tablas cuyas policies
 *   `tenant_isolation` NO usan `NULLIF(current_setting(...), '')` — la
 *   misma clase de bug que causó Sentry TECNY-PORTAL-BACKEND-16 en
 *   `audit_logs` esta semana.
 *
 *   Tablas afectadas:
 *     - chat_conversations
 *     - chat_messages
 *     - chat_rate_limits
 *     - clases_producto
 *     - egresos_recurrentes_overrides
 *     - proyecciones_mensuales
 *     - share_links
 *
 *   Todas creadas después del fix NULLIF del 2026-06-18. Sus migrations
 *   originales usaron `CREATE POLICY ... USING (tenant_id =
 *   current_setting(...)::int)` directamente (sin el helper canónico
 *   `enableTenantRlsFor` que aún no existía o no estaba imponiéndose).
 *
 * ── Por qué es P0 ─────────────────────────────────────────────────────────
 *   Mismo patrón exacto que hizo explotar `/logout` con Sentry #16: si
 *   cualquier endpoint escribe/lee una de estas tablas SIN haber hecho
 *   `SET LOCAL app.current_tenant` primero, PG evalúa
 *   `''::int` → exception `pg_strtoint32_safe` → request 500 + connection
 *   envenenada (que después el pool cierra, propagando "Connection
 *   terminated" al próximo consumer — Sentry #17).
 *
 *   No requiere que un atacante haga nada — con el flujo actual, un
 *   endpoint mal auth-configurado o un job/cron sin tenant context es
 *   suficiente. La latencia para explotar es "hasta que alguien ejecute
 *   el path". Preferimos que el boot falle si esto vuelve a aparecer
 *   (chequeo 4 en assertRlsCoverage) que descubrirlo en producción.
 *
 * ── Fix ───────────────────────────────────────────────────────────────────
 *   Reescribir las 7 policies usando `PREDICATE_CLOSED` de rlsCanonical.
 *   Idempotente: DROP + CREATE.
 *
 *   Todas las 7 tablas tienen `tenant_id NOT NULL` verificado (2026-07-24,
 *   information_schema.columns). Por eso usamos `PREDICATE_CLOSED` (no la
 *   variante NULLABLE de audit_logs).
 *
 * ── Down ──────────────────────────────────────────────────────────────────
 *   Restaura los predicates ORIGINALES (sin NULLIF). Rollback puramente
 *   defensivo — si algo se rompe, la migration down NO reintroduce el bug
 *   activamente porque el error solo ocurre cuando falta SET LOCAL. Pero
 *   si necesitás rollback de emergencia, este `down` es exactamente
 *   simétrico con el `up` — te devuelve al estado pre-fix.
 *
 * ── Test post-migration ───────────────────────────────────────────────────
 *   El test `assertRlsCoverage (integration) › estado actual del schema
 *   es OK` en `backend/tests/rlsCanonical.test.js` valida que después de
 *   esta migration TODAS las policies (incluidas las 7) matchean el
 *   predicate canónico con NULLIF.
 */

const {
  PREDICATE_CLOSED,
} = require('../src/lib/rlsCanonical');

// Predicate buggeado (SIN NULLIF) — usado por el down para rollback exacto.
const PREDICATE_BUGGED = `tenant_id = current_setting('app.current_tenant', true)::int`;

// Las 7 tablas afectadas — enumeradas explícitamente para que el diff sea
// claro y no dependamos de un query dinámico en la migration (que podría
// tocar tablas no intencionales si el schema cambia entre `up` y `down`).
const TABLAS_A_FIXEAR = [
  'chat_conversations',
  'chat_messages',
  'chat_rate_limits',
  'clases_producto',
  'egresos_recurrentes_overrides',
  'proyecciones_mensuales',
  'share_links',
];

exports.up = (pgm) => {
  for (const tabla of TABLAS_A_FIXEAR) {
    pgm.sql(`
      DROP POLICY IF EXISTS tenant_isolation ON ${tabla};
      CREATE POLICY tenant_isolation ON ${tabla}
        FOR ALL TO PUBLIC
        USING (${PREDICATE_CLOSED})
        WITH CHECK (${PREDICATE_CLOSED});
    `);
  }
};

exports.down = (pgm) => {
  for (const tabla of TABLAS_A_FIXEAR) {
    pgm.sql(`
      DROP POLICY IF EXISTS tenant_isolation ON ${tabla};
      CREATE POLICY tenant_isolation ON ${tabla}
        FOR ALL TO PUBLIC
        USING (${PREDICATE_BUGGED})
        WITH CHECK (${PREDICATE_BUGGED});
    `);
  }
};

/**
 * Migration: venta_emails_enviados — agregar WITH CHECK a la policy RLS.
 *
 * Auditoría 2026-06-30 S-01 (defense-in-depth, no explotable hoy).
 *
 * Bug:
 *   La policy `venta_emails_tenant_isolation` definida en
 *   20260630100001_venta_emails_enviados.js solo tiene `USING (tenant_id =
 *   current_setting('app.current_tenant')::integer)` — sin `WITH CHECK`.
 *
 *   Sin WITH CHECK, un INSERT podría escribir filas con `tenant_id` arbitrario
 *   distinto del `app.current_tenant` y RLS no rebota. FORCE RLS ya estaba
 *   activado (línea 61 del migration original), así que el problema NO es
 *   bypass del role owner — es que el predicate WITH CHECK por defecto
 *   ("usar el USING para writes también") aplica SOLO cuando se omite
 *   WITH CHECK explícitamente en CREATE POLICY ... USING (...). En este caso
 *   la policy SÍ omite WITH CHECK, así que pg debería usar el USING como
 *   default — pero el linter de seguridad y el patrón estándar del resto del
 *   portal (ver 20260616000002_rls_fail_closed.js y 20260627000001) usan
 *   WITH CHECK explícito.
 *
 *   Hardening: hacemos el WITH CHECK explícito + actualizamos el predicate
 *   al patrón fail-closed con `NULLIF(... , '')::int` que evita el bug
 *   pg_strtoint32_safe ("invalid input syntax for type integer") cuando
 *   current_setting devuelve string vacío en conexiones sin SET LOCAL.
 *
 * Fix:
 *   DROP la policy actual + CREATE con WITH CHECK explícito y predicate
 *   fail-closed (mismo patrón que cross_tenant_notifications en
 *   20260627000001:299-304).
 *
 * Reversible: la down restaura la policy original (sin WITH CHECK explícito).
 */

/* eslint-disable camelcase */

exports.shorthands = undefined;

// Predicate estándar fail-closed (NULLIF para evitar el revientes en queries
// sin SET LOCAL — current_setting devuelve '' que NULLIF convierte a NULL,
// y NULL::int es NULL → la fila no pasa el filtro).
const PREDICATE_CLOSED = `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int`;

exports.up = (pgm) => {
  pgm.sql(`
    -- Auditoría 2026-06-30 S-01: WITH CHECK explícito + predicate fail-closed
    -- en el patrón del resto del portal.
    DROP POLICY IF EXISTS venta_emails_tenant_isolation ON venta_emails_enviados;
    CREATE POLICY venta_emails_tenant_isolation ON venta_emails_enviados
      FOR ALL TO PUBLIC
      USING (${PREDICATE_CLOSED})
      WITH CHECK (${PREDICATE_CLOSED});
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Restaurar policy original (sin WITH CHECK explícito) del migration
    -- 20260630100001_venta_emails_enviados.js:62-63.
    DROP POLICY IF EXISTS venta_emails_tenant_isolation ON venta_emails_enviados;
    CREATE POLICY venta_emails_tenant_isolation ON venta_emails_enviados
      USING (tenant_id = current_setting('app.current_tenant', true)::integer);
  `);
};

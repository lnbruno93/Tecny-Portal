/**
 * Migration: audit_logs RLS policy — NULLIF empty setting
 *
 * ── Bug reproducido en prod 2026-07-24 ───────────────────────────────────
 *   TECNY-PORTAL-BACKEND-16 (Sentry):
 *     POST /api/auth/logout → error 500
 *     err.message: 'invalid input syntax for type integer: ""'
 *     err.routine: pg_strtoint32_safe
 *     File: /app/src/lib/audit.js:230 (INSERT INTO audit_logs)
 *
 *   User afectado: nachogarcia (id=46, role=op).
 *
 * ── Root cause ───────────────────────────────────────────────────────────
 *   La migration 20260619000001_audit_logs_rls_tighten reescribió la
 *   policy `tenant_isolation` de `audit_logs` con un predicate SIN NULLIF:
 *
 *     PREDICATE_READ_STRICT = tenant_id = current_setting('app.current_tenant', true)::int
 *
 *   Esto revierte accidentalmente el fix hecho un día antes en la migration
 *   20260618000001_rls_nullif_empty_setting, que había resuelto exactamente
 *   este bug para las OTRAS tablas RLS del sistema (ventas, productos, etc).
 *
 *   El bug se dispara cuando `audit()` corre sin `withTenant`:
 *
 *     - INSERT INTO audit_logs desde /auth/logout usa el pool default (db).
 *     - La conexión libre que toca puede estar "limpia" (sin SET LOCAL
 *       app.current_tenant previo).
 *     - `current_setting('app.current_tenant', true)` retorna `''` (string
 *       vacío) cuando la GUC no existe, NO NULL.
 *     - PG evalúa la RLS WITH CHECK del INSERT → `''::int` → excepción
 *       pg_strtoint32_safe → 500.
 *
 *   Por qué no se detectó antes:
 *     - El audit del logout se agregó en la auditoría TOTAL Auth P1-1
 *       (2026-07-12), casi 1 mes después del "tighten" bugueado.
 *     - Otros callers de audit() ya corren dentro de un `withTenant()` que
 *       hace SET LOCAL, así que sus INSERTs sí matchean el predicate.
 *     - `/logout` es de los pocos endpoints donde audit() corre sin
 *       tenant context establecido en la conexión.
 *
 * ── Fix ──────────────────────────────────────────────────────────────────
 *   Restaurar el pattern del `NULLIF` que ya usan TODAS las otras tablas
 *   RLS (ver migration 20260618000001, línea 89):
 *
 *     tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int
 *
 *   Comportamiento:
 *     - Setting valid (int): NULLIF passa-through → cast OK → match exacto.
 *     - Setting empty '' o no existe: NULLIF → NULL → NULL::int es NULL →
 *       comparación tenant_id = NULL es NULL (no TRUE) → fila no pasa.
 *
 *   Resultado para audit_logs:
 *     - USING (read strict): un SELECT sin SET LOCAL devuelve 0 rows.
 *       Ok — usuarios normales SIEMPRE llegan con SET LOCAL vía requireAuth.
 *     - WITH CHECK (write permissive): un INSERT con tenant_id NOT NULL
 *       sin SET LOCAL previo NO revienta más — la primera parte
 *       `tenant_id IS NULL` es false, la segunda parte con NULLIF ahora
 *       evalúa a NULL (no lanza excepción), y el WITH CHECK entero
 *       resuelve a NULL. El INSERT se rechaza con "row violates check
 *       policy" en vez de un 500 con casting error.
 *
 *   IMPORTANTE: este fix NO cambia la SEGURIDAD del RLS. Antes: exception.
 *   Después: rechazo con mensaje claro. En ambos casos la fila NO se
 *   inserta. Pero exception rompe la request completa; check policy fail
 *   solo rompe el INSERT, y el endpoint puede recuperarse (audit es
 *   fire-and-forget en /logout).
 *
 *   PENDIENTE separado: routes/auth.js:658 tiene un `.catch()` que loguea
 *   el error como warn — el fix del INSERT permite que ese catch se
 *   ejecute limpio en vez de que la request explote. Ver también el
 *   TODO en audit.js:187 sobre pasar tenant_id explícito para /logout,
 *   que sería la solución "canónica" (evitar depender de la connection
 *   state). Este fix del RLS es defense-in-depth compatible con eso.
 *
 * ── Down ─────────────────────────────────────────────────────────────────
 *   Restaura el predicate previo (SIN NULLIF). Rollback de emergencia si
 *   esta migration rompe algo no previsto. La única diferencia observable
 *   sería que los INSERTs sin SET LOCAL vuelven a fallar con exception
 *   en vez de con check-policy error — o sea, se restaura el bug.
 */

// Predicate CON NULLIF (fix).
const PREDICATE_READ_STRICT_FIXED = `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int`;
const PREDICATE_WRITE_PERMISSIVE_FIXED = `tenant_id IS NULL OR (${PREDICATE_READ_STRICT_FIXED})`;

// Predicate SIN NULLIF (estado bugueado del "tighten" 2026-06-19).
const PREDICATE_READ_STRICT_BUGGED = `tenant_id = current_setting('app.current_tenant', true)::int`;
const PREDICATE_WRITE_PERMISSIVE_BUGGED = `tenant_id IS NULL OR (${PREDICATE_READ_STRICT_BUGGED})`;

exports.up = (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
    CREATE POLICY tenant_isolation ON audit_logs
      FOR ALL TO PUBLIC
      USING (${PREDICATE_READ_STRICT_FIXED})
      WITH CHECK (${PREDICATE_WRITE_PERMISSIVE_FIXED});
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
    CREATE POLICY tenant_isolation ON audit_logs
      FOR ALL TO PUBLIC
      USING (${PREDICATE_READ_STRICT_BUGGED})
      WITH CHECK (${PREDICATE_WRITE_PERMISSIVE_BUGGED});
  `);
};

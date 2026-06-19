/**
 * Migration: audit_logs RLS tighten — USING estricto, WITH CHECK permisivo
 *
 * Contexto (2026-06-19):
 *   El leak cross-tenant en /api/historial reportado por Lucas (#336) se
 *   originó porque la policy RLS de `audit_logs` permitía `tenant_id IS NULL`
 *   tanto en USING (lectura) como en WITH CHECK (escritura). La intención
 *   original era permitir "audits del sistema" sin contexto de tenant
 *   (jobs/crons), pero el efecto colateral era que cualquier fila con
 *   tenant_id NULL quedaba visible a TODOS los tenants.
 *
 *   Hoy 82 filas (legacy 16-18 jun, pre-TANDA 0b refactor) estaban NULL y
 *   leakeaban. El hotfix #336 filtró NULL en el SQL del endpoint
 *   /api/historial. Después backfilleamos 81 al tenant correcto via
 *   `user_id → tenant_users` (#337 capa A). Quedó solo 1 fila huérfana
 *   sin user_id (system audit sin attribution clara).
 *
 * Esta migration:
 *   Separa USING y WITH CHECK del policy `tenant_isolation` de `audit_logs`:
 *
 *   - USING (lectura, UPDATE/DELETE filter): solo
 *       `tenant_id = current_setting('app.current_tenant', true)::int`
 *     Sin la cláusula NULL. Resultado: lecturas user-facing NO ven NUNCA
 *     filas con tenant_id NULL — defense in depth permanente, sin depender
 *     de filtros explícitos en cada endpoint.
 *
 *   - WITH CHECK (escritura nueva): mantiene
 *       `tenant_id IS NULL OR tenant_id = current_setting(...)::int`
 *     Permite que jobs/crons sin contexto de tenant sigan insertando audits
 *     del sistema (audit.js → audit() detecta ausencia de req/tenantId y
 *     pasa NULL). Sin esto, perderíamos trazabilidad de eventos de sistema.
 *
 *   Asymmetric USING/CHECK es un pattern PostgreSQL legítimo y documentado
 *   para casos como este: "permitir crear pero no leer".
 *
 * Efecto en runtime:
 *   - `/api/historial` y cualquier endpoint user-facing que lea audit_logs:
 *     ya no ven filas NULL, sin necesitar `AND tenant_id IS NOT NULL` en
 *     cada query (aunque historial.js ya lo tiene, por defensa redundante).
 *   - Jobs y crons que escriben audits sin tenant context: sin cambio,
 *     la WITH CHECK les permite NULL.
 *   - Admin / sysadmin / scripts con superuser bypass: pueden ver/borrar
 *     las filas NULL si necesitan limpieza.
 *
 * Down: restaura el predicate permisivo en ambas direcciones (estado
 *   pre-tighten). Rollback de emergencia si algún path se rompe.
 *
 * Prerrequisito: backfill (#337 capa A) ejecutado en prod antes de aplicar
 *   esta migration. Sin backfill, esta migration "esconde" 82 filas con
 *   data legítima atribuible. Con backfill, solo esconde la fila huérfana
 *   sin user_id (que ES sistema y no tiene attribution posible).
 */

const PREDICATE_READ_STRICT = `tenant_id = current_setting('app.current_tenant', true)::int`;
const PREDICATE_WRITE_PERMISSIVE = `tenant_id IS NULL OR (${PREDICATE_READ_STRICT})`;

exports.up = (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
    CREATE POLICY tenant_isolation ON audit_logs
      FOR ALL TO PUBLIC
      USING (${PREDICATE_READ_STRICT})
      WITH CHECK (${PREDICATE_WRITE_PERMISSIVE});
  `);
};

exports.down = (pgm) => {
  // Restaura el predicate previo (NULL permitido en ambas direcciones).
  // Estado idéntico al que dejaron las migrations 20260615000002 + 20260616000002.
  const PREDICATE_NULLABLE_BOTH = `tenant_id IS NULL OR (${PREDICATE_READ_STRICT})`;
  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
    CREATE POLICY tenant_isolation ON audit_logs
      FOR ALL TO PUBLIC
      USING (${PREDICATE_NULLABLE_BOTH})
      WITH CHECK (${PREDICATE_NULLABLE_BOTH});
  `);
};

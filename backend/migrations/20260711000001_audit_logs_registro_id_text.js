/**
 * 20260711000001_audit_logs_registro_id_text.js
 *
 * Fix bug de trazabilidad descubierto en baseline de tests durante #545.
 *
 * Contexto:
 *   `audit_logs.registro_id` (y su gemelo `audit_queue.registro_id`) fue
 *   creado como INTEGER en la migration original 20260521000001 asumiendo
 *   que TODAS las tablas del schema usarían SERIAL PK. Esa asunción se
 *   mantuvo hasta 2026-07-08 cuando F3.a agregó la tabla `clases_producto`
 *   con UUID PK (gen_random_uuid()).
 *
 *   Post-F3.a, cada INSERT/UPDATE/DELETE sobre clases_producto dispara
 *   una llamada a `audit()` que intenta insertar el UUID como registro_id
 *   INT → PG rebota con:
 *     error: invalid input syntax for type integer: "0ec59595-..."
 *     code: 22P02
 *
 *   El helper `audit()` en lib/audit.js:230-243 tiene un try/catch que
 *   loguea el error a Pino y devuelve — el audit falla SILENCIOSAMENTE
 *   pero la operación principal NO se aborta. Diseño intencional: no
 *   queremos que un problema del audit rompa un INSERT válido de negocio.
 *
 *   Consecuencia: desde el 2026-07-08 (F3.a mergeado), CERO trazabilidad
 *   de cambios sobre `clases_producto`. El operador puede haber creado,
 *   editado o borrado categorías sin dejar registro en audit_logs.
 *
 * Fix:
 *   Cambiar el tipo de `registro_id` de INTEGER a TEXT en ambas tablas.
 *   TEXT acepta:
 *     - Los INTs históricos (se castean implícitamente a string) — sin
 *       pérdida de información, sin costo de migración de datos.
 *     - Los UUIDs de clases_producto y de futuras tablas UUID-PK.
 *     - Cualquier otro identificador string-serializable.
 *
 *   El índice `idx_audit_tabla (tabla, registro_id)` se preserva — PG
 *   permite índices sobre columnas TEXT sin problema. Las queries
 *   existentes (`WHERE tabla = X AND registro_id = Y`) siguen usando el
 *   índice igual, con comparación string en vez de INT.
 *
 * Consideraciones:
 *   - `audit_logs` está PARTITIONED por created_at desde migration
 *     20260611000004. Al hacer ALTER TABLE sobre la tabla padre, PG
 *     propaga automáticamente el cambio a todas las particiones existentes
 *     y a las futuras que se creen (partition inheritance).
 *   - `audit_queue` es una tabla plana (no particionada) — mismo cambio.
 *   - El código en lib/audit.js NO requiere cambios: ya pasa registro_id
 *     como parámetro genérico ($3) sin type coercion. Post-migration,
 *     UUIDs y INTs conviven en la misma columna.
 *
 * Rollback (down):
 *   NO revertible determinísticamente. Si alguna fila de audit_logs post-
 *   migration tiene registro_id con UUID, el cast a INTEGER falla. La
 *   estrategia: si un DBA quiere volver atrás, debe DELETE las filas con
 *   registro_id no-numérico primero, luego ALTER a INTEGER. Documentamos
 *   pero NO implementamos — audit es append-only para trazabilidad.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. audit_logs (particionada). ALTER en la tabla padre propaga
    --    automáticamente a todas las particiones — verificado con
    --    'SELECT relname FROM pg_class WHERE oid IN (SELECT inhrelid FROM
    --    pg_inherits WHERE inhparent = 'audit_logs'::regclass)'.
    ALTER TABLE audit_logs
      ALTER COLUMN registro_id TYPE TEXT
      USING registro_id::TEXT;
  `);

  pgm.sql(`
    -- 2. audit_queue (plana). Mismo cambio.
    ALTER TABLE audit_queue
      ALTER COLUMN registro_id TYPE TEXT
      USING registro_id::TEXT;
  `);

  // El índice idx_audit_tabla se mantiene automáticamente — PG re-scannea
  // la tabla al cambiar el tipo de columna y reconstruye el índice.
  // Verificamos con \d audit_logs post-migration.
};

exports.down = () => {
  // Ver comentario del header. No revertimos porque los UUIDs post-fix
  // no caben en INTEGER. Si un DBA necesita rollback:
  //
  //   DELETE FROM audit_logs WHERE registro_id !~ '^[0-9]+$';
  //   DELETE FROM audit_queue WHERE registro_id !~ '^[0-9]+$';
  //   ALTER TABLE audit_logs ALTER COLUMN registro_id TYPE INTEGER
  //     USING registro_id::INTEGER;
  //   ALTER TABLE audit_queue ALTER COLUMN registro_id TYPE INTEGER
  //     USING registro_id::INTEGER;
  //
  // Documentado, no implementado. Audit es append-only.
  throw new Error(
    'Migration NO reversible determinísticamente. ' +
    'Ver comentario del header y docs/runbooks/rls-bulk-migration.md — ' +
    'los UUIDs de audit post-F3.a no caben en INTEGER.'
  );
};

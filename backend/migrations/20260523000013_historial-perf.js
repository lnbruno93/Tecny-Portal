/**
 * Migración 013: Índices de performance para audit_logs (historial)
 *
 * El endpoint de historial filtra por tabla y acción frecuentemente.
 * Los índices existentes (tabla+registro_id, created_at, user_id) no cubren
 * el patrón de filtro combinado tabla+accion ni el orden created_at+tabla.
 *
 * Nota: CONCURRENTLY no puede usarse dentro de una transacción (node-pg-migrate
 *       corre cada migración en una transacción por defecto). Se omite aquí.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Filtra por módulo y tipo de operación: WHERE tabla = $1 AND accion = $2
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_tabla_accion
      ON audit_logs (tabla, accion)
  `);

  // Filtra por módulo con orden temporal: WHERE tabla = $1 ORDER BY created_at DESC
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_tabla
      ON audit_logs (created_at DESC, tabla)
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS idx_audit_logs_tabla_accion');
  pgm.sql('DROP INDEX IF EXISTS idx_audit_logs_created_tabla');
};

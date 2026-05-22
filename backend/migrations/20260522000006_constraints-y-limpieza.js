/* eslint-disable camelcase */
/**
 * Migración 006 — Constraints de unicidad + limpieza de tabla historial
 *
 * 1. UNIQUE parcial en vendedores.nombre: evita vendedores duplicados
 *    (filtro WHERE deleted_at IS NULL para permitir "reusar" nombres de borrados)
 *
 * 2. UNIQUE parcial en contactos (nombre, apellido, tipo): evita duplicados
 *    silenciosos que rompen la lógica de filtros por nombre
 *
 * 3. DROP TABLE historial: tabla dead code — nunca recibe escrituras.
 *    Toda la trazabilidad va a audit_logs. Eliminar reduce confusión y vacuum overhead.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Unicidad de vendedores activos
    CREATE UNIQUE INDEX IF NOT EXISTS vendedores_nombre_unique_active
      ON vendedores (nombre)
      WHERE deleted_at IS NULL;

    -- 2. Unicidad de contactos activos (nombre + apellido + tipo)
    CREATE UNIQUE INDEX IF NOT EXISTS contactos_nombre_apellido_tipo_unique_active
      ON contactos (nombre, apellido, tipo)
      WHERE deleted_at IS NULL;

    -- 3. Eliminar tabla historial — dead code, reemplazada por audit_logs
    DROP TABLE IF EXISTS historial CASCADE;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS vendedores_nombre_unique_active;
    DROP INDEX IF EXISTS contactos_nombre_apellido_tipo_unique_active;
    -- historial no se restaura en down — los datos ya no existen
  `);
};

/* eslint-disable camelcase */
/**
 * Migración — created_by_user_id en movimientos_cc y proveedor_movimientos
 *
 * Auditoría #B-07: cualquier usuario con permiso `cuentas` o `proveedores`
 * podía borrar movimientos creados por otros (revertía stock y caja del
 * otro user sin restricción). Para bloquear esto necesitamos saber quién
 * creó cada movimiento.
 *
 * Schema:
 *   - `created_by_user_id INTEGER` FK opcional → users(id) ON DELETE SET NULL.
 *     NULL para movimientos legacy (anteriores al deploy) → quedan
 *     editables por cualquier admin como salvavidas.
 *
 * Usage en la ruta:
 *   - POST: insertar `req.user.id` en la nueva columna.
 *   - DELETE: rechazar 403 si `created_by_user_id !== req.user.id AND
 *     req.user.role !== 'admin'`.
 *
 * Backfill: no se hace. Los movimientos viejos quedan NULL y solo admin
 * los puede borrar. Decisión consciente: si fuera necesario, se puede
 * armar un job que mire audit_logs para reconstruir.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE movimientos_cc
      ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

    ALTER TABLE proveedor_movimientos
      ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

    -- Índices para que las queries por user (auditoría / dashboards futuros)
    -- sean rápidas. Parciales para acotar.
    CREATE INDEX IF NOT EXISTS idx_mov_cc_creator
      ON movimientos_cc (created_by_user_id)
      WHERE created_by_user_id IS NOT NULL AND deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_prov_mov_creator
      ON proveedor_movimientos (created_by_user_id)
      WHERE created_by_user_id IS NOT NULL AND deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_mov_cc_creator;
    DROP INDEX IF EXISTS idx_prov_mov_creator;
    ALTER TABLE movimientos_cc          DROP COLUMN IF EXISTS created_by_user_id;
    ALTER TABLE proveedor_movimientos   DROP COLUMN IF EXISTS created_by_user_id;
  `);
};

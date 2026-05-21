/* eslint-disable camelcase */
/**
 * Migración 005 — Soft delete en movimientos_deudas, movimientos_inversiones y vendedores
 *
 * Hasta ahora estas tablas usaban hard DELETE (pérdida irreversible de datos).
 * Las alineamos con el patrón del resto de la app: deleted_at + índice parcial.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE movimientos_deudas      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE movimientos_inversiones ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE vendedores              ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_mov_deudas_active
      ON movimientos_deudas (id) WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_mov_inversiones_active
      ON movimientos_inversiones (id) WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_vendedores_active
      ON vendedores (id) WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_mov_deudas_active;
    DROP INDEX IF EXISTS idx_mov_inversiones_active;
    DROP INDEX IF EXISTS idx_vendedores_active;

    ALTER TABLE movimientos_deudas      DROP COLUMN IF EXISTS deleted_at;
    ALTER TABLE movimientos_inversiones DROP COLUMN IF EXISTS deleted_at;
    ALTER TABLE vendedores              DROP COLUMN IF EXISTS deleted_at;
  `);
};

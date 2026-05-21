/* eslint-disable camelcase */
/**
 * Migración 002 — Soft delete en comprobantes y pagos
 * Agrega columna deleted_at e índice de activos.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE comprobantes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE pagos        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_comprobantes_active ON comprobantes (id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_pagos_active        ON pagos        (id) WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_comprobantes_active;
    DROP INDEX IF EXISTS idx_pagos_active;
    ALTER TABLE comprobantes DROP COLUMN IF EXISTS deleted_at;
    ALTER TABLE pagos        DROP COLUMN IF EXISTS deleted_at;
  `);
};

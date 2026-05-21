/* eslint-disable camelcase */
/**
 * Migración 003 — Revocación de JWT por cambio de contraseña
 * Agrega password_changed_at a users para invalidar tokens emitidos antes del cambio.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users DROP COLUMN IF EXISTS password_changed_at;
  `);
};

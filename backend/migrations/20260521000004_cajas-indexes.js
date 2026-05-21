/* eslint-disable camelcase */
/**
 * Migración 004 — Índices de performance en tablas de cajas
 *
 * movimientos_deudas y movimientos_inversiones se filtran y agrupan
 * frecuentemente por contacto_id. Sin índice, cada GROUP BY del resumen
 * y cada filtro ?contacto_id= hace un full table scan.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Deudas: filtro por contacto + ordenamiento
    CREATE INDEX IF NOT EXISTS idx_mov_deudas_contacto
      ON movimientos_deudas (contacto_id, fecha DESC);

    -- Inversiones: filtro por contacto + ordenamiento
    CREATE INDEX IF NOT EXISTS idx_mov_inversiones_contacto
      ON movimientos_inversiones (contacto_id, fecha DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_mov_deudas_contacto;
    DROP INDEX IF EXISTS idx_mov_inversiones_contacto;
  `);
};

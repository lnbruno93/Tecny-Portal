/* eslint-disable camelcase */
/**
 * Migración 014 — Comprobantes de pago por venta
 *
 * Adjuntos (imágenes/PDF) asociados a una venta. Mismo patrón que `comprobantes`
 * de Financiera: el archivo se guarda como base64 en una columna TEXT (sin storage
 * externo). Se suben de a uno por request para no exceder el límite de body JSON.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS venta_comprobantes (
      id             SERIAL PRIMARY KEY,
      venta_id       INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
      archivo_data   TEXT    NOT NULL,
      archivo_nombre TEXT,
      archivo_tipo   TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_venta_comprobantes_venta ON venta_comprobantes (venta_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS venta_comprobantes CASCADE;`);
};

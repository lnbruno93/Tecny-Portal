/* eslint-disable camelcase */
/**
 * Migración 015 — Plantillas de garantía
 *
 * Textos de garantía reutilizables, guardados por nombre. Cada venta puede elegir
 * cuál aplica (ventas.garantia_id). El comprobante de venta usa esa plantilla
 * (o la marcada por defecto si la venta no tiene una asignada).
 *
 * Se siembran dos plantillas: una general (default) y una para equipos
 * discontinuados por Apple (basada en el modelo del negocio).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS plantillas_garantia (
      id         SERIAL PRIMARY KEY,
      nombre     TEXT NOT NULL,
      texto      TEXT NOT NULL,
      es_default BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_plantillas_garantia_nombre
      ON plantillas_garantia (LOWER(nombre)) WHERE deleted_at IS NULL;

    -- Solo una plantilla puede ser la predeterminada
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plantillas_garantia_default
      ON plantillas_garantia ((es_default)) WHERE es_default = true AND deleted_at IS NULL;

    ALTER TABLE ventas
      ADD COLUMN IF NOT EXISTS garantia_id INTEGER REFERENCES plantillas_garantia(id) ON DELETE SET NULL;

    INSERT INTO plantillas_garantia (nombre, texto, es_default) VALUES
      ('General', E'Este comprobante es tu nota de compra y avala la operación comercial entre partes. No es una factura ni comprobante fiscal.\n\nNos responsabilizamos por 12 meses, desde la fecha de compra, ante cualquier error, falla o mal funcionamiento propio de software y hardware.\n\niPro | Tech Reseller', true),
      ('Apple discontinuado', E'Este comprobante es tu nota de compra y avala la operación comercial entre partes. No es una factura y/o comprobante fiscal.\n\nAl haber adquirido un producto discontinuado por Apple, la garantía del mismo impactó desde la fecha de compra del producto en EEUU; es decir, se encuentra vencida.\n\nAnte el faltante de garantía explícita, nos responsabilizamos por 12 meses desde la fecha de compra ante cualquier error, falla o mal funcionamiento propio de software y hardware.\n\niPro | Tech Reseller', false)
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE ventas DROP COLUMN IF EXISTS garantia_id;
    DROP TABLE IF EXISTS plantillas_garantia CASCADE;
  `);
};

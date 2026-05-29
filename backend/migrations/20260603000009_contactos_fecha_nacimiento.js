/* eslint-disable camelcase */
/**
 * Migración — `fecha_nacimiento` en contactos
 *
 * El form de cliente embebido en Ventas (modal "Nuevo cliente") ahora pide
 * fecha de nacimiento, además de DNI / WhatsApp / email. Eso permite armar
 * tarjeta de cumpleaños / recomendaciones por edad en Data Science a futuro.
 *
 * Nullable: la mayoría de contactos existentes no la tienen y el campo es
 * opcional en el form.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contactos
      ADD COLUMN IF NOT EXISTS fecha_nacimiento DATE;

    COMMENT ON COLUMN contactos.fecha_nacimiento IS
      'Fecha de nacimiento del contacto (opcional). Insumo para Data Science.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE contactos DROP COLUMN IF EXISTS fecha_nacimiento;
  `);
};

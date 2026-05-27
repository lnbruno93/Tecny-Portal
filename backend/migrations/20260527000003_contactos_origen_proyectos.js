// Suma 'proyectos' como origen válido de contacto (alta rápida desde un proyecto).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contactos DROP CONSTRAINT IF EXISTS contactos_origen_check;
    ALTER TABLE contactos ADD CONSTRAINT contactos_origen_check
      CHECK (origen IS NULL OR origen IN ('ventas','b2b','proveedores','envios','manual','proyectos'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE contactos DROP CONSTRAINT IF EXISTS contactos_origen_check;
    ALTER TABLE contactos ADD CONSTRAINT contactos_origen_check
      CHECK (origen IS NULL OR origen IN ('ventas','b2b','proveedores','envios','manual'));
  `);
};

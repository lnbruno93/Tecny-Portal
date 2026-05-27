// Agenda central de contactos — Fase 1.
// Extiende `contactos` con datos de ficha (teléfono, DNI, email) y `origen`
// (de qué módulo provino el contacto). No toca otros módulos: la recolección
// automática desde Ventas/B2B/Proveedores/Envíos llega en una fase posterior.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contactos
      ADD COLUMN IF NOT EXISTS telefono TEXT,
      ADD COLUMN IF NOT EXISTS dni      TEXT,
      ADD COLUMN IF NOT EXISTS email    TEXT,
      ADD COLUMN IF NOT EXISTS origen   TEXT;

    -- origen: de dónde vino el contacto. NULL permitido para registros previos.
    ALTER TABLE contactos DROP CONSTRAINT IF EXISTS contactos_origen_check;
    ALTER TABLE contactos ADD CONSTRAINT contactos_origen_check
      CHECK (origen IS NULL OR origen IN ('ventas','b2b','proveedores','envios','manual'));

    CREATE INDEX IF NOT EXISTS idx_contactos_origen ON contactos (origen) WHERE deleted_at IS NULL;

    -- tipo deja de ser obligatorio a nivel app (la agenda usa default 'cliente');
    -- mantenemos el CHECK de valores válidos.
    ALTER TABLE contactos ALTER COLUMN tipo SET DEFAULT 'cliente';

    -- Permitir el nuevo tool 'contactos' en el CHECK de user_permissions
    ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_tool_check
      CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario','ventas','proveedores','proyectos','contactos'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_tool_check
      CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario','ventas','proveedores','proyectos'));

    ALTER TABLE contactos ALTER COLUMN tipo DROP DEFAULT;
    DROP INDEX IF EXISTS idx_contactos_origen;
    ALTER TABLE contactos DROP CONSTRAINT IF EXISTS contactos_origen_check;
    ALTER TABLE contactos
      DROP COLUMN IF EXISTS telefono,
      DROP COLUMN IF EXISTS dni,
      DROP COLUMN IF EXISTS email,
      DROP COLUMN IF EXISTS origen;
  `);
};

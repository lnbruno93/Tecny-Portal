/* eslint-disable camelcase */
/**
 * Módulo Proyectos — agrupa proyectos y trackea su desarrollo + inversiones.
 *
 *  · proyectos             — nombre, objetivo, fecha de creación.
 *  · proyecto_participantes — participantes del proyecto (desde contactos).
 *  · proyecto_movimientos   — hoja del proyecto: fecha, detalle, categoría,
 *                             monto en $ (ARS) + tc → monto_usd, inversor
 *                             (desde contactos), comentarios.
 *
 * Montos: el $ (ARS) es el dato primario; monto_usd se calcula con tc (igual que
 * Ventas/Financiera). Soft-delete con deleted_at. FKs ON DELETE para no romper.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS proyectos (
      id             SERIAL PRIMARY KEY,
      nombre         TEXT NOT NULL,
      objetivo       TEXT,
      fecha_creacion DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      deleted_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_proyectos_activos ON proyectos (nombre) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS proyecto_participantes (
      proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
      contacto_id INTEGER NOT NULL REFERENCES contactos(id) ON DELETE CASCADE,
      PRIMARY KEY (proyecto_id, contacto_id)
    );

    CREATE TABLE IF NOT EXISTS proyecto_movimientos (
      id                  SERIAL PRIMARY KEY,
      proyecto_id         INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
      fecha               DATE NOT NULL,
      detalle             TEXT,
      categoria           TEXT,
      monto               NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monto >= 0),       -- $ ARS
      tc                  NUMERIC(14,4),                                              -- tipo de cambio
      monto_usd           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monto_usd >= 0),    -- calculado: monto / tc
      inversor_contacto_id INTEGER REFERENCES contactos(id) ON DELETE SET NULL,
      comentarios         TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      deleted_at          TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_proy_mov_proyecto_fecha
      ON proyecto_movimientos (proyecto_id, fecha DESC, id DESC) WHERE deleted_at IS NULL;

    -- Permitir el nuevo tool 'proyectos' en el CHECK de user_permissions
    ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_tool_check
      CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario','ventas','proveedores','proyectos'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_tool_check
      CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario','ventas','proveedores'));
    DROP TABLE IF EXISTS proyecto_movimientos;
    DROP TABLE IF EXISTS proyecto_participantes;
    DROP TABLE IF EXISTS proyectos;
  `);
};

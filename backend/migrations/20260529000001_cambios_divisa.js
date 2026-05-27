// Módulo Cambios de Divisa: cuenta corriente con financieras de cambio.
// Ledger de dos lados (entregamos ARS / recibimos USD), integrado a las cajas.
exports.up = (pgm) => {
  pgm.sql(`
    -- Financieras de cambio (puede haber varias)
    CREATE TABLE IF NOT EXISTS cambio_entidades (
      id         SERIAL PRIMARY KEY,
      nombre     TEXT NOT NULL,
      activo     BOOLEAN NOT NULL DEFAULT true,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_cambio_entidad_nombre
      ON cambio_entidades (lower(nombre)) WHERE deleted_at IS NULL;

    -- Movimientos: 'entrega_ars' (les damos pesos) | 'recibo_usd' (nos devuelven dólares)
    CREATE TABLE IF NOT EXISTS cambio_movimientos (
      id          SERIAL PRIMARY KEY,
      entidad_id  INTEGER NOT NULL REFERENCES cambio_entidades(id) ON DELETE CASCADE,
      fecha       DATE NOT NULL,
      tipo        TEXT NOT NULL CHECK (tipo IN ('entrega_ars','recibo_usd')),
      monto_ars   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monto_ars >= 0),
      tc          NUMERIC(14,4),
      monto_usd   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monto_usd >= 0),
      caja_id     INTEGER REFERENCES metodos_pago(id) ON DELETE SET NULL,
      comentarios TEXT,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      deleted_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cambio_mov_entidad
      ON cambio_movimientos (entidad_id, fecha DESC, id DESC) WHERE deleted_at IS NULL;

    -- El ledger acepta los nuevos orígenes 'cambio' y 'tarjeta'
    ALTER TABLE caja_movimientos DROP CONSTRAINT IF EXISTS caja_movimientos_origen_check;
    ALTER TABLE caja_movimientos ADD CONSTRAINT caja_movimientos_origen_check
      CHECK (origen IN ('venta','b2b','financiera','envio','egreso','proveedor','ajuste','transferencia','cambio','tarjeta'));

    -- Permitir el nuevo tool 'cambios'
    ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_tool_check
      CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario','ventas','proveedores','proyectos','contactos','cambios'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_tool_check
      CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario','ventas','proveedores','proyectos','contactos'));
    DROP TABLE IF EXISTS cambio_movimientos;
    DROP TABLE IF EXISTS cambio_entidades;
  `);
};

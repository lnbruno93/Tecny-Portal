// Módulo Tarjetas de Crédito: cuenta corriente con tarjetas/procesadores.
// Cobro (bruto → comisión → neto pendiente) y Liquidación (ingreso del neto a una caja).
// Cobros automáticos desde Ventas vía métodos de pago marcados como tarjeta.
exports.up = (pgm) => {
  pgm.sql(`
    -- Tarjetas / procesadores (Visa, Master, Amex…)
    CREATE TABLE IF NOT EXISTS tarjeta_entidades (
      id         SERIAL PRIMARY KEY,
      nombre     TEXT NOT NULL,
      activo     BOOLEAN NOT NULL DEFAULT true,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tarjeta_entidad_nombre
      ON tarjeta_entidades (lower(nombre)) WHERE deleted_at IS NULL;

    -- Planes con su comisión (débito, 1 cuota, 3 cuotas…) por tarjeta
    CREATE TABLE IF NOT EXISTS tarjeta_planes (
      id         SERIAL PRIMARY KEY,
      entidad_id INTEGER NOT NULL REFERENCES tarjeta_entidades(id) ON DELETE CASCADE,
      nombre     TEXT NOT NULL,
      pct        NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (pct >= 0 AND pct <= 100),
      activo     BOOLEAN NOT NULL DEFAULT true,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tarjeta_planes_entidad
      ON tarjeta_planes (entidad_id) WHERE deleted_at IS NULL;

    -- Movimientos: 'cobro' (venta con tarjeta → neto pendiente) | 'liquidacion' (nos depositan el neto)
    CREATE TABLE IF NOT EXISTS tarjeta_movimientos (
      id             SERIAL PRIMARY KEY,
      entidad_id     INTEGER NOT NULL REFERENCES tarjeta_entidades(id) ON DELETE CASCADE,
      plan_id        INTEGER REFERENCES tarjeta_planes(id) ON DELETE SET NULL,
      fecha          DATE NOT NULL,
      tipo           TEXT NOT NULL CHECK (tipo IN ('cobro','liquidacion')),
      moneda         TEXT NOT NULL DEFAULT 'ARS' CHECK (moneda IN ('USD','ARS','USDT')),
      monto_bruto    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monto_bruto >= 0),
      pct            NUMERIC(6,3) NOT NULL DEFAULT 0,
      monto_comision NUMERIC(14,2) NOT NULL DEFAULT 0,
      monto_neto     NUMERIC(14,2) NOT NULL DEFAULT 0,
      caja_id        INTEGER REFERENCES metodos_pago(id) ON DELETE SET NULL,
      venta_id       INTEGER REFERENCES ventas(id) ON DELETE SET NULL,
      comentarios    TEXT,
      user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      deleted_at     TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tarjeta_mov_entidad
      ON tarjeta_movimientos (entidad_id, fecha DESC, id DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_tarjeta_mov_venta
      ON tarjeta_movimientos (venta_id) WHERE venta_id IS NOT NULL AND deleted_at IS NULL;

    -- Un método de pago puede ser una tarjeta (con su entidad y plan por defecto).
    ALTER TABLE metodos_pago
      ADD COLUMN IF NOT EXISTS es_tarjeta         BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS tarjeta_entidad_id INTEGER REFERENCES tarjeta_entidades(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS tarjeta_plan_id    INTEGER REFERENCES tarjeta_planes(id) ON DELETE SET NULL;

    -- Permitir el nuevo tool 'tarjetas' (la lista ya incluye 'cambios' por la migración previa)
    ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_tool_check
      CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario','ventas','proveedores','proyectos','contactos','cambios','tarjetas'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_tool_check
      CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario','ventas','proveedores','proyectos','contactos','cambios'));
    ALTER TABLE metodos_pago
      DROP COLUMN IF EXISTS es_tarjeta,
      DROP COLUMN IF EXISTS tarjeta_entidad_id,
      DROP COLUMN IF EXISTS tarjeta_plan_id;
    DROP TABLE IF EXISTS tarjeta_movimientos;
    DROP TABLE IF EXISTS tarjeta_planes;
    DROP TABLE IF EXISTS tarjeta_entidades;
  `);
};

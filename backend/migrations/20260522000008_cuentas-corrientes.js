/* eslint-disable camelcase */
/**
 * Migración 008 — Módulo Cuentas Corrientes (CC)
 *
 * Crea las tres tablas del módulo B2B:
 *   clientes_cc        — clientes con cuenta corriente (no son los contactos de Cajas)
 *   movimientos_cc     — compras, pagos, devoluciones, etc. por cliente
 *   items_movimiento_cc — productos individuales dentro de un movimiento
 *
 * También actualiza el CHECK constraint de user_permissions.tool para incluir 'cuentas'.
 *
 * Saldo = SUM(compra.monto_total) - SUM(pago|devolucion|parte_de_pago|entrega_mercaderia.monto_total)
 * Un saldo positivo significa que el cliente nos debe dinero.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Ampliar CHECK constraint de user_permissions para incluir 'cuentas'
    --    PostgreSQL auto-nombra el constraint como {tabla}_{columna}_check
    ALTER TABLE user_permissions
      DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions
      ADD CONSTRAINT user_permissions_tool_check
        CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas'));

    -- 2. Clientes de cuentas corrientes
    --    Entidad propia — no son los contactos de Cajas.
    CREATE TABLE IF NOT EXISTS clientes_cc (
      id           SERIAL PRIMARY KEY,
      nombre       TEXT          NOT NULL,
      apellido     TEXT,
      contacto     TEXT,                          -- teléfono / WhatsApp / email
      marca_redes  TEXT,                          -- marca comercial o redes sociales
      provincia    TEXT,
      localidad    TEXT,
      direccion    TEXT,
      categoria    TEXT          NOT NULL DEFAULT 'A-'
                     CHECK (categoria IN ('VIP','A+','A-')),
      notas        TEXT,
      deleted_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_clientes_cc_active   ON clientes_cc (id)   WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_clientes_cc_nombre   ON clientes_cc (nombre, apellido) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_clientes_cc_categoria ON clientes_cc (categoria) WHERE deleted_at IS NULL;

    -- 3. Movimientos de la cuenta corriente
    --    Tipos que suman deuda: compra
    --    Tipos que cancelan deuda: pago, devolucion, parte_de_pago, entrega_mercaderia
    CREATE TABLE IF NOT EXISTS movimientos_cc (
      id             SERIAL PRIMARY KEY,
      cliente_cc_id  INTEGER       NOT NULL REFERENCES clientes_cc(id) ON DELETE CASCADE,
      fecha          DATE          NOT NULL,
      tipo           TEXT          NOT NULL
                       CHECK (tipo IN ('compra','pago','devolucion','parte_de_pago','entrega_mercaderia')),
      descripcion    TEXT,
      monto_total    NUMERIC(12,2) NOT NULL DEFAULT 0,
      notas          TEXT,
      deleted_at     TIMESTAMPTZ,
      created_at     TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mov_cc_cliente ON movimientos_cc (cliente_cc_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_mov_cc_fecha   ON movimientos_cc (fecha DESC)    WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_mov_cc_tipo    ON movimientos_cc (tipo)          WHERE deleted_at IS NULL;

    -- 4. Items de movimiento (aplica solo a compras y devoluciones)
    --    No tienen soft-delete propio: se eliminan con el movimiento padre.
    CREATE TABLE IF NOT EXISTS items_movimiento_cc (
      id              SERIAL PRIMARY KEY,
      movimiento_cc_id INTEGER     NOT NULL REFERENCES movimientos_cc(id) ON DELETE CASCADE,
      producto        TEXT,
      modelo          TEXT,
      tamano          TEXT,
      color           TEXT,
      imei_serial     TEXT,
      valor           NUMERIC(12,2),
      verificado      BOOLEAN      NOT NULL DEFAULT false,
      notas           TEXT,
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_items_mov_cc ON items_movimiento_cc (movimiento_cc_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS items_movimiento_cc CASCADE;
    DROP TABLE IF EXISTS movimientos_cc       CASCADE;
    DROP TABLE IF EXISTS clientes_cc          CASCADE;

    -- Revertir CHECK constraint de user_permissions
    ALTER TABLE user_permissions
      DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions
      ADD CONSTRAINT user_permissions_tool_check
        CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios'));
  `);
};

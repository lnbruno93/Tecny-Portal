/* eslint-disable camelcase */
/**
 * Migración 013 — Módulo Ventas
 *
 * Estructura de una venta (orden) y sus partes:
 *   etiquetas      — clasificación de ventas (Mayorista, etc.)
 *   metodos_pago   — catálogo de métodos para agrupar en el dashboard
 *   ventas         — la orden: cliente, estado, tipo de cambio, totales en USD
 *   venta_items    — productos vendidos (precio vendido/original/costo, ganancia)
 *   venta_pagos    — múltiples pagos por venta, cada uno con método, moneda y TC
 *   canjes         — equipo tomado como parte de pago (trade-in)
 *   ventas_rapidas — borradores del empleado que el admin procesa
 *   egresos        — gastos del período (Ganancia Neta = Bruta - Egresos)
 *
 * También agrega el permiso 'ventas' al CHECK de user_permissions.
 *
 * Integración con módulos existentes:
 * - vendedores: comisiones por venta (venta_items / ventas).
 * - contactos (tipo cliente) y clientes_cc: el cliente de la venta.
 * - movimientos_cc: un pago en cuenta corriente puede generar una 'compra' en CC
 *   (se conecta en la capa de aplicación, no por FK rígida, para no acoplar módulos).
 *
 * Todos los montos se normalizan a USD vía TC para que el dashboard agregue
 * sin ambigüedad de moneda; se conserva el monto y moneda original de cada pago.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Ampliar CHECK de user_permissions para incluir 'ventas'
    ALTER TABLE user_permissions
      DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions
      ADD CONSTRAINT user_permissions_tool_check
        CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario','ventas'));

    -- 2. Etiquetas de venta
    CREATE TABLE IF NOT EXISTS etiquetas (
      id         SERIAL PRIMARY KEY,
      nombre     TEXT NOT NULL,
      color      TEXT,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_etiquetas_nombre
      ON etiquetas (LOWER(nombre)) WHERE deleted_at IS NULL;

    -- 3. Métodos de pago (catálogo para agrupar en el dashboard)
    CREATE TABLE IF NOT EXISTS metodos_pago (
      id         SERIAL PRIMARY KEY,
      nombre     TEXT NOT NULL,
      moneda     TEXT NOT NULL DEFAULT 'ARS' CHECK (moneda IN ('USD','ARS','USDT')),
      activo     BOOLEAN NOT NULL DEFAULT true,
      orden      INTEGER NOT NULL DEFAULT 0,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_metodos_pago_nombre
      ON metodos_pago (LOWER(nombre)) WHERE deleted_at IS NULL;

    INSERT INTO metodos_pago (nombre, moneda, orden) VALUES
      ('USD | Efectivo',      'USD',  1),
      ('Pesos Ars | Efectivo','ARS',  2),
      ('Pesos Ars | BBVA GL', 'ARS',  3),
      ('Pesos Ars | BBVA LB', 'ARS',  4),
      ('USD | BBVA GL',       'USD',  5),
      ('Binance | GL',        'USDT', 6)
    ON CONFLICT DO NOTHING;

    -- 4. Ventas (orden)
    CREATE TABLE IF NOT EXISTS ventas (
      id             SERIAL PRIMARY KEY,
      order_id       TEXT          NOT NULL,
      fecha          DATE          NOT NULL,
      hora           TIME,
      cliente_id     INTEGER       REFERENCES contactos(id)   ON DELETE SET NULL,
      cliente_cc_id  INTEGER       REFERENCES clientes_cc(id) ON DELETE SET NULL,
      cliente_nombre TEXT,
      etiqueta_id    INTEGER       REFERENCES etiquetas(id)   ON DELETE SET NULL,
      estado         TEXT          NOT NULL DEFAULT 'pendiente'
                       CHECK (estado IN ('acreditado','pendiente','cancelado')),
      tc_venta       NUMERIC(14,4),
      tc_compra      NUMERIC(14,4),
      total_usd      NUMERIC(12,2) NOT NULL DEFAULT 0,
      ganancia_usd   NUMERIC(12,2) NOT NULL DEFAULT 0,
      notas          TEXT,
      user_id        INTEGER       REFERENCES users(id) ON DELETE SET NULL,
      deleted_at     TIMESTAMPTZ,
      created_at     TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_order_id ON ventas (order_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ventas_active   ON ventas (id)         WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ventas_fecha    ON ventas (fecha DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ventas_estado   ON ventas (estado)     WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ventas_etiqueta ON ventas (etiqueta_id);
    CREATE INDEX IF NOT EXISTS idx_ventas_cliente  ON ventas (cliente_id);

    -- 5. Items de venta
    CREATE TABLE IF NOT EXISTS venta_items (
      id              SERIAL PRIMARY KEY,
      venta_id        INTEGER       NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
      producto_id     INTEGER       REFERENCES productos(id) ON DELETE SET NULL,
      vendedor_id     INTEGER       REFERENCES vendedores(id) ON DELETE SET NULL,
      descripcion     TEXT          NOT NULL,
      imei            TEXT,
      cantidad        INTEGER       NOT NULL DEFAULT 1 CHECK (cantidad > 0),
      precio_vendido  NUMERIC(12,2) NOT NULL DEFAULT 0,
      precio_original NUMERIC(12,2),
      costo           NUMERIC(12,2) NOT NULL DEFAULT 0,
      moneda          TEXT          NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','ARS')),
      comision        NUMERIC(12,2) NOT NULL DEFAULT 0,
      ganancia        NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_venta_items_venta    ON venta_items (venta_id);
    CREATE INDEX IF NOT EXISTS idx_venta_items_producto ON venta_items (producto_id);
    CREATE INDEX IF NOT EXISTS idx_venta_items_vendedor ON venta_items (vendedor_id);

    -- 6. Pagos de venta (multi-método, multi-moneda)
    CREATE TABLE IF NOT EXISTS venta_pagos (
      id                   SERIAL PRIMARY KEY,
      venta_id             INTEGER       NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
      metodo_pago_id       INTEGER       REFERENCES metodos_pago(id) ON DELETE SET NULL,
      metodo_nombre        TEXT          NOT NULL,
      monto                NUMERIC(12,2) NOT NULL DEFAULT 0,
      moneda               TEXT          NOT NULL DEFAULT 'ARS' CHECK (moneda IN ('USD','ARS','USDT')),
      tc                   NUMERIC(14,4),
      monto_usd            NUMERIC(12,2) NOT NULL DEFAULT 0,
      es_cuenta_corriente  BOOLEAN       NOT NULL DEFAULT false,
      created_at           TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_venta_pagos_venta  ON venta_pagos (venta_id);
    CREATE INDEX IF NOT EXISTS idx_venta_pagos_metodo ON venta_pagos (metodo_pago_id);

    -- 7. Canjes (equipo tomado como parte de pago)
    CREATE TABLE IF NOT EXISTS canjes (
      id          SERIAL PRIMARY KEY,
      venta_id    INTEGER       NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
      descripcion TEXT          NOT NULL,
      imei        TEXT,
      gb          TEXT,
      color       TEXT,
      bateria     SMALLINT      CHECK (bateria IS NULL OR (bateria BETWEEN 0 AND 100)),
      valor_toma  NUMERIC(12,2) NOT NULL DEFAULT 0,
      moneda      TEXT          NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','ARS')),
      producto_id INTEGER       REFERENCES productos(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_canjes_venta    ON canjes (venta_id);
    CREATE INDEX IF NOT EXISTS idx_canjes_producto ON canjes (producto_id);

    -- 8. Ventas rápidas (borradores)
    CREATE TABLE IF NOT EXISTS ventas_rapidas (
      id             SERIAL PRIMARY KEY,
      vendedor_id    INTEGER REFERENCES vendedores(id) ON DELETE SET NULL,
      vendedor_nombre TEXT,
      cliente_texto  TEXT,
      detalle        TEXT    NOT NULL,
      estado         TEXT    NOT NULL DEFAULT 'pendiente'
                       CHECK (estado IN ('pendiente','procesada')),
      venta_id       INTEGER REFERENCES ventas(id) ON DELETE SET NULL,
      fecha          DATE    NOT NULL,
      hora           TIME,
      user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      deleted_at     TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_ventas_rapidas_estado ON ventas_rapidas (estado) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ventas_rapidas_fecha  ON ventas_rapidas (fecha DESC) WHERE deleted_at IS NULL;

    -- 9. Egresos (gastos del período)
    CREATE TABLE IF NOT EXISTS egresos (
      id             SERIAL PRIMARY KEY,
      fecha          DATE          NOT NULL,
      concepto       TEXT          NOT NULL,
      monto          NUMERIC(12,2) NOT NULL DEFAULT 0,
      moneda         TEXT          NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','ARS','USDT')),
      tc             NUMERIC(14,4),
      monto_usd      NUMERIC(12,2) NOT NULL DEFAULT 0,
      metodo_pago_id INTEGER       REFERENCES metodos_pago(id) ON DELETE SET NULL,
      notas          TEXT,
      user_id        INTEGER       REFERENCES users(id) ON DELETE SET NULL,
      deleted_at     TIMESTAMPTZ,
      created_at     TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_egresos_fecha  ON egresos (fecha DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_egresos_active ON egresos (id)         WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS egresos        CASCADE;
    DROP TABLE IF EXISTS ventas_rapidas CASCADE;
    DROP TABLE IF EXISTS canjes         CASCADE;
    DROP TABLE IF EXISTS venta_pagos    CASCADE;
    DROP TABLE IF EXISTS venta_items    CASCADE;
    DROP TABLE IF EXISTS ventas         CASCADE;
    DROP TABLE IF EXISTS metodos_pago   CASCADE;
    DROP TABLE IF EXISTS etiquetas      CASCADE;

    ALTER TABLE user_permissions
      DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions
      ADD CONSTRAINT user_permissions_tool_check
        CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario'));
  `);
};

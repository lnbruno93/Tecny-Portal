/* eslint-disable camelcase */
/**
 * Migración — Módulo Proveedores con cuenta corriente (cuentas por pagar).
 *
 * Espejo del módulo de clientes CC (cuentas), pero del lado de las compras:
 *   - proveedores: alta de cada proveedor + datos de contacto.
 *   - proveedor_movimientos: compras (lo que les debemos) y pagos (lo que les pagamos).
 *     Montos normalizados a USD (como ventas/egresos). caja_id queda para enganchar
 *     el pago a una caja en la Fase 2 (ledger de cajas).
 *
 * Saldo por proveedor (lo que les debemos) = SUM(compra.monto_usd) - SUM(pago.monto_usd).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id                SERIAL PRIMARY KEY,
      nombre            TEXT NOT NULL,
      contacto_nombre   TEXT,
      contacto_apellido TEXT,
      whatsapp          TEXT,
      ubicacion         TEXT,
      notas             TEXT,
      deleted_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS proveedor_movimientos (
      id            SERIAL PRIMARY KEY,
      proveedor_id  INTEGER       NOT NULL REFERENCES proveedores(id) ON DELETE CASCADE,
      fecha         DATE          NOT NULL,
      tipo          TEXT          NOT NULL CHECK (tipo IN ('compra','pago')),
      descripcion   TEXT,
      monto         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monto >= 0),
      moneda        TEXT          NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','ARS','USDT')),
      tc            NUMERIC(14,4),
      monto_usd     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monto_usd >= 0),
      caja_id       INTEGER       REFERENCES metodos_pago(id) ON DELETE SET NULL,
      notas         TEXT,
      deleted_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_proveedores_active ON proveedores (id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_prov_mov_proveedor ON proveedor_movimientos (proveedor_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_prov_mov_fecha     ON proveedor_movimientos (fecha DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_prov_mov_caja      ON proveedor_movimientos (caja_id) WHERE caja_id IS NOT NULL;

    -- Búsqueda por nombre de proveedor (ILIKE) con GIN trigram
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS idx_proveedores_nombre_gin ON proveedores USING GIN (nombre gin_trgm_ops) WHERE deleted_at IS NULL;

    -- Habilitar el permiso de módulo 'proveedores' en user_permissions.tool
    ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_tool_check
      CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario','ventas','proveedores'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revertir el permiso 'proveedores' (borrar filas y restaurar el CHECK anterior)
    DELETE FROM user_permissions WHERE tool = 'proveedores';
    ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_tool_check
      CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario','ventas'));

    DROP TABLE IF EXISTS proveedor_movimientos CASCADE;
    DROP TABLE IF EXISTS proveedores CASCADE;
  `);
};

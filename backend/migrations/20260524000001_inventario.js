/* eslint-disable camelcase */
/**
 * Migración 012 — Módulo Inventario
 *
 * Crea el catálogo de stock:
 *   categorias — clasificación libre de productos
 *   depositos  — ubicaciones físicas de stock
 *   productos  — equipos y accesorios (unitario por IMEI o por lote con cantidad)
 *
 * También agrega el permiso 'inventario' al CHECK de user_permissions.
 *
 * Decisiones:
 * - El IMEI NO tiene UNIQUE en DB: un equipo vendido conserva su IMEI y un canje
 *   puede reingresar el mismo IMEI. La detección de duplicados se maneja en la app
 *   (warning, no bloqueo). Igual se indexa para búsqueda rápida.
 * - Montos con su moneda explícita (USD/ARS); la conversión vive en la capa de ventas.
 * - Fotos como base64 en TEXT, igual que comprobantes (sin dependencia de storage externo).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Ampliar CHECK de user_permissions para incluir 'inventario'
    ALTER TABLE user_permissions
      DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions
      ADD CONSTRAINT user_permissions_tool_check
        CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados','inventario'));

    -- 2. Categorías (catálogo libre)
    CREATE TABLE IF NOT EXISTS categorias (
      id         SERIAL PRIMARY KEY,
      nombre     TEXT NOT NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_nombre
      ON categorias (LOWER(nombre)) WHERE deleted_at IS NULL;

    -- 3. Depósitos (ubicaciones de stock)
    CREATE TABLE IF NOT EXISTS depositos (
      id         SERIAL PRIMARY KEY,
      nombre     TEXT NOT NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_depositos_nombre
      ON depositos (LOWER(nombre)) WHERE deleted_at IS NULL;

    -- 4. Productos
    CREATE TABLE IF NOT EXISTS productos (
      id             SERIAL PRIMARY KEY,
      tipo_carga     TEXT          NOT NULL DEFAULT 'unitario'
                       CHECK (tipo_carga IN ('unitario','lote')),
      clase          TEXT          NOT NULL DEFAULT 'celular'
                       CHECK (clase IN ('celular','accesorio')),
      nombre         TEXT          NOT NULL,
      imei           TEXT,
      gb             TEXT,
      color          TEXT,
      bateria        SMALLINT      CHECK (bateria IS NULL OR (bateria BETWEEN 0 AND 100)),
      categoria_id   INTEGER       REFERENCES categorias(id) ON DELETE SET NULL,
      deposito_id    INTEGER       REFERENCES depositos(id)  ON DELETE SET NULL,
      proveedor      TEXT,
      costo          NUMERIC(12,2) NOT NULL DEFAULT 0,
      costo_moneda   TEXT          NOT NULL DEFAULT 'USD' CHECK (costo_moneda IN ('USD','ARS')),
      precio_venta   NUMERIC(12,2) NOT NULL DEFAULT 0,
      precio_moneda  TEXT          NOT NULL DEFAULT 'USD' CHECK (precio_moneda IN ('USD','ARS')),
      trackear_stock BOOLEAN       NOT NULL DEFAULT true,
      cantidad       INTEGER       NOT NULL DEFAULT 1 CHECK (cantidad >= 0),
      estado         TEXT          NOT NULL DEFAULT 'disponible'
                       CHECK (estado IN ('disponible','vendido','en_tecnico','reservado')),
      foto_data      TEXT,
      foto_nombre    TEXT,
      foto_tipo      TEXT,
      observaciones  TEXT,
      deleted_at     TIMESTAMPTZ,
      created_at     TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_productos_active   ON productos (id)            WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_productos_estado   ON productos (estado)        WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_productos_clase    ON productos (clase)         WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_productos_imei     ON productos (imei)          WHERE deleted_at IS NULL AND imei IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_productos_nombre   ON productos (LOWER(nombre)) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos (categoria_id);
    CREATE INDEX IF NOT EXISTS idx_productos_deposito  ON productos (deposito_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS productos  CASCADE;
    DROP TABLE IF EXISTS depositos  CASCADE;
    DROP TABLE IF EXISTS categorias CASCADE;

    ALTER TABLE user_permissions
      DROP CONSTRAINT IF EXISTS user_permissions_tool_check;
    ALTER TABLE user_permissions
      ADD CONSTRAINT user_permissions_tool_check
        CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados'));
  `);
};

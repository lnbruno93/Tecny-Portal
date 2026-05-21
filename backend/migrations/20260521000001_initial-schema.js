/* eslint-disable camelcase */
/**
 * Migración 001 — Schema inicial
 * Convierte schema.sql en migración versionada.
 * Usa IF NOT EXISTS en todas las tablas para ser seguro sobre DBs existentes.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- USERS
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      nombre        TEXT NOT NULL,
      username      TEXT UNIQUE NOT NULL,
      email         TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'op' CHECK (role IN ('admin','op')),
      deleted_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
    CREATE INDEX IF NOT EXISTS idx_users_email    ON users (email) WHERE email IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_users_active   ON users (id)   WHERE deleted_at IS NULL;

    -- USER PERMISSIONS
    CREATE TABLE IF NOT EXISTS user_permissions (
      id      SERIAL  PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool    TEXT    NOT NULL CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios')),
      enabled BOOLEAN NOT NULL DEFAULT false,
      UNIQUE (user_id, tool)
    );

    CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions (user_id);

    -- VENDEDORES
    CREATE TABLE IF NOT EXISTS vendedores (
      id         SERIAL PRIMARY KEY,
      nombre     TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- COMPROBANTES
    CREATE TABLE IF NOT EXISTS comprobantes (
      id               SERIAL PRIMARY KEY,
      fecha            DATE          NOT NULL,
      cliente          TEXT          NOT NULL,
      vendedor_id      INTEGER       REFERENCES vendedores(id) ON DELETE SET NULL,
      monto            NUMERIC(12,2) NOT NULL,
      monto_financiera NUMERIC(12,2) NOT NULL DEFAULT 0,
      monto_neto       NUMERIC(12,2) NOT NULL DEFAULT 0,
      referencia       TEXT,
      archivo_data     TEXT,
      archivo_nombre   TEXT,
      archivo_tipo     TEXT,
      created_at       TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_comprobantes_fecha      ON comprobantes (fecha DESC);
    CREATE INDEX IF NOT EXISTS idx_comprobantes_vendedor   ON comprobantes (vendedor_id);
    CREATE INDEX IF NOT EXISTS idx_comprobantes_fecha_vend ON comprobantes (fecha DESC, vendedor_id);

    -- PAGOS
    CREATE TABLE IF NOT EXISTS pagos (
      id         SERIAL PRIMARY KEY,
      fecha      DATE          NOT NULL,
      monto      NUMERIC(12,2) NOT NULL,
      referencia TEXT,
      created_at TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pagos_fecha ON pagos (fecha DESC);

    -- CONTACTOS
    CREATE TABLE IF NOT EXISTS contactos (
      id         SERIAL PRIMARY KEY,
      nombre     TEXT NOT NULL,
      apellido   TEXT,
      tipo       TEXT NOT NULL CHECK (tipo IN ('amigo','familiar','cliente','inversor','ipro team')),
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_contactos_active ON contactos (id)   WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_contactos_tipo   ON contactos (tipo);

    -- MOVIMIENTOS DE DEUDAS
    CREATE TABLE IF NOT EXISTS movimientos_deudas (
      id          SERIAL PRIMARY KEY,
      fecha       DATE          NOT NULL,
      contacto_id INTEGER       NOT NULL REFERENCES contactos(id) ON DELETE CASCADE,
      tipo        TEXT          NOT NULL CHECK (tipo IN ('debe','pago')),
      monto_ars   NUMERIC(12,2) NOT NULL DEFAULT 0,
      monto_usd   NUMERIC(12,2) NOT NULL DEFAULT 0,
      concepto    TEXT,
      created_at  TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mov_deudas_contacto ON movimientos_deudas (contacto_id);
    CREATE INDEX IF NOT EXISTS idx_mov_deudas_fecha    ON movimientos_deudas (fecha DESC);

    -- MOVIMIENTOS DE INVERSIONES
    CREATE TABLE IF NOT EXISTS movimientos_inversiones (
      id          SERIAL PRIMARY KEY,
      fecha       DATE          NOT NULL,
      contacto_id INTEGER       NOT NULL REFERENCES contactos(id) ON DELETE CASCADE,
      monto       NUMERIC(12,2) NOT NULL,
      tasa        TEXT,
      created_at  TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mov_inv_contacto ON movimientos_inversiones (contacto_id);
    CREATE INDEX IF NOT EXISTS idx_mov_inv_fecha    ON movimientos_inversiones (fecha DESC);

    -- ENVÍOS
    CREATE TABLE IF NOT EXISTS envios (
      id            SERIAL PRIMARY KEY,
      fecha         DATE          NOT NULL,
      cliente       TEXT          NOT NULL,
      telefono      TEXT,
      direccion     TEXT          NOT NULL,
      barrio        TEXT,
      costo_envio   NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_cobrado NUMERIC(12,2) NOT NULL DEFAULT 0,
      horario       TEXT,
      operador      TEXT,
      notas         TEXT,
      estado        TEXT          NOT NULL DEFAULT 'Pendiente'
                      CHECK (estado IN ('Pendiente','En camino','Entregado','Cancelado')),
      prioridad     TEXT          CHECK (prioridad IN ('Alta','Media','Baja')),
      deleted_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_envios_estado ON envios (estado) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_envios_fecha  ON envios (fecha DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_envios_active ON envios (id) WHERE deleted_at IS NULL;

    -- ENVIO ITEMS
    CREATE TABLE IF NOT EXISTS envio_items (
      id          SERIAL PRIMARY KEY,
      envio_id    INTEGER       NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
      tipo        TEXT          NOT NULL CHECK (tipo IN ('producto','pago')),
      descripcion TEXT,
      monto       NUMERIC(12,2) NOT NULL DEFAULT 0,
      metodo_pago TEXT,
      created_at  TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_envio_items_envio ON envio_items (envio_id);

    -- HISTORIAL
    CREATE TABLE IF NOT EXISTS historial (
      id         SERIAL PRIMARY KEY,
      accion     TEXT    NOT NULL,
      detalle    TEXT,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_historial_user    ON historial (user_id);
    CREATE INDEX IF NOT EXISTS idx_historial_created ON historial (created_at DESC);

    -- AUDIT LOGS
    CREATE TABLE IF NOT EXISTS audit_logs (
      id            SERIAL PRIMARY KEY,
      tabla         TEXT    NOT NULL,
      accion        TEXT    NOT NULL CHECK (accion IN ('INSERT','UPDATE','DELETE')),
      registro_id   INTEGER,
      datos_antes   JSONB,
      datos_despues JSONB,
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_audit_tabla   ON audit_logs (tabla, registro_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_logs (user_id);

    -- CONFIG (singleton)
    CREATE TABLE IF NOT EXISTS config (
      id             INTEGER PRIMARY KEY DEFAULT 1,
      pct_financiera NUMERIC(5,2) NOT NULL DEFAULT 0,
      updated_at     TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT single_row CHECK (id = 1)
    );

    INSERT INTO config (id, pct_financiera) VALUES (1, 0) ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  // ⚠️  Destructivo — solo usar en entornos de desarrollo
  pgm.sql(`
    DROP TABLE IF EXISTS audit_logs          CASCADE;
    DROP TABLE IF EXISTS historial           CASCADE;
    DROP TABLE IF EXISTS envio_items         CASCADE;
    DROP TABLE IF EXISTS envios              CASCADE;
    DROP TABLE IF EXISTS movimientos_inversiones CASCADE;
    DROP TABLE IF EXISTS movimientos_deudas  CASCADE;
    DROP TABLE IF EXISTS contactos           CASCADE;
    DROP TABLE IF EXISTS pagos               CASCADE;
    DROP TABLE IF EXISTS comprobantes        CASCADE;
    DROP TABLE IF EXISTS vendedores          CASCADE;
    DROP TABLE IF EXISTS user_permissions    CASCADE;
    DROP TABLE IF EXISTS users               CASCADE;
    DROP TABLE IF EXISTS config              CASCADE;
  `);
};

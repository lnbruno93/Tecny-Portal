/* eslint-disable camelcase */
/**
 * Migración 009 — Catálogo de equipos usados + permiso 'usados'
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // 1. Tabla catálogo
  pgm.sql(`
    CREATE TABLE catalogo_usados (
      id           SERIAL PRIMARY KEY,
      equipo       VARCHAR(150) NOT NULL,
      capacidad    VARCHAR(50),
      pct_bateria  VARCHAR(50),
      precio_usd   NUMERIC(10,2) NOT NULL CHECK (precio_usd >= 0),
      comentarios  TEXT,
      deleted_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  pgm.sql(`CREATE INDEX idx_catalogo_usados_equipo ON catalogo_usados(equipo) WHERE deleted_at IS NULL`);

  // 2. Actualizar CHECK constraint de user_permissions para incluir 'usados'
  pgm.sql(`ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check`);
  pgm.sql(`
    ALTER TABLE user_permissions
    ADD CONSTRAINT user_permissions_tool_check
    CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas','usados'))
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS catalogo_usados`);
  pgm.sql(`ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_tool_check`);
  pgm.sql(`
    ALTER TABLE user_permissions
    ADD CONSTRAINT user_permissions_tool_check
    CHECK (tool IN ('cotizador','financiera','cajas','envios','usuarios','cuentas'))
  `);
};

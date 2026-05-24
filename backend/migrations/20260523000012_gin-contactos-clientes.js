/**
 * Migración 012: GIN trigram indexes en contactos y clientes_cc
 *
 * Los endpoints buscan con ILIKE '%texto%' en nombre y apellido.
 * Sin GIN trigram, PostgreSQL hace seq scan en toda la tabla.
 * Con GIN trgm_ops, el planner usa index scan incluso para patrones con % al inicio.
 *
 * Nota: pg_trgm ya fue habilitado en migración 007.
 * Nota: CONCURRENTLY no puede usarse dentro de una transacción (node-pg-migrate
 *       corre cada migración en una transacción por defecto). Se omite aquí;
 *       en producción con tablas grandes aplicar manualmente si se requiere.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ── contactos ────────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_contactos_nombre_trgm
      ON contactos USING GIN (nombre gin_trgm_ops)
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_contactos_apellido_trgm
      ON contactos USING GIN (apellido gin_trgm_ops)
  `);

  // ── clientes_cc ───────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_clientes_cc_nombre_trgm
      ON clientes_cc USING GIN (nombre gin_trgm_ops)
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_clientes_cc_apellido_trgm
      ON clientes_cc USING GIN (apellido gin_trgm_ops)
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS idx_contactos_nombre_trgm');
  pgm.sql('DROP INDEX IF EXISTS idx_contactos_apellido_trgm');
  pgm.sql('DROP INDEX IF EXISTS idx_clientes_cc_nombre_trgm');
  pgm.sql('DROP INDEX IF EXISTS idx_clientes_cc_apellido_trgm');
};

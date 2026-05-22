/* eslint-disable camelcase */
/**
 * Migración 007 — GIN trigram indexes para búsquedas ILIKE
 *
 * Sin estos indexes, cada búsqueda con ILIKE hace un seq scan completo.
 * Con pg_trgm + GIN, PostgreSQL puede usar el index para patrones con %prefijo%.
 *
 * Tablas beneficiadas:
 *   envios     — buscar por cliente, dirección, barrio (campos frecuentes en búsqueda)
 *   comprobantes — buscar por cliente y referencia
 *
 * Notas:
 *   - Filtro WHERE deleted_at IS NULL: solo indexa filas activas (reduce tamaño del index)
 *   - La extensión pg_trgm es nativa de PostgreSQL (no requiere instalación externa)
 *   - Los índices se crean con IF NOT EXISTS — idempotentes
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Extensión trigrama: necesaria para operador <-> y soporte GIN de ILIKE
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    -- Envios: campos de búsqueda frecuente
    CREATE INDEX IF NOT EXISTS envios_cliente_gin
      ON envios USING GIN (cliente gin_trgm_ops)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS envios_direccion_gin
      ON envios USING GIN (direccion gin_trgm_ops)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS envios_barrio_gin
      ON envios USING GIN (barrio gin_trgm_ops)
      WHERE deleted_at IS NULL;

    -- Comprobantes: cliente y referencia
    CREATE INDEX IF NOT EXISTS comprobantes_cliente_gin
      ON comprobantes USING GIN (cliente gin_trgm_ops)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS comprobantes_referencia_gin
      ON comprobantes USING GIN (referencia gin_trgm_ops)
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS envios_cliente_gin;
    DROP INDEX IF EXISTS envios_direccion_gin;
    DROP INDEX IF EXISTS envios_barrio_gin;
    DROP INDEX IF EXISTS comprobantes_cliente_gin;
    DROP INDEX IF EXISTS comprobantes_referencia_gin;
    -- No se elimina pg_trgm — puede ser usada por otras extensiones
  `);
};

/* eslint-disable camelcase */
/**
 * Migración 011 — Índices de performance para Cuentas Corrientes
 *
 * La migración 008 creó índices simples al moment de crear las tablas.
 * Con el módulo en producción y volúmenes reales (40+ clientes/día,
 * 250+ movimientos/día), estas queries necesitan índices compuestos:
 *
 *   1. idx_mov_cc_cliente_fecha_id  — cubre la query principal de historial:
 *        WHERE cliente_cc_id = $1 AND deleted_at IS NULL
 *        ORDER BY fecha DESC, id DESC  LIMIT 500
 *      Reemplaza el índice simple idx_mov_cc_cliente en efectividad para esta query.
 *
 *   2. idx_clientes_cc_contacto_gin — cubre el nuevo filtro de búsqueda:
 *        nombre ILIKE $1 OR apellido ILIKE $1 OR contacto ILIKE $1
 *      La migración 007 agregó GIN para otras tablas pero no para clientes_cc.contacto.
 *
 * Índices omitidos (ya existen o son redundantes):
 *   - idx_items_mov_cc:      creado en migración 008 (IF NOT EXISTS lo protege)
 *   - idx_clientes_cc_deleted: los índices parciales WHERE deleted_at IS NULL
 *                              de migración 008 ya cubren este caso
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Índice compuesto para historial de movimientos por cliente
    --    Cubre: WHERE cliente_cc_id = $1 AND deleted_at IS NULL ORDER BY fecha DESC, id DESC
    --    El índice parcial excluye filas eliminadas, reduciend el tamaño considerablemente.
    CREATE INDEX IF NOT EXISTS idx_mov_cc_cliente_fecha_id
      ON movimientos_cc (cliente_cc_id, fecha DESC, id DESC)
      WHERE deleted_at IS NULL;

    -- 2. GIN trigram para búsqueda ILIKE en contacto de clientes CC
    --    Permite: WHERE contacto ILIKE '%termino%' sin seq scan
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE INDEX IF NOT EXISTS idx_clientes_cc_contacto_gin
      ON clientes_cc USING GIN (contacto gin_trgm_ops)
      WHERE deleted_at IS NULL AND contacto IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_mov_cc_cliente_fecha_id;
    DROP INDEX IF EXISTS idx_clientes_cc_contacto_gin;
    -- pg_trgm no se elimina — puede estar en uso por otros índices (migración 007)
  `);
};

/* eslint-disable camelcase */
/**
 * Migración — índice covering para Inventario vista=no_vendidos
 *
 * Auditoría #P-04: el índice creado en la migración 011
 * `productos_visibles_idx ON productos(id) WHERE deleted_at IS NULL AND
 * oculto = false` solo descartaba ocultos/borrados. El planner igual leía
 * todas las filas restantes para aplicar `estado <> 'vendido' AND cantidad
 * > 0` y luego hacía Sort externo por `nombre, id DESC`.
 *
 * Con 10k productos visibles, abrir Inventario disparaba ~1-3s de Sort en
 * disco. Este índice incluye TODO el WHERE de la vista default y el ORDER
 * BY, permitiendo index-only scan en el caso común.
 *
 * Trade-off: el índice solo cubre la vista=no_vendidos (el caso 95%). Las
 * otras vistas (ocultos, vendidos, etc.) usan otros índices o se quedan
 * con seq scan — son consultas raras de admin y no justifican otro índice.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Reemplazar el índice viejo por uno covering del ORDER BY + WHERE
    DROP INDEX IF EXISTS productos_visibles_idx;

    CREATE INDEX IF NOT EXISTS productos_vista_default
      ON productos (nombre, id DESC)
      WHERE deleted_at IS NULL
        AND oculto = false
        AND estado <> 'vendido'
        AND cantidad > 0;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS productos_vista_default;
    -- Restaurar el índice anterior (idempotente)
    CREATE INDEX IF NOT EXISTS productos_visibles_idx
      ON productos (id)
      WHERE deleted_at IS NULL AND oculto = false;
  `);
};

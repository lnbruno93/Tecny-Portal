/* eslint-disable camelcase */
/**
 * Migración — productos.oculto y productos.condicion
 *
 * Pedido del PO: permitir filtros avanzados en Inventario.
 *
 *   1) `oculto BOOLEAN NOT NULL DEFAULT false`
 *      Marca productos que no deben aparecer en la vista por defecto,
 *      pero que tampoco se borraron. Útil para limpiar la grilla sin
 *      perder el histórico (un producto descontinuado, una compra que
 *      "no quiero ver más" pero conservo para auditoría).
 *
 *      El filtro 'vista' (no_vendidos / no_vendidos_ocultos / ocultos /
 *      vendidos / todos_visibles / todos_ocultos) decide qué se muestra.
 *
 *   2) `condicion TEXT NOT NULL DEFAULT 'nuevo' CHECK (condicion IN ('nuevo','usado'))`
 *      Atributo ortogonal a la categoría: un "iPhone Usado" sigue siendo
 *      categoría iPhone, no se duplica el árbol. Permite el tab "Usados"
 *      y reportes futuros de margen por condición.
 *
 * Índices:
 *   - `oculto` parcial sobre `deleted_at IS NULL` y `oculto = false`:
 *     la query default (vista=no_vendidos) filtra por oculto=false, así
 *     que un partial index acelera el caso común sin pagar espacio en
 *     ocultos.
 *   - `condicion` parcial sobre `condicion = 'usado'`: el universo "nuevo"
 *     es la mayoría, no necesita índice. El tab "Usados" se beneficia.
 *
 * Defaults retroactivos: NOT NULL + DEFAULT cubren las filas existentes
 * sin requerir UPDATE explícito (PostgreSQL llena con el default).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE productos
      ADD COLUMN IF NOT EXISTS oculto BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS condicion TEXT NOT NULL DEFAULT 'nuevo'
        CHECK (condicion IN ('nuevo','usado'));

    -- Partial index para vista por defecto (no_vendidos): visibles no borrados.
    CREATE INDEX IF NOT EXISTS productos_visibles_idx
      ON productos (id)
      WHERE deleted_at IS NULL AND oculto = false;

    -- Partial index para tab 'Usados' (minoría del universo).
    CREATE INDEX IF NOT EXISTS productos_usados_idx
      ON productos (id)
      WHERE deleted_at IS NULL AND condicion = 'usado';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS productos_visibles_idx;
    DROP INDEX IF EXISTS productos_usados_idx;
    ALTER TABLE productos
      DROP COLUMN IF EXISTS oculto,
      DROP COLUMN IF EXISTS condicion;
  `);
};

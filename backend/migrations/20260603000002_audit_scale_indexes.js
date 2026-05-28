/**
 * Índices de escalabilidad detectados en la auditoría:
 *
 *  1) proveedor_movimientos: composite (proveedor_id, fecha DESC, id DESC) para
 *     evitar el Sort en el historial paginado. Espejo del que ya existe en
 *     movimientos_cc.
 *
 *  2) envios.telefono y envios.notas: GIN trigram para que la búsqueda OR-ILIKE
 *     no degenere a seq scan cuando estas columnas se incluyen en el filtro
 *     `buscar` (las otras columnas — cliente/direccion/barrio — ya tienen GIN).
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_prov_mov_proveedor_fecha_id
      ON proveedor_movimientos (proveedor_id, fecha DESC, id DESC)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS envios_telefono_gin
      ON envios USING GIN (telefono gin_trgm_ops)
      WHERE deleted_at IS NULL AND telefono IS NOT NULL;

    CREATE INDEX IF NOT EXISTS envios_notas_gin
      ON envios USING GIN (notas gin_trgm_ops)
      WHERE deleted_at IS NULL AND notas IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_prov_mov_proveedor_fecha_id;
    DROP INDEX IF EXISTS envios_telefono_gin;
    DROP INDEX IF EXISTS envios_notas_gin;
  `);
};

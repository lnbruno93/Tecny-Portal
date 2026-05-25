/* eslint-disable camelcase */
/**
 * Índices de afinamiento (auditoría de infraestructura 2026-05-25).
 *
 * 1. FKs sin índice → un DELETE en la tabla padre hace seq scan en la hija
 *    (ON DELETE SET NULL) y los filtros por esa FK no escalan:
 *      - egresos.metodo_pago_id
 *      - ventas.cliente_cc_id  (estado de cuenta de un cliente CC)
 *      - ventas.user_id        (ventas por usuario)
 * 2. Índices que NO eran parciales → indexaban filas borradas (ruido) y no se
 *    combinaban bien con el filtro WHERE deleted_at IS NULL. Se recrean parciales:
 *      - idx_ventas_etiqueta, idx_ventas_cliente
 *      - idx_productos_categoria, idx_productos_deposito
 *
 * Cambio ADITIVO/idempotente. CREATE INDEX no reescribe tablas.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1) FKs sin índice (parciales por activo)
    CREATE INDEX IF NOT EXISTS idx_egresos_metodo     ON egresos (metodo_pago_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ventas_cliente_cc  ON ventas  (cliente_cc_id)  WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ventas_user        ON ventas  (user_id)        WHERE deleted_at IS NULL;

    -- 2) Recrear como parciales (eran índices completos)
    DROP INDEX IF EXISTS idx_ventas_etiqueta;
    CREATE INDEX IF NOT EXISTS idx_ventas_etiqueta ON ventas (etiqueta_id) WHERE deleted_at IS NULL;

    DROP INDEX IF EXISTS idx_ventas_cliente;
    CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas (cliente_id) WHERE deleted_at IS NULL;

    DROP INDEX IF EXISTS idx_productos_categoria;
    CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos (categoria_id) WHERE deleted_at IS NULL;

    DROP INDEX IF EXISTS idx_productos_deposito;
    CREATE INDEX IF NOT EXISTS idx_productos_deposito ON productos (deposito_id) WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_egresos_metodo;
    DROP INDEX IF EXISTS idx_ventas_cliente_cc;
    DROP INDEX IF EXISTS idx_ventas_user;

    -- Volver a los índices completos originales
    DROP INDEX IF EXISTS idx_ventas_etiqueta;
    CREATE INDEX IF NOT EXISTS idx_ventas_etiqueta ON ventas (etiqueta_id);

    DROP INDEX IF EXISTS idx_ventas_cliente;
    CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas (cliente_id);

    DROP INDEX IF EXISTS idx_productos_categoria;
    CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos (categoria_id);

    DROP INDEX IF EXISTS idx_productos_deposito;
    CREATE INDEX IF NOT EXISTS idx_productos_deposito ON productos (deposito_id);
  `);
};

/* eslint-disable camelcase */
/**
 * Feature — movimientos_cc.tipo = 'mercaderia_recibida'.
 *
 * Contexto (task #155, 2026-07-17): un CLIENTE de Venta B2B (ej: Kevin, Tek
 * Haus) puede cancelar la deuda que tiene con nosotros entregándonos productos
 * en vez de dinero. El caso disparador:
 *   - Kevin tiene deuda de u$s 5.000 con nosotros (venta B2B previa).
 *   - Kevin nos vende 2 PS5 valuadas u$s 2.500.
 *   - Después de registrar la entrega: saldo Kevin = u$s 2.500.
 *   - Las 2 PS5 quedan en nuestro Inventario (creación de productos nuevos).
 *
 * Naming — `mercaderia_recibida` (distinto de `entrega_mercaderia`):
 *   - `entrega_mercaderia` ya existe en movimientos_cc con semántica OPUESTA:
 *     nosotros le entregamos productos al cliente (SALE stock, baja saldo).
 *     Aunque el saldo va en la misma dirección, el efecto en stock es
 *     contrario. Reutilizarlo rompería reportes históricos y comprobantes.
 *   - `mercaderia_recibida` deja explícito que es el cliente el que ENTREGA
 *     y nosotros los que RECIBIMOS: entra stock nuevo + baja saldo.
 *
 * Cambios:
 *   1. Extender CHECK: agregar 'mercaderia_recibida' al set de valores válidos.
 *   2. Agregar FK `productos.movimiento_cc_id` (espejo del ya existente
 *      `proveedor_movimiento_id`) para poder cascadar el soft-delete de
 *      productos cuando el user borra el movimiento.
 *   3. Índice parcial en movimiento_cc_id para lookups de "productos creados
 *      por este movimiento" (WHERE cascade).
 *
 * Idempotencia:
 *   - ALTER TABLE ... ADD CONSTRAINT / DROP + ADD: seguro en replay.
 *   - ADD COLUMN IF NOT EXISTS: no-op si ya existe.
 *   - CREATE INDEX IF NOT EXISTS: idem.
 *
 * Data safety:
 *   - Aditivo puro. Ningún cambio a filas existentes.
 *   - La columna `productos.movimiento_cc_id` arranca NULL para todos los
 *     productos existentes → sin efecto en flujos actuales.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Extender CHECK constraint. IMPORTANTE: incluir todos los tipos ya
    --    en uso (compra, pago, devolucion, parte_de_pago, entrega_mercaderia,
    --    saldo_inicial — este último agregado por migration 20260526000001)
    --    más el nuevo 'mercaderia_recibida'. Omitir uno rompería INSERTs
    --    existentes con el tipo omitido.
    ALTER TABLE movimientos_cc DROP CONSTRAINT IF EXISTS movimientos_cc_tipo_check;
    ALTER TABLE movimientos_cc ADD CONSTRAINT movimientos_cc_tipo_check
      CHECK (tipo IN ('compra','pago','devolucion','parte_de_pago','entrega_mercaderia','saldo_inicial','mercaderia_recibida'));

    -- 2. FK productos.movimiento_cc_id — trazabilidad + cascade para el
    --    DELETE del movimiento cuando el tipo es 'mercaderia_recibida'.
    --    ON DELETE SET NULL es defensivo: si algún día la fila del movimiento
    --    se hard-deletea, el producto sigue vivo (no rompe inventario). Todo
    --    el cascade real vive en el DELETE del endpoint (soft-delete
    --    coordinado con validación de "vendido").
    ALTER TABLE productos ADD COLUMN IF NOT EXISTS movimiento_cc_id INTEGER;
    ALTER TABLE productos DROP CONSTRAINT IF EXISTS productos_movimiento_cc_id_fk;
    ALTER TABLE productos ADD CONSTRAINT productos_movimiento_cc_id_fk
      FOREIGN KEY (movimiento_cc_id) REFERENCES movimientos_cc(id) ON DELETE SET NULL;

    -- 3. Índice parcial (solo filas con FK, ~<1% del total esperado).
    CREATE INDEX IF NOT EXISTS idx_productos_movimiento_cc
      ON productos (movimiento_cc_id)
      WHERE movimiento_cc_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_productos_movimiento_cc;
    ALTER TABLE productos DROP CONSTRAINT IF EXISTS productos_movimiento_cc_id_fk;
    ALTER TABLE productos DROP COLUMN IF EXISTS movimiento_cc_id;

    ALTER TABLE movimientos_cc DROP CONSTRAINT IF EXISTS movimientos_cc_tipo_check;
    ALTER TABLE movimientos_cc ADD CONSTRAINT movimientos_cc_tipo_check
      CHECK (tipo IN ('compra','pago','devolucion','parte_de_pago','entrega_mercaderia','saldo_inicial'));
  `);
};

/* eslint-disable camelcase */
/**
 * Feature — proveedor_movimientos.tipo = 'entrega_mercaderia'.
 *
 * Contexto (task #150, discusión 2026-07-17): un proveedor puede cancelar
 * deuda con nosotros ENTREGANDO MERCADERÍA (en vez de solo con dinero via
 * `pago`). Caso disparador — cliente Tek Haus + Lucas: adelantaron plata a
 * un proveedor y ahora reciben PS5s a cuenta. Hoy no hay forma de registrar
 * ese ingreso de stock sin sumar deuda espuria (una `compra` sin caja_id
 * genera deuda, cuando en realidad la deuda YA existía y se está cancelando).
 *
 * Semántica del nuevo tipo (espejo del `entrega_mercaderia` en movimientos_cc
 * para clientes B2B, agregado en migration 20260522000008):
 *   - Reduce el saldo del proveedor con nosotros (equivalente contable a pago).
 *   - Trae items al inventario (equivalente a compra en términos de stock).
 *   - NO toca caja (no hay dinero involucrado — los productos SON el pago).
 *
 * Cambios:
 *   1. Extender CHECK: agregar 'entrega_mercaderia' al set de valores válidos.
 *   2. Idempotente: el ALTER + ADD CONSTRAINT es replay-safe.
 *
 * Impacto en producción: aditivo, no toca datos existentes. Feature nueva
 * disponible desde el mismo deploy sin flag (bajo el gate `proveedores.trabajar`
 * que ya cubre POST /movimientos).
 *
 * Down: restaura el CHECK anterior. Si hubiera filas con
 * tipo='entrega_mercaderia' cuando se hace down, viola el CHECK — pero eso
 * es OK porque el rollback exige limpiar/migrar esos datos primero.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE proveedor_movimientos DROP CONSTRAINT IF EXISTS proveedor_movimientos_tipo_check;
    ALTER TABLE proveedor_movimientos ADD CONSTRAINT proveedor_movimientos_tipo_check
      CHECK (tipo IN ('compra','pago','saldo_inicial','devolucion','entrega_mercaderia'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE proveedor_movimientos DROP CONSTRAINT IF EXISTS proveedor_movimientos_tipo_check;
    ALTER TABLE proveedor_movimientos ADD CONSTRAINT proveedor_movimientos_tipo_check
      CHECK (tipo IN ('compra','pago','saldo_inicial','devolucion'));
  `);
};

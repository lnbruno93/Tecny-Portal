/* eslint-disable camelcase */
/**
 * COR-2 (audit 2026-07-06) — proveedor_movimientos.tipo = 'devolucion'.
 *
 * Bug histórico (F4 #457): las devoluciones cross-tenant del buyer se
 * registraban en `proveedor_movimientos` con `tipo='pago'` porque el CHECK
 * NO admitía 'devolucion'. Comentario en `pagos.js:1055-1065` lo admite
 * explícitamente: "usamos tipo='pago' con monto >= 0 representando el monto
 * devuelto — describe lo que pasó pero semánticamente NO ES un pago".
 *
 * Consecuencias:
 *  - KPI "Cuánto pagué al proveedor X" inflado (cuenta devoluciones).
 *  - Filtros por tipo='pago' en Proveedores devuelven falsos positivos.
 *  - No hay forma de distinguir devolución de pago real sin JOIN con
 *    cross_tenant_operations.parent_op_id (que la mayoría de las queries
 *    no hacen).
 *  - Reportes de conciliación cross-tenant son consistentes (el mov_cc
 *    del seller SÍ tiene tipo='devolucion' correctamente), pero el
 *    proveedor_movimientos del buyer no lo refleja.
 *
 * Fix:
 *  1. Extender CHECK: agregar 'devolucion' al set de valores válidos.
 *  2. Backfill: filas donde `cross_tenant_operation_id IN (ops con
 *     parent_op_id NOT NULL)` y `tipo='pago'` → `tipo='devolucion'`.
 *     Este predicado es preciso: solo agarra las filas insertadas por
 *     el path de devolución cross-tenant (F4). No toca pagos legítimos.
 *  3. Backfill idempotente: el WHERE agarra solo tipo='pago' → si la
 *     migration corre dos veces, la 2da no cambia nada.
 *
 * Impacto en producción:
 *  - La UI de Proveedores debería mostrar el label "Devolución" en vez
 *    de "Pago" para estas filas retroactivamente. Es un fix backwards
 *    compatible desde el punto de vista de datos (nada rompe).
 *  - El total de "pagos" al proveedor va a BAJAR en el histórico donde
 *    hubo devoluciones — esto es CORRECTO, ese número estaba mal.
 *  - Si algún reporter tenía WHERE tipo IN ('pago','devolucion') fallaba
 *    silenciosamente antes (nadie tenía tipo='devolucion' en la tabla).
 *    Después de esta migration los reporters bien programados funcionan.
 *
 * Down: revierte el backfill (devolucion → pago) ANTES de restringir el
 * CHECK. Sin ese paso, el down bloquearía por CHECK violation.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE proveedor_movimientos DROP CONSTRAINT IF EXISTS proveedor_movimientos_tipo_check;
    ALTER TABLE proveedor_movimientos ADD CONSTRAINT proveedor_movimientos_tipo_check
      CHECK (tipo IN ('compra','pago','saldo_inicial','devolucion'));

    -- Backfill: filas de devolución cross-tenant registradas como 'pago'.
    UPDATE proveedor_movimientos pm
       SET tipo = 'devolucion'
      FROM cross_tenant_operations cto
     WHERE pm.cross_tenant_operation_id = cto.id
       AND cto.parent_op_id IS NOT NULL
       AND pm.tipo = 'pago';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revertir el backfill primero — sino el DROP CHECK/re-ADD viola.
    UPDATE proveedor_movimientos pm
       SET tipo = 'pago'
      FROM cross_tenant_operations cto
     WHERE pm.cross_tenant_operation_id = cto.id
       AND cto.parent_op_id IS NOT NULL
       AND pm.tipo = 'devolucion';

    ALTER TABLE proveedor_movimientos DROP CONSTRAINT IF EXISTS proveedor_movimientos_tipo_check;
    ALTER TABLE proveedor_movimientos ADD CONSTRAINT proveedor_movimientos_tipo_check
      CHECK (tipo IN ('compra','pago','saldo_inicial'));
  `);
};

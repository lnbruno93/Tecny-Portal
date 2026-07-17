/* eslint-disable camelcase */
/**
 * Rollback — remover `entrega_mercaderia` del CHECK de proveedor_movimientos.
 *
 * Historia:
 *   - 20260717000001 agregó 'entrega_mercaderia' al CHECK apuntando al feature
 *     "el proveedor cancela deuda con productos" en la ficha de Proveedores.
 *   - Charla posterior con Lucas (product owner): el flujo real vive en Venta
 *     & Gestión B2B (movimientos_cc), no en Proveedores. La UX en Proveedores
 *     era el módulo equivocado — Kevin (el caso disparador) está registrado
 *     como CLIENTE, no como proveedor.
 *   - Rollback quirúrgico: eliminar el tipo del CHECK acá porque nunca se va
 *     a usar en esta tabla. El equivalente en movimientos_cc se implementa
 *     como un tipo NUEVO llamado `mercaderia_recibida` (nombre distinto para
 *     no colisionar con el `entrega_mercaderia` histórico de movimientos_cc,
 *     que tiene semántica opuesta — "nosotros le entregamos al cliente").
 *
 * Idempotencia:
 *   - Si nunca se aplicó la migration original en este entorno, el CHECK
 *     nunca tuvo `entrega_mercaderia` — este rollback simplemente reafirma el
 *     estado deseado. Es seguro correrlo dos veces.
 *
 * Data safety:
 *   - No hay riesgo de perder datos: el tipo `entrega_mercaderia` nunca llegó
 *     a producción con datos reales (la UI del PR #649 se mergeó y revirtió
 *     dentro de la misma tarde, sin uso operativo real por parte de tenants).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE proveedor_movimientos DROP CONSTRAINT IF EXISTS proveedor_movimientos_tipo_check;
    ALTER TABLE proveedor_movimientos ADD CONSTRAINT proveedor_movimientos_tipo_check
      CHECK (tipo IN ('compra','pago','saldo_inicial','devolucion'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE proveedor_movimientos DROP CONSTRAINT IF EXISTS proveedor_movimientos_tipo_check;
    ALTER TABLE proveedor_movimientos ADD CONSTRAINT proveedor_movimientos_tipo_check
      CHECK (tipo IN ('compra','pago','saldo_inicial','devolucion','entrega_mercaderia'));
  `);
};

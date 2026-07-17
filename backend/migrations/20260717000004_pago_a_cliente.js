/* eslint-disable camelcase */
/**
 * Feature — movimientos_cc.tipo = 'pago_a_cliente'.
 *
 * Contexto (2026-07-17): tras el feature `mercaderia_recibida` (task #155),
 * Lucas identificó la simetría inversa: así como el cliente puede darnos
 * mercadería para cancelar deuda, nosotros podríamos DARLE dinero (por
 * ejemplo, devolverle un cobro de más, un reembolso, o simplemente un
 * anticipo). Hoy no hay un tipo que modele "yo le doy dinero al cliente" —
 * `pago` es unidireccional (el cliente nos paga a nosotros).
 *
 * Semántica del nuevo tipo:
 *   - Requiere caja_id: la plata sale de UNA caja específica (mismo pattern
 *     que `pago`).
 *   - Efecto en caja: EGRESO (opuesto a `pago` que es ingreso).
 *   - Efecto en saldo del cliente: +monto_total (opuesto a `pago` que es
 *     -monto_total). Si el cliente ya nos debía 100 y le damos 50, ahora
 *     nos debe 150. Si tenía saldo a favor de -50 y le devolvemos 50, ahora
 *     su saldo es 0 (cancelamos el crédito).
 *
 * Cambios:
 *   1. Extender CHECK: agregar 'pago_a_cliente' al set de valores válidos.
 *      Incluye todos los tipos ya existentes (compra, pago, devolucion,
 *      parte_de_pago, entrega_mercaderia, saldo_inicial, mercaderia_recibida
 *      del task #155).
 *
 * Idempotencia:
 *   - DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT: seguro en replay.
 *
 * Data safety:
 *   - Aditivo puro. Ningún cambio a filas existentes.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE movimientos_cc DROP CONSTRAINT IF EXISTS movimientos_cc_tipo_check;
    ALTER TABLE movimientos_cc ADD CONSTRAINT movimientos_cc_tipo_check
      CHECK (tipo IN ('compra','pago','devolucion','parte_de_pago','entrega_mercaderia','saldo_inicial','mercaderia_recibida','pago_a_cliente'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE movimientos_cc DROP CONSTRAINT IF EXISTS movimientos_cc_tipo_check;
    ALTER TABLE movimientos_cc ADD CONSTRAINT movimientos_cc_tipo_check
      CHECK (tipo IN ('compra','pago','devolucion','parte_de_pago','entrega_mercaderia','saldo_inicial','mercaderia_recibida'));
  `);
};

/* eslint-disable camelcase */
/**
 * Feature — movimientos_cc.tipo = 'entrega_dinero'.
 *
 * Contexto (2026-07-17): Lucas pidió distinguir dos flujos que tienen
 * exactamente el mismo efecto contable pero significados operativos
 * distintos, para que el histórico del cliente los muestre diferente:
 *
 *   - `pago_a_cliente` ("Le pago") — reintegro / devolución de algo que
 *     le debíamos al cliente (ej: le pagué de más antes, ahora le devuelvo).
 *   - `entrega_dinero`  ("Doy")   — dinero puntual que le doy sin base en
 *     una devolución (ej: le doy cambio, adelanto, favor). Aumenta su
 *     deuda con nosotros (o cancela su crédito a favor).
 *
 * Ambos: sale plata de MI caja (EGRESO) y sube el saldo del cliente.
 * El backend los trata en el MISMO branch del endpoint por eficiencia
 * (ver routes/cuentas.js). La diferencia vive en el `tipo` persistido
 * y en el label que muestra el frontend / los reportes.
 *
 * Cambios:
 *   1. Extender CHECK: agregar 'entrega_dinero' al set de valores válidos.
 *      Incluye todos los tipos existentes (compra, pago, devolucion,
 *      parte_de_pago, entrega_mercaderia, saldo_inicial, mercaderia_recibida,
 *      pago_a_cliente).
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
      CHECK (tipo IN ('compra','pago','devolucion','parte_de_pago','entrega_mercaderia','saldo_inicial','mercaderia_recibida','pago_a_cliente','entrega_dinero'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE movimientos_cc DROP CONSTRAINT IF EXISTS movimientos_cc_tipo_check;
    ALTER TABLE movimientos_cc ADD CONSTRAINT movimientos_cc_tipo_check
      CHECK (tipo IN ('compra','pago','devolucion','parte_de_pago','entrega_mercaderia','saldo_inicial','mercaderia_recibida','pago_a_cliente'));
  `);
};

/* eslint-disable camelcase */
/**
 * Extiende el CHECK constraint `cambio_movimientos.tipo` con la dirección
 * INVERSA — les entregás USD y te devuelven ARS/UYU.
 *
 * 2026-07-14 (feature reportado por Lucas): el módulo Cambios de Divisa nació
 * y evolucionó hasta ahora en UNA sola dirección:
 *   · Le doy ARS/UYU → me deben USD    (tipos 'entrega_ars', 'entrega_uyu')
 *   · Me devuelven USD                  (tipos 'recibo_usd', 'recibo_usd_uy')
 *
 * Lucas necesita agregar la operación inversa (ocurre frecuente):
 *   · Le doy USD → me deben ARS/UYU     (tipos NUEVOS 'entrega_usd_por_ars',
 *                                        'entrega_usd_por_uyu')
 *   · Me devuelven ARS/UYU              (tipos NUEVOS 'recibo_ars', 'recibo_uyu')
 *
 * Semántica:
 *   entrega_usd_por_ars    → egreso caja USD (monto=usd, moneda=USD, tc requerido)
 *                            La financiera queda debiendo ARS (usd × tc).
 *   entrega_usd_por_uyu    → egreso caja USD (monto=usd, moneda=USD, tc requerido)
 *                            La financiera queda debiendo UYU (usd × tc).
 *   recibo_ars             → ingreso caja ARS (monto=ars, moneda=ARS, sin tc)
 *                            Cancela deuda ARS de la financiera.
 *   recibo_uyu             → ingreso caja UYU (monto=uyu, moneda=UYU, sin tc)
 *                            Cancela deuda UYU de la financiera.
 *
 * Con esto una entidad puede tener 3 saldos simultáneos (USD/ARS/UYU) si mezcla
 * ambas direcciones. El route lo calcula por moneda y el frontend lo muestra.
 *
 * Idempotente: DROP CONSTRAINT + ADD CONSTRAINT — se puede correr N veces sin
 * efecto colateral. Igual pattern que el migration UYU del 2026-07-06.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE cambio_movimientos DROP CONSTRAINT IF EXISTS cambio_movimientos_tipo_check;
    ALTER TABLE cambio_movimientos ADD CONSTRAINT cambio_movimientos_tipo_check
      CHECK (tipo IN (
        'entrega_ars',
        'entrega_uyu',
        'recibo_usd',
        'recibo_usd_uy',
        'entrega_usd_por_ars',
        'entrega_usd_por_uyu',
        'recibo_ars',
        'recibo_uyu'
      ));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revertir data primero: borrar filas de tipos nuevos (down solo se corre
    -- si el operador realmente quiere volver al set anterior, y no le sirve
    -- lo nuevo). Alternativa más suave: dejar filas y solo restringir el
    -- CHECK — falla ADD CONSTRAINT por violación existente. Este DELETE es
    -- destructivo por design (mismo criterio que la migration UYU previa).
    DELETE FROM cambio_movimientos WHERE tipo IN (
      'entrega_usd_por_ars', 'entrega_usd_por_uyu', 'recibo_ars', 'recibo_uyu'
    );

    ALTER TABLE cambio_movimientos DROP CONSTRAINT IF EXISTS cambio_movimientos_tipo_check;
    ALTER TABLE cambio_movimientos ADD CONSTRAINT cambio_movimientos_tipo_check
      CHECK (tipo IN ('entrega_ars','recibo_usd','entrega_uyu','recibo_usd_uy'));
  `);
};

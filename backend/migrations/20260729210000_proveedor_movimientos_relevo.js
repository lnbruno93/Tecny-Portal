/* eslint-disable camelcase */
/**
 * Migración — extender proveedor_movimientos.tipo con 'relevo_incremento' y
 * 'relevo_reduccion'.
 *
 * Feature RELEVO Proveedores (2026-07-29): ajuste manual del saldo de un
 * proveedor contra la realidad. Casos de uso: pago olvidado en efectivo,
 * compra no cargada, devolución no registrada, mobiliario intercambiado, etc.
 *
 * ── ¿Por qué 2 tipos separados y no uno solo? ──────────────────────────
 *
 * Convención del sistema: `proveedor_movimientos.monto` y `monto_usd` tienen
 * CHECK constraint `>= 0`. NO se permiten montos negativos en la tabla
 * (invariante contable — signo va en el campo `tipo`).
 *
 * Un relevo puede aumentar la deuda (les debemos MÁS de lo que dice el
 * sistema) o reducirla (les debemos MENOS). Como monto es siempre positivo,
 * necesitamos 2 tipos para distinguir el signo:
 *   - `relevo_incremento`: aumenta la deuda con el proveedor (+monto_usd)
 *   - `relevo_reduccion`:  reduce la deuda con el proveedor (-monto_usd)
 *
 * El user NO ve la diferencia entre los 2 tipos — el frontend muestra
 * ambos como "Relevo — ajuste manual" con badge distintivo. La distinción
 * es interna para que la fórmula SALDO_CASE de `lib/saldoProveedor.js`
 * sea limpia (sin lógica de signo condicional en el CASE).
 *
 * Handler del endpoint POST /:id/relevo (routes/proveedores.js):
 *   1. Calcula delta = saldo_nuevo - saldo_actual.
 *   2. Si delta > 0 → tipo='relevo_incremento', monto=delta.
 *   3. Si delta < 0 → tipo='relevo_reduccion', monto=abs(delta).
 *
 * SALDO_CASE (actualizado en lib/saldoProveedor.js en el mismo PR):
 *   WHEN tipo = 'relevo_incremento' THEN +monto_usd
 *   WHEN tipo = 'relevo_reduccion'  THEN -monto_usd
 *
 * ── Reversibilidad ──────────────────────────────────────────────────────
 *
 * `down()` remueve los 2 tipos del CHECK. Si existen filas con esos tipos
 * (relevos ya ejecutados), el constraint nuevo fallará — hay que migrar o
 * soft-deletar esas filas antes del down.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE proveedor_movimientos DROP CONSTRAINT IF EXISTS proveedor_movimientos_tipo_check;
    ALTER TABLE proveedor_movimientos ADD CONSTRAINT proveedor_movimientos_tipo_check
      CHECK (tipo IN ('compra','pago','saldo_inicial','devolucion','relevo_incremento','relevo_reduccion'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revertir al set previo (sin relevos). Si quedan filas con los 2 tipos
    -- de relevo, el constraint nuevo fallará. Para bajar:
    --   1. SELECT id FROM proveedor_movimientos WHERE tipo IN ('relevo_incremento','relevo_reduccion');
    --   2. Decidir: soft-delete (UPDATE deleted_at) o migrar a otro tipo (raro).
    --   3. Correr el down.
    ALTER TABLE proveedor_movimientos DROP CONSTRAINT IF EXISTS proveedor_movimientos_tipo_check;
    ALTER TABLE proveedor_movimientos ADD CONSTRAINT proveedor_movimientos_tipo_check
      CHECK (tipo IN ('compra','pago','saldo_inicial','devolucion'));
  `);
};

/* eslint-disable camelcase */
/**
 * Fase 2a — Ledger central de cajas (saldo y movimientos por caja).
 *
 * - metodos_pago.saldo_inicial: saldo de apertura de cada caja (en su moneda).
 * - caja_movimientos: libro mayor por caja. Cada ingreso/egreso de cualquier
 *   módulo (venta, b2b, financiera, envío, egreso, proveedor, ajuste) inserta
 *   una fila acá. El saldo de una caja = saldo_inicial + Σ ingresos − Σ egresos.
 *
 * `monto` está en la moneda de la caja; `monto_usd` se guarda para totales
 * cruzados entre cajas de distinta moneda. origen + ref_tabla + ref_id permiten
 * trazar y revertir el movimiento desde su registro de origen (Fase 2b).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE metodos_pago
      ADD COLUMN IF NOT EXISTS saldo_inicial NUMERIC(14,2) NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS caja_movimientos (
      id          SERIAL PRIMARY KEY,
      caja_id     INTEGER       NOT NULL REFERENCES metodos_pago(id) ON DELETE CASCADE,
      fecha       DATE          NOT NULL,
      tipo        TEXT          NOT NULL CHECK (tipo IN ('ingreso','egreso')),
      monto       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monto >= 0),
      monto_usd   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monto_usd >= 0),
      origen      TEXT          NOT NULL DEFAULT 'ajuste'
                    CHECK (origen IN ('venta','b2b','financiera','envio','egreso','proveedor','ajuste','transferencia')),
      ref_tabla   TEXT,
      ref_id      INTEGER,
      concepto    TEXT,
      user_id     INTEGER       REFERENCES users(id) ON DELETE SET NULL,
      deleted_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ   DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_caja_mov_caja  ON caja_movimientos (caja_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_caja_mov_fecha ON caja_movimientos (fecha DESC) WHERE deleted_at IS NULL;
    -- Lookup para revertir un movimiento desde su registro de origen (Fase 2b)
    CREATE INDEX IF NOT EXISTS idx_caja_mov_origen ON caja_movimientos (ref_tabla, ref_id) WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS caja_movimientos CASCADE;
    ALTER TABLE metodos_pago DROP COLUMN IF EXISTS saldo_inicial;
  `);
};

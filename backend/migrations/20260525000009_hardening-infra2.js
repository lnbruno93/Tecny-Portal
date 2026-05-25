/* eslint-disable camelcase */
/**
 * Hardening de infraestructura (tanda 2) — solidez + escalabilidad.
 *
 *  · Índice compuesto para las vistas de ledger (global y por caja): filtran por
 *    caja_id y ordenan por (fecha DESC, id DESC). Espejo del que ya existe en
 *    movimientos_cc.
 *  · UNIQUE parcial en comprobantes(venta_id) entre filas activas: evita que dos
 *    adjuntos concurrentes de la misma venta dupliquen el comprobante de Financiera.
 *  · CHECK ≥ 0 en saldos/montos que el negocio nunca debería tener negativos
 *    (defensa en profundidad, consistente con la migración 0007 de constraints).
 *
 * Todo aditivo e idempotente. Los datos existentes ya cumplen (los schemas Zod
 * fuerzan montos ≥ 0 / > 0 y saldo_inicial arranca en 0).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1) Índice compuesto para el ORDER BY del ledger filtrando por caja
    CREATE INDEX IF NOT EXISTS idx_caja_mov_caja_fecha
      ON caja_movimientos (caja_id, fecha DESC, id DESC)
      WHERE deleted_at IS NULL;

    -- 2) Un solo comprobante de Financiera activo por venta
    CREATE UNIQUE INDEX IF NOT EXISTS uq_comprobantes_venta_activo
      ON comprobantes (venta_id)
      WHERE venta_id IS NOT NULL AND deleted_at IS NULL;

    -- 3) CHECK ≥ 0 (idempotentes vía guarda en pg_constraint)
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_mp_saldo_inicial') THEN
        ALTER TABLE metodos_pago ADD CONSTRAINT chk_mp_saldo_inicial CHECK (saldo_inicial >= 0);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_movcc_monto_total') THEN
        ALTER TABLE movimientos_cc ADD CONSTRAINT chk_movcc_monto_total CHECK (monto_total >= 0);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_envio_items_monto') THEN
        ALTER TABLE envio_items ADD CONSTRAINT chk_envio_items_monto CHECK (monto >= 0);
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE envio_items   DROP CONSTRAINT IF EXISTS chk_envio_items_monto;
    ALTER TABLE movimientos_cc DROP CONSTRAINT IF EXISTS chk_movcc_monto_total;
    ALTER TABLE metodos_pago  DROP CONSTRAINT IF EXISTS chk_mp_saldo_inicial;
    DROP INDEX IF EXISTS uq_comprobantes_venta_activo;
    DROP INDEX IF EXISTS idx_caja_mov_caja_fecha;
  `);
};

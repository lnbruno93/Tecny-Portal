/* eslint-disable camelcase */
/**
 * Migración — `pagos` (financiera) agrega 3 columnas para soportar el flujo
 * real de cancelación de saldo (junio 2026, espejo del cambio de Tarjetas):
 *
 *   La financiera le paga a Lucas en USD a un TC del día, cancelando el
 *   saldo ARS pendiente con la financiera. Hasta ahora el endpoint POST
 *   /api/pagos solo guardaba un registro plano (fecha + monto ARS + ref) —
 *   no impactaba ninguna caja. Eso dejaba un "pago fantasma" que no se veía
 *   en Cajas/360.
 *
 *   A partir de ahora cada pago apunta a una caja destino real (ARS o USD).
 *   El monto ARS sigue descontando del saldo pendiente con la financiera
 *   (= sum(comprobantes.neto) − sum(pagos.monto)); el ingreso a la caja
 *   destino va en su moneda (USD si se convirtió, ARS si no).
 *
 * Columnas:
 *   - caja_id   INTEGER NULL REFERENCES metodos_pago(id)
 *               Caja destino del ingreso. NULL en pagos legacy (registros
 *               históricos pre-cambio). Para pagos NUEVOS, el backend lo
 *               valida como obligatorio en el schema Zod.
 *   - tc        NUMERIC(18,6) NULL
 *               TC ARS→USD usado si se convirtió. NULL si pago directo en ARS.
 *   - monto_usd NUMERIC(14,2) NULL
 *               USD que entró efectivamente a la caja. NULL si pago en ARS.
 *
 * CHECKs:
 *   - tc > 0 si no es NULL.
 *   - monto_usd > 0 si no es NULL.
 *   - Si caja_id es USD/USDT debe haber tc + monto_usd (defensa contra
 *     incoherencia ahora que opt-in es la norma).
 *     → Esa validación NO se hace en CHECK constraint (necesitaría JOIN
 *       contra metodos_pago.moneda); la aplicamos en el endpoint y test.
 *
 * Nullable → migración no destructiva, datos existentes mantienen NULL.
 * Index sobre caja_id para que reverseCajaMovimientos en delete (cuando
 * busca por ref_id, no caja_id, pero las consultas de Cajas que filtran
 * por caja_id se aceleran).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE pagos
      ADD COLUMN IF NOT EXISTS caja_id   INTEGER       NULL REFERENCES metodos_pago(id),
      ADD COLUMN IF NOT EXISTS tc        NUMERIC(18,6) NULL,
      ADD COLUMN IF NOT EXISTS monto_usd NUMERIC(14,2) NULL;

    DO $$
    BEGIN
      ALTER TABLE pagos
        ADD CONSTRAINT pagos_tc_positivo
        CHECK (tc IS NULL OR tc > 0);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$
    BEGIN
      ALTER TABLE pagos
        ADD CONSTRAINT pagos_monto_usd_positivo
        CHECK (monto_usd IS NULL OR monto_usd > 0);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- TC y monto_usd vienen juntos (si convirtió, ambos están; si no, ambos NULL).
    DO $$
    BEGIN
      ALTER TABLE pagos
        ADD CONSTRAINT pagos_tc_y_usd_juntos
        CHECK ((tc IS NULL AND monto_usd IS NULL) OR (tc IS NOT NULL AND monto_usd IS NOT NULL));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_pagos_caja_id ON pagos (caja_id) WHERE caja_id IS NOT NULL;

    COMMENT ON COLUMN pagos.caja_id IS
      'Caja destino del ingreso (ARS o USD). NULL solo en pagos legacy pre-junio-2026. Pagos nuevos lo requieren.';
    COMMENT ON COLUMN pagos.tc IS
      'TC ARS→USD usado si se convirtió. NULL si pago directo en ARS.';
    COMMENT ON COLUMN pagos.monto_usd IS
      'USD que entró a la caja destino. NULL si pago en ARS sin conversión.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_pagos_caja_id;
    ALTER TABLE pagos
      DROP CONSTRAINT IF EXISTS pagos_tc_y_usd_juntos,
      DROP CONSTRAINT IF EXISTS pagos_monto_usd_positivo,
      DROP CONSTRAINT IF EXISTS pagos_tc_positivo,
      DROP COLUMN IF EXISTS monto_usd,
      DROP COLUMN IF EXISTS tc,
      DROP COLUMN IF EXISTS caja_id;
  `);
};

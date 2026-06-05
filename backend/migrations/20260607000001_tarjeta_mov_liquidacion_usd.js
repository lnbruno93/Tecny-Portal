/* eslint-disable camelcase */
/**
 * Migración — `tarjeta_movimientos` agrega 3 columnas para soportar el flujo
 * real de liquidación que tiene Lucas con su financiera (junio 2026):
 *
 *   1. Las planillas que le manda la financiera (2 veces por semana) cubren
 *      un RANGO de días (ej. "26-27/5"), no un día único. Guardar el rango
 *      en cada mov permite conciliar contra los cupones vendidos en el
 *      rango cuando hay dudas.
 *
 *   2. Casi siempre Lucas convierte los pesos a dólares el mismo día de la
 *      liquidación (lunes/jueves). La financiera le informa el TC del día
 *      y le deposita los USD directo. Hasta ahora eso requería 2 operaciones
 *      (liquidar a caja ARS + cambio de divisa). Con `tc` guardado en el mov
 *      de liquidación, se hace en UN solo paso: la liquidación sigue bajando
 *      el pendiente en ARS, pero el ingreso final entra a una caja USD con
 *      el TC informado.
 *
 * Columnas:
 *   - periodo_desde  DATE NULL — fecha del primer cupón cubierto por la liq.
 *   - periodo_hasta  DATE NULL — fecha del último cupón cubierto.
 *                    Ambas nullable: las liquidaciones del histórico no tienen
 *                    rango (se cargaron sin esa info) y los cobros previos
 *                    tampoco aplican.
 *   - tc             NUMERIC(18,6) NULL — TC usado en la conversión a USD.
 *                    NULL si no hubo conversión (caja destino = misma moneda
 *                    que la tarjeta). Solo aplica a tipo='liquidacion'.
 *
 * CHECK constraint defensivo: si tc no es NULL, debe ser positivo.
 * periodo_desde <= periodo_hasta cuando ambos están presentes.
 *
 * Nullable → migración no destructiva, datos existentes mantienen NULL.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tarjeta_movimientos
      ADD COLUMN IF NOT EXISTS periodo_desde DATE NULL,
      ADD COLUMN IF NOT EXISTS periodo_hasta DATE NULL,
      ADD COLUMN IF NOT EXISTS tc            NUMERIC(18,6) NULL;

    -- TC siempre positivo si está cargado. CHECK no IF NOT EXISTS — ANCSI
    -- no lo soporta para constraints; usamos DO BLOCK con catch.
    DO $$
    BEGIN
      ALTER TABLE tarjeta_movimientos
        ADD CONSTRAINT tarjeta_movimientos_tc_positivo
        CHECK (tc IS NULL OR tc > 0);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- Si ambos límites del período están, desde <= hasta.
    DO $$
    BEGIN
      ALTER TABLE tarjeta_movimientos
        ADD CONSTRAINT tarjeta_movimientos_periodo_orden
        CHECK (periodo_desde IS NULL OR periodo_hasta IS NULL OR periodo_desde <= periodo_hasta);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    COMMENT ON COLUMN tarjeta_movimientos.periodo_desde IS
      'Fecha del primer cupón cubierto por la liquidación (info de la planilla de la financiera). Nullable.';
    COMMENT ON COLUMN tarjeta_movimientos.periodo_hasta IS
      'Fecha del último cupón cubierto. Nullable.';
    COMMENT ON COLUMN tarjeta_movimientos.tc IS
      'TC ARS→USD usado si la liquidación se depositó en USD. NULL si la caja destino era ARS (sin conversión).';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tarjeta_movimientos
      DROP CONSTRAINT IF EXISTS tarjeta_movimientos_periodo_orden,
      DROP CONSTRAINT IF EXISTS tarjeta_movimientos_tc_positivo,
      DROP COLUMN IF EXISTS tc,
      DROP COLUMN IF EXISTS periodo_hasta,
      DROP COLUMN IF EXISTS periodo_desde;
  `);
};

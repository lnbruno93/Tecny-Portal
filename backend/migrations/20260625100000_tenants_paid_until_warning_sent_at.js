/**
 * Migration: tenants.paid_until_warning_sent_at (TANDA 4.D billing 2026-06-25).
 *
 * Contexto: el cron `paidUntilWarningJob` corre cada 24h y manda email a los
 * tenants con paid_until ∈ [hoy, hoy+3d]. Para evitar mandar el mismo
 * recordatorio cada 24h (cron re-corre + tenant sigue por vencer) trackeamos
 * cuándo fue el último warning con esta columna.
 *
 * Lógica del cron:
 *   1. SELECT tenants WHERE paid_until ∈ [today, today+3]
 *      AND (paid_until_warning_sent_at IS NULL OR paid_until_warning_sent_at < paid_until - INTERVAL '7 days')
 *      AND deleted_at IS NULL
 *      AND suspended_at IS NULL
 *   2. Para cada uno: send mail + UPDATE paid_until_warning_sent_at = NOW().
 *
 * El check `< paid_until - 7d` permite que si Lucas renueva (paid_until salta
 * hacia el futuro), el warning se vuelva a mandar cuando ese nuevo período
 * esté por vencer. Sin esa lógica, una vez warneado nunca más recibe aviso.
 *
 * Diseño NULL-by-default: tenants existentes no van a recibir un warning
 * inmediato post-deploy. Solo se warneará cuando el cron detecte que
 * paid_until está cerca + nunca se mandó warning para ese período.
 *
 * Por qué columna y no audit_logs: audit_logs particionado por mes + filtrado
 * por tenant_id sería costoso de querear en cada pasada. Columna en tenants
 * es O(1) por tenant.
 *
 * Reversible.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN paid_until_warning_sent_at TIMESTAMPTZ;

    -- Index parcial para el cron: solo trackea tenants que YA recibieron
    -- warning (los NULL son la mayoría y no necesitan estar en el index).
    -- El cron filtra principalmente por paid_until, así que este index es
    -- secundario. idx_tenants_paid_until ya existe y es el principal.
    CREATE INDEX idx_tenants_paid_until_warning_sent
      ON tenants(paid_until_warning_sent_at)
      WHERE paid_until_warning_sent_at IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_tenants_paid_until_warning_sent;
    ALTER TABLE tenants DROP COLUMN IF EXISTS paid_until_warning_sent_at;
  `);
};

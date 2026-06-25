/**
 * Migration: tenants.paid_until DATE (TANDA 4.A.1 — billing pre-live 2026-06-25).
 *
 * Contexto: el portal lanza con cobranza manual ("transferencia + admin
 * marca paid_until"). Hasta ahora teníamos `trial_until` (solo plan='trial')
 * pero faltaba el concepto general "hasta qué fecha este tenant pagó".
 *
 * Diseño:
 *   - `paid_until DATE` aplica a TODOS los planes:
 *       - Trial   → fecha de fin del trial (= trial_until originalmente)
 *       - Starter / Pro / Enterprise → fecha pagada hasta (manual por admin)
 *   - `paid_until IS NULL` → tenant grandfathered / sin enforcement
 *       (semántica: "activo indefinidamente"). Útil para:
 *         * Tenant interno del operador (Tecny mismo)
 *         * Enterprise con contrato anual papel sin necesidad de tracking diario
 *         * Migración: usuarios existentes pre-billing no se rompen
 *   - `paid_until >= CURRENT_DATE` → activo
 *   - `paid_until <  CURRENT_DATE` → expirado (middleware bloquea writes,
 *      banner rojo en frontend)
 *
 * Por qué no unificamos con `trial_until`:
 *   - `trial_until` tiene CHECK (trial_until IS NULL OR plan = 'trial') que
 *     ata su semántica al trial. Cambiar eso requiere drop + re-add CHECK
 *     + decidir qué pasa con datos existentes.
 *   - Más simple agregar paid_until como concepto nuevo, backfill trial
 *     a partir de trial_until, dejar trial_until para compatibilidad
 *     (signup.js sigue seteando ambos por ahora; pueden converger después).
 *
 * Index: filtramos por paid_until <= NOW() + 3 days para mandar mails de
 * warning, y por paid_until < CURRENT_DATE para mostrar como expirados.
 * Partial index sobre paid_until IS NOT NULL — los grandfathered (NULL)
 * no consumen entradas.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN paid_until DATE;

    -- Backfill: trial tenants heredan paid_until de trial_until. Los no-trial
    -- (starter/pro/enterprise existentes) quedan en NULL (grandfathered —
    -- admin los setea explícitamente cuando facture el primer mes).
    UPDATE tenants SET paid_until = trial_until WHERE trial_until IS NOT NULL;

    -- Index para queries de billing: cron que manda mail "tu cuenta vence
    -- en N días" + cron que detecta expirados para batch. Partial → solo
    -- tracks rows con paid_until set, los grandfathered no inflan el index.
    CREATE INDEX idx_tenants_paid_until
      ON tenants(paid_until) WHERE paid_until IS NOT NULL;

    -- Agregar 'paid_until_update' al CHECK de tenant_admin_actions para el
    -- audit trail del PATCH paid-until del admin.
    ALTER TABLE tenant_admin_actions DROP CONSTRAINT tenant_admin_actions_action_check;
    ALTER TABLE tenant_admin_actions ADD CONSTRAINT tenant_admin_actions_action_check
      CHECK (action IN (
        'plan_change',
        'suspend',
        'reactivate',
        'trial_extend',
        'note_update',
        'custom_mrr_update',
        'bootstrap_super_admin',
        'plan_price_change',
        'paid_until_update'
      ));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revertir CHECK de tenant_admin_actions a la versión previa.
    -- IMPORTANTE: si hay filas con action='paid_until_update', el ADD CONSTRAINT
    -- falla — el operador debe DELETE esas filas antes de revertir.
    ALTER TABLE tenant_admin_actions DROP CONSTRAINT tenant_admin_actions_action_check;
    ALTER TABLE tenant_admin_actions ADD CONSTRAINT tenant_admin_actions_action_check
      CHECK (action IN (
        'plan_change',
        'suspend',
        'reactivate',
        'trial_extend',
        'note_update',
        'custom_mrr_update',
        'bootstrap_super_admin',
        'plan_price_change'
      ));

    DROP INDEX IF EXISTS idx_tenants_paid_until;
    ALTER TABLE tenants DROP COLUMN IF EXISTS paid_until;
  `);
};

/**
 * Multi-país F2: extender CHECK de tenant_admin_actions.action para incluir
 * 'tc_default_pais_updated' (super-admin actualiza TC default por país desde
 * la UI admin).
 *
 * Contexto:
 *   El endpoint PATCH /api/super-admin/tc-defaults-pais permite al super-admin
 *   actualizar el TC default (ARS/USD ~1400 o UYU/USD ~40). El cambio es
 *   sensible (pre-rellena formularios de TODOS los tenants del país) y queda
 *   loggeado en `tenant_admin_actions` con before/after del valor.
 *
 *   Patrón idéntico a los CHECK extensions previos (20260626*, 20260627*,
 *   20260628*, 20260629000002) — drop + re-add con la nueva action.
 *
 * Audit trail:
 *   `tenant_admin_actions.tenant_id` queda en 1 (Tecny, el "tenant" del
 *   super-admin que hizo el cambio) — mismo patrón que `plan_price_change`,
 *   porque el TC default es config global (no per-tenant).
 *
 * Reversible. Down restaura el CHECK pre-F2.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
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
        'paid_until_update',
        'delete',
        'rename',
        'create',
        'cross_tenant_partnership_created',
        'cross_tenant_partnership_revoked',
        'cross_tenant_op_created',
        'cross_tenant_op_cancelled',
        'cross_tenant_op_modified',
        'cross_tenant_pago_registered',
        'cross_tenant_devolucion',
        'cross_tenant_caja_default_updated',
        'cross_tenant_email_prefs_updated',
        -- F2 nueva:
        'tc_default_pais_updated'
      ));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
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
        'paid_until_update',
        'delete',
        'rename',
        'create',
        'cross_tenant_partnership_created',
        'cross_tenant_partnership_revoked',
        'cross_tenant_op_created',
        'cross_tenant_op_cancelled',
        'cross_tenant_op_modified',
        'cross_tenant_pago_registered',
        'cross_tenant_devolucion',
        'cross_tenant_caja_default_updated',
        'cross_tenant_email_prefs_updated'
      ));
  `);
};

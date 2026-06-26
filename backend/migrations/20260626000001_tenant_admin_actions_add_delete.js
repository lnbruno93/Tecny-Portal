/**
 * Migration: agregar 'delete' al enum de tenant_admin_actions.action.
 *
 * Contexto: nueva feature en el back office para que el super-admin pueda
 * eliminar tenants desde la UI (en vez de SQL manual). Soft-delete
 * (UPDATE tenants SET deleted_at = NOW()) — recuperable por cron de
 * hard-delete a >30 días (futuro).
 *
 * Sin esta migration el INSERT al audit trail con action='delete' rebota
 * con CHECK violation. Mismo patrón que paid_until_update agregada en
 * 20260625000001 y plan_price_change en 20260622153000.
 *
 * Reversible. Down requiere que NO existan filas con action='delete'
 * (lo más probable es que existan post-feature, en cuyo caso el operador
 * debe DELETE esas filas antes de revertir).
 */
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
        'delete'
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
        'paid_until_update'
      ));
  `);
};

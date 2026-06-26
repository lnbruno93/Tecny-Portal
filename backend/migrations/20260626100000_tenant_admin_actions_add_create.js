/**
 * Migration: agregar 'create' al enum de tenant_admin_actions.action (#452).
 *
 * Contexto: feature "Crear tenant manual" en el back office. El super-admin
 * puede onboardear un cliente desde la UI (caso típico: demo cerrada en
 * sales call, tenant pre-creado antes del primer login del owner). Sin
 * esta migration el INSERT al audit trail con action='create' rebota con
 * CHECK violation.
 *
 * Mismo patrón que las migrations de 'delete' (#438), 'rename' (#439),
 * 'paid_until_update', 'plan_price_change' — el enum crece monotónico.
 *
 * Reversible. Down requiere que NO existan filas con action='create'
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
        'delete',
        'rename',
        'create'
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
        'rename'
      ));
  `);
};

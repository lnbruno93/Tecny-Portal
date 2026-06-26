/**
 * Migration: agregar 'rename' al enum de tenant_admin_actions.action (#439).
 *
 * Contexto: nueva feature en el back office para que el super-admin pueda
 * cambiar el `nombre` y/o `slug` de un tenant desde la UI (en vez de SQL).
 * Motivado por el caso del tenant 1 ("Tecny" → "iPro / Celnyx") y por
 * clientes que cambian razón social y quieren ver el nombre nuevo en el
 * portal.
 *
 * Sin esta migration el INSERT al audit trail con action='rename' rebota
 * con CHECK violation. Mismo patrón que la migration de 'delete' del PR
 * anterior (#438) y plan_price_change (#353).
 *
 * Reversible. Down requiere que NO existan filas con action='rename'
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
        'rename'
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
        'delete'
      ));
  `);
};

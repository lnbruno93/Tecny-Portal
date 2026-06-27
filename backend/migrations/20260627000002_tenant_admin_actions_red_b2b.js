/**
 * Migration: agregar 'cross_tenant_partnership_created' y
 * 'cross_tenant_partnership_revoked' al enum tenant_admin_actions.action.
 *
 * Contexto: Red B2B F1 (#454). Cuando se invita/acepta o se revoca una
 * partnership, el endpoint loguea la acción al audit trail genérico de
 * acciones admin del tenant. Sin esta migration el INSERT rebota con
 * CHECK violation.
 *
 * Notas:
 *   - Usamos el audit trail GENÉRICO (tenant_admin_actions) en vez de crear
 *     una tabla cross_tenant_actions dedicada: F1 sólo necesita registrar
 *     2 eventos, no vale la pena un schema nuevo. Si F3-F5 agregan
 *     varios eventos más, podemos extraer a una tabla dedicada en un
 *     refactor.
 *   - El super_admin_user_id de tenant_admin_actions queda con el user_id
 *     del invocador (que es operador del tenant, no super-admin) — el
 *     nombre del campo es histórico, en práctica es "quien actuó".
 *
 * Mismo patrón que migrations anteriores (delete/rename/create).
 * Reversible.
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
        'create',
        'cross_tenant_partnership_created',
        'cross_tenant_partnership_revoked'
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
        'create'
      ));
  `);
};

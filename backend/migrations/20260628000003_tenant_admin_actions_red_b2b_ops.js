/**
 * Migration: Red B2B F3 — extiende tenant_admin_actions con 3 actions
 * de operaciones cross-tenant.
 *
 * Diseño en docs/design/red-b2b-cross-tenant.md sección 6.2 (audit del flow).
 *
 * Actions agregadas:
 *   - cross_tenant_op_created    (POST /operations)
 *   - cross_tenant_op_cancelled  (POST /:id/cancel)
 *   - cross_tenant_op_modified   (PATCH /:id)
 *
 * Mismo patrón que migration 20260627000002_tenant_admin_actions_red_b2b
 * (F1 agregó los 2 actions de partnerships). La route F3 ya usa estos
 * actions; antes de esta migration el INSERT rebotaba con CHECK violation
 * 23514. El endpoint usa SAVEPOINT defensivo para no romper el flow core
 * si la migration no estuviera aplicada (transición), pero el audit log
 * se pierde — esta migration restaura el audit completo.
 *
 * Reversible. Mismo CHECK constraint que F1 + 3 valores nuevos.
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
        -- F3 nuevos:
        'cross_tenant_op_created',
        'cross_tenant_op_cancelled',
        'cross_tenant_op_modified'
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
        'cross_tenant_partnership_revoked'
      ));
  `);
};

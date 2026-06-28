/**
 * Migration: Red B2B F4 — extiende tenant_admin_actions con 2 actions
 * de pagos/devoluciones cross-tenant.
 *
 * Diseño en docs/design/red-b2b-cross-tenant.md sección 6.3 (pagos) +
 * decisión #11 (devoluciones).
 *
 * Actions agregadas:
 *   - cross_tenant_pago_registered  (POST /operations/:id/pagos)
 *   - cross_tenant_devolucion       (POST /operations/:id/devolucion)
 *
 * Total acumulado tras F1+F3+F4 = 7 actions cross-tenant en el CHECK
 * constraint. Mismo patrón que migration F3 (20260628000003).
 *
 * El bug crítico de F3 (CHECK violation 23514 aborta TX) está mitigado en
 * el endpoint con SAVEPOINT alrededor del audit — esta migration restaura
 * el audit completo cuando se aplica.
 *
 * Reversible. Down restaura el CHECK pre-F4 (con 5 actions F1+F3).
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
        -- F4 nuevos:
        'cross_tenant_pago_registered',
        'cross_tenant_devolucion'
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
        'cross_tenant_op_modified'
      ));
  `);
};

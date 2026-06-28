/**
 * Migration: Red B2B PR-C P1-4 — extiende tenant_admin_actions con 2
 * actions de mutaciones admin sobre la config Red B2B del tenant.
 *
 * Issue #462 — TANDA 0 PR-C (seguridad).
 *
 * Contexto:
 *   PATCH /api/red-b2b/config/caja-default y PATCH /api/red-b2b/config/
 *   email-prefs ahora están gateados por adminOnly + audit log. Las dos
 *   acciones son de impacto operacional importante:
 *     - caja-default: re-rutea dónde caen los pagos cross-tenant del lado
 *       nuestro (un cambio malicioso puede mover plata a otra caja).
 *     - email-prefs: silenciar las notifs por email (apagar
 *       invitation_received = el owner no se entera de nuevas
 *       invitaciones).
 *   Ambas acciones quedan loggeadas en tenant_admin_actions con
 *   before_state + after_state para reconstrucción forense.
 *
 * Actions agregadas:
 *   - cross_tenant_caja_default_updated  (PATCH /caja-default)
 *   - cross_tenant_email_prefs_updated   (PATCH /email-prefs)
 *
 * Patrón: DROP CONSTRAINT + ADD CONSTRAINT (idéntico al pattern de
 * 20260628100001 — las migraciones Red B2B suman valores al mismo CHECK
 * incrementalmente).
 *
 * Total acumulado tras F1+F3+F4+PR-C = 9 actions cross-tenant en el
 * CHECK constraint.
 *
 * Mitigación del bug histórico:
 *   Los endpoints PATCH ya envuelven el INSERT a tenant_admin_actions con
 *   SAVEPOINT (helper `audit` en config.js), así que aún si esta migration
 *   no se aplica todavía, el UPDATE de la caja/prefs igual persiste y solo
 *   se loggea warning. Esta migration restaura el audit completo.
 *
 * Reversible. Down restaura el CHECK pre-PR-C.
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
        -- PR-C nuevos:
        'cross_tenant_caja_default_updated',
        'cross_tenant_email_prefs_updated'
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
        'cross_tenant_devolucion'
      ));
  `);
};

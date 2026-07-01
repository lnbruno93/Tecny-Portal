/* eslint-disable camelcase */
/**
 * Migration: extender CHECK de tenant_admin_actions.action para las nuevas
 * actions del flow de invitaciones a co-super-admins (#499).
 *
 * Actions nuevas:
 *   - super_admin_invited          → POST /invite creó una invitación
 *   - super_admin_invite_revoked   → DELETE /invite/:id la revocó
 *   - super_admin_invite_resent    → POST /invite/:id/resend regeneró token
 *   - super_admin_invite_accepted  → POST /:token/accept (público) creó user
 *   - super_admin_revoked          → POST /revoke/:userId quitó is_super_admin
 *
 * Semántica de tenant_id del audit:
 *   Todas usan tenant_id=1 (Tecny), consistente con el anchor de acciones
 *   de super-admin no-tenant-scoped (plan_price_change, tc_default_pais_updated,
 *   bootstrap_super_admin). Ver rationale en la migration
 *   20260622153000_plan_prices_table.js.
 *
 * Actor semántico:
 *   - super_admin_invited/revoked/resend/revoked  → super_admin (el super-admin
 *                                                    caller ejecutó desde el back
 *                                                    office).
 *   - super_admin_invite_accepted                 → super_admin también, pero el
 *                                                    user es el nuevo super-admin
 *                                                    recién creado (self-action).
 *   El caller de superAdminTeam.js/publicSuperAdminInvite.js inserta con
 *   actor_type='super_admin' via default (D-22 migration 20260701000002).
 *
 * Idempotente: replicamos el pattern de #473 — DROP + ADD el CHECK con la
 * lista completa.
 *
 * Reversible. Down restaura el CHECK previo (con tenant_pais_changed pero
 * SIN las 5 nuevas).
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
        'tc_default_pais_updated',
        'tenant_pais_changed',
        -- #499 nuevas:
        'super_admin_invited',
        'super_admin_invite_revoked',
        'super_admin_invite_resent',
        'super_admin_invite_accepted',
        'super_admin_revoked'
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
        'cross_tenant_email_prefs_updated',
        'tc_default_pais_updated',
        'tenant_pais_changed'
      ));
  `);
};

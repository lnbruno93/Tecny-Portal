/**
 * Agregar `clases_merge` al CHECK de `tenant_admin_actions.action`.
 *
 * 2026-07-14 (feature): nuevo endpoint POST /super-admin/tenants/:id/clases-merge
 * escribe audit con action='clases_merge'. El CHECK actual no lo permite → fail.
 *
 * Pattern: DROP CHECK + CREATE CHECK con la nueva lista de acciones válidas.
 * PG no permite ALTER CONSTRAINT sobre CHECK; hay que dropear y recrear.
 *
 * Rollback (down): remueve `clases_merge` del CHECK. Si hay rows con action=
 * 'clases_merge', el ALTER falla (bien — evita perder tracking histórico).
 */

const ACTIONS = [
  'plan_change', 'suspend', 'reactivate', 'trial_extend', 'note_update',
  'custom_mrr_update', 'bootstrap_super_admin', 'plan_price_change',
  'paid_until_update', 'delete', 'rename', 'create',
  'cross_tenant_partnership_created', 'cross_tenant_partnership_revoked',
  'cross_tenant_op_created', 'cross_tenant_op_cancelled', 'cross_tenant_op_modified',
  'cross_tenant_pago_registered', 'cross_tenant_devolucion',
  'cross_tenant_caja_default_updated', 'cross_tenant_email_prefs_updated',
  'tc_default_pais_updated', 'tenant_pais_changed',
  'super_admin_invited', 'super_admin_invite_revoked', 'super_admin_invite_resent',
  'super_admin_invite_accepted', 'super_admin_revoked',
];
const ACTIONS_WITH_MERGE = [...ACTIONS, 'clases_merge'];

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenant_admin_actions DROP CONSTRAINT IF EXISTS tenant_admin_actions_action_check;
    ALTER TABLE tenant_admin_actions ADD CONSTRAINT tenant_admin_actions_action_check
      CHECK (action = ANY (ARRAY[${ACTIONS_WITH_MERGE.map(a => `'${a}'::text`).join(', ')}]));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenant_admin_actions DROP CONSTRAINT IF EXISTS tenant_admin_actions_action_check;
    ALTER TABLE tenant_admin_actions ADD CONSTRAINT tenant_admin_actions_action_check
      CHECK (action = ANY (ARRAY[${ACTIONS.map(a => `'${a}'::text`).join(', ')}]));
  `);
};

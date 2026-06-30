/**
 * Multi-país #473: extender CHECK de tenant_admin_actions.action para incluir
 * 'tenant_pais_changed' (super-admin cambia el país de un tenant existente
 * desde la UI admin).
 *
 * Contexto:
 *   El endpoint PATCH /api/super-admin/tenants/:id/pais permite al super-admin
 *   cambiar `tenants.pais` (AR↔UY) post-signup. Use case: cliente UY que
 *   signupeó pre-F4 (todos los tenants existentes tienen pais='AR' por backfill
 *   de la migration 20260629100001). Cambia cajas default + alerta TC, queda
 *   loggeado con before/after.
 *
 *   El design doc multi-pais-uyu.md §9 decision 1 fija que cambiar el país de
 *   un tenant es operación de super-admin (NO expuesto a UI normal). La action
 *   se nombra `tenant_pais_changed` (past-tense, consistente con
 *   `cross_tenant_partnership_revoked`, `cross_tenant_op_modified`, etc.).
 *
 *   Patrón idéntico a los CHECK extensions previos (20260626*, 20260627*,
 *   20260628*, 20260629*) — drop + re-add con la nueva action al final.
 *
 * Audit trail:
 *   `tenant_admin_actions.tenant_id` queda en el id del tenant cuyo país
 *   cambió (a diferencia de tc_default_pais_updated que va a tenant_id=1).
 *   Esto permite que el feed "Actividad admin" del Ficha del cliente muestre
 *   el cambio en la línea de tiempo del tenant afectado.
 *
 * Reversible. Down restaura el CHECK pre-#473 (con tc_default_pais_updated
 * pero sin tenant_pais_changed).
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
        -- #473 nueva:
        'tenant_pais_changed'
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
        'tc_default_pais_updated'
      ));
  `);
};

/**
 * HOTFIX post-F4 — backfill correcto del rol 'owner'/'admin' del tenant
 * en tenant_user_roles.
 *
 * Bug: la migration 20260623220000_capability_catalog.js seedea
 * tenant_user_roles a partir de users.role:
 *     CASE WHEN users.role = 'admin' THEN 'admin' ELSE 'custom' END
 *
 * Eso ignora tenant_users.rol — el campo donde signup.js viene escribiendo
 * el rol del tenant desde hace meses (con users.role='op' por seguridad
 * cross-tenant). Resultado: TODO owner self-signup quedó en
 * tenant_user_roles.rol='custom' con 0 overrides → locked out en prod
 * tras el deploy de F4 (su tenant_cap_rol='custom' no bypassa, y sin
 * user_capabilities no tiene ningún gate concedido).
 *
 * Esta migration corrige retroactivamente:
 *   · tenant_users.rol='owner' → tenant_user_roles.rol='owner'
 *   · tenant_users.rol='admin' → tenant_user_roles.rol='admin'
 *     (solo si la fila actual es 'custom' — no pisamos ediciones manuales
 *     posteriores al backfill via PUT /capabilities/users/:id)
 *
 * Reentrante: el UPDATE filtra por rol='custom' actual, así que correrlo
 * dos veces es no-op la segunda. Si un admin ya degradó manualmente a un
 * owner a 'vendedor' en la UI nueva, NO lo re-promueve.
 *
 * Migration data-only: sin DDL. RLS bypass via SET LOCAL row_security
 * (necesario porque tenant_user_roles tiene FORCE RLS y este UPDATE
 * abarca múltiples tenants en una sola transacción de migration).
 */

exports.up = async (pgm) => {
  // RLS bypass — la connection de migrations corre como tecny_admin
  // (NOSUPERUSER post-TANDA 0c). `row_security=off` solo afecta los
  // SUPERUSERS y los miembros de roles con BYPASSRLS. tecny_admin tiene
  // BYPASSRLS desde la migration 20260616000002_tenant_user_roles_force_rls.
  // Acá lo activamos explícitamente por defensa, idempotente.
  await pgm.db.query(`SET LOCAL row_security = off`);

  // Backfill principal.
  const result = await pgm.db.query(`
    UPDATE tenant_user_roles tur
       SET rol = tu.rol,
           updated_at = NOW()
      FROM tenant_users tu
     WHERE tur.tenant_id = tu.tenant_id
       AND tur.user_id   = tu.user_id
       AND tur.rol       = 'custom'
       AND tu.rol IN ('owner', 'admin')
  `);

  // eslint-disable-next-line no-console
  console.log(`[migrate] capability_roles_owner_admin_backfill — ${result.rowCount} owner/admin fixed`);
};

// Down: no-op. No rebajamos owners/admins a 'custom' porque destrozaría
// el sistema de vuelta. Si hay que revertir esta migration, hacerlo
// manualmente en el DB target con cuidado quirúrgico.
exports.down = async () => {};

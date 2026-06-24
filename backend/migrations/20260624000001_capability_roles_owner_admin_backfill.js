/**
 * HOTFIX post-F4 — backfill correcto del rol 'owner'/'admin' del tenant
 * en tenant_user_roles.
 *
 * Bug original: la migration 20260623220000_capability_catalog.js seedea
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
 * ──────────────────────────────────────────────────────────────────────
 * 2026-06-24 INCIDENT FIX (rompió prod deploys ~11h, mismo patrón #347):
 *
 *   La versión original usaba `SET LOCAL row_security = off` creyendo que
 *   las migrations corren con `tecny_admin` (BYPASSRLS). Estaba mal: las
 *   migrations corren con el role app (`ipro_app`, NOSUPERUSER post
 *   TANDA 0c #294). `tecny_admin` es un pool SEPARADO que solo accede vía
 *   db.adminQuery() — node-pg-migrate usa DATABASE_URL = ipro_app.
 *
 *   Consecuencia:
 *   - `tenant_user_roles` tiene FORCE RLS desde 20260623220000.
 *   - El UPDATE cross-tenant sin app.current_tenant seteado falla con
 *     42501 (new row violates row-level security policy) porque la policy
 *     WITH CHECK requiere tenant_id = current_setting('app.current_tenant',
 *     true)::int y sin setting devuelve NULL.
 *   - `row_security = off` NO bypassea FORCE RLS si el role no es OWNER
 *     con BYPASSRLS. ipro_app es OWNER pero NO tiene BYPASSRLS.
 *
 *   Fix: DO loop por tenant que setea app.current_tenant con set_config
 *   antes del UPDATE scoped a ese tenant. Mismo patrón que la fix del
 *   incidente anterior (20260620000002).
 *
 *   set_config(..., true) es transaction-local (3er arg) — se descarta al
 *   COMMIT, no contamina el client pool.
 * ──────────────────────────────────────────────────────────────────────
 */

exports.up = async (pgm) => {
  // Hacemos un solo round-trip — todo el loop adentro de un único DO $$.
  // Más eficiente que ida-y-vuelta JS↔PG, y la transacción del migration
  // runner cubre el loop entero (rollback all-or-nothing si algo revienta).
  await pgm.db.query(`
    DO $body$
    DECLARE
      t_id  INT;
      n     INT;
      total INT := 0;
    BEGIN
      FOR t_id IN SELECT id FROM tenants WHERE deleted_at IS NULL ORDER BY id LOOP
        PERFORM set_config('app.current_tenant', t_id::text, true);

        WITH up AS (
          UPDATE tenant_user_roles tur
             SET rol        = tu.rol,
                 updated_at = NOW()
            FROM tenant_users tu
           WHERE tur.tenant_id = t_id
             AND tur.tenant_id = tu.tenant_id
             AND tur.user_id   = tu.user_id
             AND tur.rol       = 'custom'
             AND tu.rol IN ('owner', 'admin')
          RETURNING 1
        )
        SELECT COUNT(*) INTO n FROM up;

        total := total + n;
      END LOOP;

      RAISE NOTICE '[migrate] capability_roles_owner_admin_backfill — % owner/admin fixed', total;
    END
    $body$;
  `);
};

// Down: no-op. No rebajamos owners/admins a 'custom' porque destrozaría
// el sistema de vuelta. Si hay que revertir esta migration, hacerlo
// manualmente en el DB target con cuidado quirúrgico.
exports.down = async () => {};

-- ============================================================================
-- cleanup-orphan-signups.sql
--
-- ORPHAN SIGNUPS: users que se crearon vía /api/auth/signup pero nunca
-- verificaron el email (email_verified_at IS NULL) y no tienen actividad de
-- negocio (sin ventas, productos, contactos, movimientos de caja).
--
-- Casos típicos:
--   - Smoke tests del flujo signup (PR #281 hCaptcha + #299 email verify)
--   - Bots que pasan hCaptcha pero abandonan en /verify-email
--   - Usuarios que se arrepienten antes de hacer la primera operación
--
-- Estrategia: borrar el TENANT del user → ON DELETE CASCADE limpia todo:
--   - tenant_users bridge
--   - cualquier fila de negocio con tenant_id = X (las 45 tablas de la lista
--     TABLAS_NEGOCIO de la migración multitenant_schema)
-- Después borrar el user → CASCADEs en user_2fa, email_verification_tokens,
-- user_permissions, tenant_users (idempotente — ya borrado por el step anterior).
--
-- NULLs introducidos en audit_logs / vendedores / ventas.user_id / etc por
-- ON DELETE SET NULL: aceptable. Los orphan signups no tienen actividad, no
-- hay logs históricos suyos que sufran.
--
-- ============================================================================
-- CÓMO USAR
-- ============================================================================
--   1. Setear CUTOFF_DAYS abajo (default 7 — borra orphans con más de 7 días).
--   2. Ejecutar SECCIÓN 1 (REVIEW) → ver candidates + counts de datos.
--      Si algún tenant tiene ventas/productos/etc > 0, NO es orphan limpio.
--      Ajustar el WHERE o procesar a mano.
--   3. Ejecutar SECCIÓN 2 (DRY-RUN) → ve cuántas filas se borrarían (transacción
--      con ROLLBACK final, no aplica nada).
--   4. Si todo OK: ejecutar SECCIÓN 3 (COMMIT) → aplica el borrado real.
--
--   Ejecutar via psql:
--     psql $DATABASE_URL_PROD -f backend/scripts/cleanup-orphan-signups.sql
--
--   O paste sección por sección en psql interactivo.
--
--   Ventana de tiempo: hardcodeada como INTERVAL '7 days' en 3 lugares
--   (sección 1, 2, 3). Editá los 3 si querés otra ventana.
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 1 — REVIEW: identificar candidates orphan
-- ════════════════════════════════════════════════════════════════════════════

\echo
\echo '═══ SECCIÓN 1 — REVIEW: candidates orphan ═══'
\echo

SELECT
  u.id            AS user_id,
  u.username,
  u.email,
  u.email_verified_at,
  u.created_at    AS user_created,
  tu.tenant_id,
  t.nombre        AS tenant_nombre,
  t.slug          AS tenant_slug,
  -- counts de actividad. Cualquier > 0 = no es orphan limpio, ojo.
  (SELECT COUNT(*) FROM ventas             v  WHERE v.tenant_id  = tu.tenant_id) AS ventas_n,
  (SELECT COUNT(*) FROM productos          p  WHERE p.tenant_id  = tu.tenant_id) AS productos_n,
  (SELECT COUNT(*) FROM contactos          c  WHERE c.tenant_id  = tu.tenant_id) AS contactos_n,
  (SELECT COUNT(*) FROM caja_movimientos   cm WHERE cm.tenant_id = tu.tenant_id) AS caja_mov_n,
  (SELECT COUNT(*) FROM proveedores        pv WHERE pv.tenant_id = tu.tenant_id) AS proveedores_n
FROM users u
JOIN tenant_users tu ON tu.user_id = u.id AND tu.rol = 'owner'
JOIN tenants       t  ON t.id      = tu.tenant_id
WHERE u.email_verified_at IS NULL
  AND u.deleted_at IS NULL
  AND tu.tenant_id <> 1                                              -- NUNCA tocar tenant 1
  AND u.created_at < NOW() - INTERVAL '7 days'   -- ← editar si querés otra ventana
ORDER BY u.created_at ASC;

\echo
\echo 'Si la lista de arriba luce bien y todos los counts son 0:'
\echo '  → seguir con SECCIÓN 2 (DRY-RUN).'
\echo 'Si algún tenant tiene actividad (counts > 0):'
\echo '  → revisar manualmente, podría ser un user real que no verificó email.'
\echo

-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 2 — DRY-RUN: simular borrado en transacción + ROLLBACK
--
-- Mostrá cuántas filas se borrarían sin aplicar el cambio. La transacción
-- termina con ROLLBACK explícito al final — todo se revierte.
-- ════════════════════════════════════════════════════════════════════════════

\echo
\echo '═══ SECCIÓN 2 — DRY-RUN (transacción con ROLLBACK final) ═══'
\echo

BEGIN;

-- Crear temp table con los tenant_ids/user_ids a borrar para no recalcular.
CREATE TEMP TABLE _orphans ON COMMIT DROP AS
SELECT u.id AS user_id, tu.tenant_id
FROM users u
JOIN tenant_users tu ON tu.user_id = u.id AND tu.rol = 'owner'
WHERE u.email_verified_at IS NULL
  AND u.deleted_at IS NULL
  AND tu.tenant_id <> 1
  AND u.created_at < NOW() - INTERVAL '7 days';   -- ← editar si querés otra ventana

\echo 'Orphans encontrados:'
SELECT COUNT(*) AS total FROM _orphans;

-- Borrar tenants — CASCADEs hacen el trabajo en business data + tenant_users.
WITH deleted AS (
  DELETE FROM tenants WHERE id IN (SELECT tenant_id FROM _orphans) RETURNING id
)
SELECT COUNT(*) AS tenants_borrados FROM deleted;

-- Borrar users — CASCADEs en user_2fa, email_verification_tokens, user_permissions.
WITH deleted AS (
  DELETE FROM users WHERE id IN (SELECT user_id FROM _orphans) RETURNING id
)
SELECT COUNT(*) AS users_borrados FROM deleted;

-- ⚠️  ROLLBACK — esto revierte TODO. Es un dry-run.
ROLLBACK;

\echo
\echo 'DRY-RUN completado con ROLLBACK. Nada se aplicó en la DB.'
\echo 'Si los números te convencen → seguir con SECCIÓN 3 (COMMIT).'
\echo

-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 3 — COMMIT: aplicar el borrado de verdad
--
-- DESCOMENTAR todo el bloque BEGIN..COMMIT abajo para ejecutar. Lo dejé
-- comentado por default para evitar accidentes (ej: alguien hace psql -f
-- y se ejecuta todo de corrido sin pensar).
-- ════════════════════════════════════════════════════════════════════════════

\echo
\echo '═══ SECCIÓN 3 — COMMIT (descomentar para aplicar) ═══'
\echo

-- BEGIN;
--
-- CREATE TEMP TABLE _orphans ON COMMIT DROP AS
-- SELECT u.id AS user_id, tu.tenant_id
-- FROM users u
-- JOIN tenant_users tu ON tu.user_id = u.id AND tu.rol = 'owner'
-- WHERE u.email_verified_at IS NULL
--   AND u.deleted_at IS NULL
--   AND tu.tenant_id <> 1
--   AND u.created_at < NOW() - INTERVAL '7 days';   -- ← editar si querés otra ventana
--
-- \echo 'Orphans a borrar:'
-- SELECT COUNT(*) AS total FROM _orphans;
--
-- DELETE FROM tenants WHERE id IN (SELECT tenant_id FROM _orphans);
-- DELETE FROM users   WHERE id IN (SELECT user_id   FROM _orphans);
--
-- COMMIT;
-- \echo 'Cleanup aplicado.'

-- ════════════════════════════════════════════════════════════════════════════
-- FIN
-- ════════════════════════════════════════════════════════════════════════════

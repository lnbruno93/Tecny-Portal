-- ============================================================================
-- cleanup-colecciones-huerfanas.sql — 2026-07-25
--
-- CONTEXTO
--   El import XLSX de Inventario tenía un bug: cuando el operador ponía un
--   valor en la columna "categoria" que no matcheaba ninguna Colección
--   preexistente, se auto-creaba una nueva Colección en la tabla legacy
--   `categorias` (renombrada "Colecciones" en UI post-F3.b). El operador
--   quería crear Categorías (`clases_producto`, fuente de verdad F3.a),
--   NO Colecciones.
--
--   Reportado por Lucas 2026-07-25 con screenshot mostrando 8 Colecciones
--   basura auto-creadas post-import en tenant Tek Haus:
--     · iPad A16
--     · iPad Air 11" (M4)
--     · iPad Air 13" (M4)
--     · MacBook Air 13" 16GB (M5)
--     · MacBook Neo
--     · MacBook Neo | Español
--     · MacBook Pro 14" 16GB (M5)
--     · MacBook Pro 16" 24GB (M5 Pro)
--
--   El bug estructural se arregló en el PR "remove Colecciones auto-create
--   → Categorías (clases_producto)". Este script limpia el basura ya
--   creado en prod que dejó el bug antes del fix.
--
-- SCOPE
--   Borra (soft-delete) las Colecciones con 0 productos activos asignados.
--   Segura: no toca Colecciones con productos porque hay uso real. El
--   operador puede seguir asignando categoria_id manualmente desde el
--   form de producto para las que sí importan.
--
--   Se aplica a TODOS los tenants — el bug era universal, aunque el
--   reporte inicial fue de Tek Haus. Si preferís acotar por tenant,
--   agregá `AND tenant_id = X` en cada WHERE.
--
-- SEGURIDAD
--   Solo soft-delete (SET deleted_at = NOW()). No es destructivo — si algo
--   sale mal, se puede rehacer con UPDATE ... SET deleted_at = NULL.
--
-- CÓMO USAR
--   1. Ejecutar SECCIÓN 1 (REVIEW) para ver qué Colecciones caerían.
--      Confirmar con Lucas si algún nombre te llama la atención.
--   2. Ejecutar SECCIÓN 2 (DRY-RUN) — transacción con ROLLBACK final.
--   3. Si todo OK, descomentar y ejecutar SECCIÓN 3 (COMMIT).
--
--   Ejecutar via psql:
--     psql $DATABASE_URL_PROD -f backend/scripts/cleanup-colecciones-huerfanas.sql
--
--   O paste sección por sección en psql interactivo (recomendado — permite
--   revisar el output de la SECCIÓN 1 antes de avanzar).
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 1 — REVIEW: identificar Colecciones huérfanas
-- ════════════════════════════════════════════════════════════════════════════

\echo
\echo '═══ SECCIÓN 1 — REVIEW: Colecciones sin productos activos ═══'
\echo

SELECT
  c.id,
  c.tenant_id,
  t.nombre         AS tenant_nombre,
  c.nombre         AS coleccion_nombre,
  c.created_at,
  -- COUNT en JOIN para verificar el guard.
  (SELECT COUNT(*) FROM productos p
    WHERE p.categoria_id = c.id
      AND p.tenant_id = c.tenant_id
      AND p.deleted_at IS NULL)  AS productos_activos
FROM categorias c
LEFT JOIN tenants t ON t.id = c.tenant_id
WHERE c.deleted_at IS NULL
  AND (
    SELECT COUNT(*) FROM productos p
    WHERE p.categoria_id = c.id
      AND p.tenant_id = c.tenant_id
      AND p.deleted_at IS NULL
  ) = 0
ORDER BY c.tenant_id, c.nombre;

\echo
\echo 'Todas las filas de arriba serían soft-deleted en las secciones 2/3.'
\echo 'Si alguna te importa (ej. plantilla que se usa manualmente),'
\echo '  → editar el WHERE para excluirla antes de avanzar.'
\echo

-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 2 — DRY-RUN: simular borrado + ROLLBACK
--
-- Muestra cuántas filas se marcarían como deleted sin aplicar el cambio.
-- La transacción termina con ROLLBACK explícito.
-- ════════════════════════════════════════════════════════════════════════════

\echo
\echo '═══ SECCIÓN 2 — DRY-RUN (transacción con ROLLBACK final) ═══'
\echo

BEGIN;

-- Temp table con las Colecciones a soft-delete.
CREATE TEMP TABLE _colecciones_huerfanas ON COMMIT DROP AS
SELECT c.id, c.tenant_id, c.nombre
FROM categorias c
WHERE c.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM productos p
    WHERE p.categoria_id = c.id
      AND p.tenant_id = c.tenant_id
      AND p.deleted_at IS NULL
  );

\echo 'Colecciones huérfanas a soft-deletear:'
SELECT COUNT(*) AS total FROM _colecciones_huerfanas;

-- Preview por tenant.
\echo 'Detalle por tenant:'
SELECT tenant_id, COUNT(*) AS n_huerfanas
FROM _colecciones_huerfanas
GROUP BY tenant_id
ORDER BY tenant_id;

-- Simular el soft-delete (dry-run — se revierte con ROLLBACK).
WITH updated AS (
  UPDATE categorias
     SET deleted_at = NOW()
   WHERE id IN (SELECT id FROM _colecciones_huerfanas)
   RETURNING id
)
SELECT COUNT(*) AS filas_marcadas_dry_run FROM updated;

-- ⚠️  ROLLBACK — todo se revierte. Dry-run.
ROLLBACK;

\echo
\echo 'DRY-RUN completado con ROLLBACK. Nada se aplicó en la DB.'
\echo 'Si los números te convencen → seguir con SECCIÓN 3 (COMMIT).'
\echo

-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 3 — COMMIT: aplicar soft-delete de verdad
--
-- DESCOMENTAR el bloque BEGIN..COMMIT abajo para ejecutar. Lo dejé
-- comentado por default para evitar accidentes (ej: alguien hace psql -f
-- y se ejecuta todo de corrido sin pensar).
-- ════════════════════════════════════════════════════════════════════════════

\echo
\echo '═══ SECCIÓN 3 — COMMIT (descomentar para aplicar) ═══'
\echo

-- BEGIN;
--
-- CREATE TEMP TABLE _colecciones_huerfanas ON COMMIT DROP AS
-- SELECT c.id, c.tenant_id, c.nombre
-- FROM categorias c
-- WHERE c.deleted_at IS NULL
--   AND NOT EXISTS (
--     SELECT 1 FROM productos p
--     WHERE p.categoria_id = c.id
--       AND p.tenant_id = c.tenant_id
--       AND p.deleted_at IS NULL
--   );
--
-- \echo 'Colecciones a borrar:'
-- SELECT COUNT(*) AS total FROM _colecciones_huerfanas;
--
-- -- Audit trail antes del UPDATE — quedan en audit_logs para rollback manual
-- -- si algo sale mal. audit_logs es una tabla con RLS relaxed para inserts de
-- -- sistema — usamos INSERT directo (no via helper).
-- INSERT INTO audit_logs (tenant_id, tabla, operacion, registro_id, cambios, user_id, created_at)
-- SELECT tenant_id, 'categorias', 'DELETE', id::text,
--        jsonb_build_object('antes', jsonb_build_object('nombre', nombre),
--                           'razon', 'cleanup Colecciones huérfanas post-fix XLSX 2026-07-25'),
--        NULL, NOW()
-- FROM _colecciones_huerfanas;
--
-- -- Soft-delete real.
-- UPDATE categorias
--    SET deleted_at = NOW()
--  WHERE id IN (SELECT id FROM _colecciones_huerfanas);
--
-- COMMIT;
-- \echo 'Cleanup aplicado. Audit trail en audit_logs.'

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK MANUAL (si algo salió mal)
--
-- Todas las filas soft-deleted por este script tienen el mismo timestamp
-- (dentro de la ventana de segundos del script). Para rollback:
--
--   UPDATE categorias SET deleted_at = NULL
--    WHERE deleted_at BETWEEN '2026-07-25 XX:00:00' AND '2026-07-25 XX:01:00';
--
-- O usando audit_logs (más preciso — solo las que este script marcó):
--   UPDATE categorias c SET deleted_at = NULL
--    WHERE EXISTS (
--      SELECT 1 FROM audit_logs al
--      WHERE al.tabla = 'categorias'
--        AND al.operacion = 'DELETE'
--        AND al.registro_id = c.id::text
--        AND al.cambios->>'razon' LIKE 'cleanup Colecciones%2026-07-25'
--    );
-- ════════════════════════════════════════════════════════════════════════════

\echo
\echo 'Script terminado.'
\echo

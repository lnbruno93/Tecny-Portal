/**
 * 20260708000001_productos_clase_categorias_reales.js
 *
 * Categorías reales F1 — reemplaza el enum binario `productos.clase`
 * (celular/accesorio) por 9 categorías del negocio real:
 *
 *   📲 celular_sellado
 *   ♻️ celular_usado
 *   ⌚ watch
 *   🎧 auriculares
 *   🎮 consolas
 *   💻 computadoras
 *   📱 ipads
 *   🔋 cargadores
 *   🛍️ accesorios_varios
 *
 * Contexto (bug reportado por iOStoreUY 2026-07-08): el KPI "Unidades vendidas"
 * del dashboard mostraba solo "📱 celular · 🎧 accesorio", un modelo que quedó
 * chico para el catálogo real de los tenants (que venden watches, consolas,
 * cargadores, ipads, etc.). Lucas: "no me convence que solo haya el ícono de
 * un celular y unos auriculares cuando vendemos muchos otros productos".
 *
 * Fase 1 (este PR): amplía el enum + backfillea productos existentes + UI de
 * alta/edición en Inventario. El dashboard mostrará el nuevo desglose en
 * Fase 2 (PR separado con diseño propio del KPI). El importador XLSX se
 * actualiza en Fase 3.
 *
 * Backfill:
 *   - `clase='celular' AND condicion='nuevo'` → `celular_sellado`
 *     (condicion es NOT NULL DEFAULT 'nuevo' desde migration
 *      20260603000011, así que este brazo cubre la gran mayoría del catálogo)
 *   - `clase='celular' AND condicion='usado'` → `celular_usado`
 *   - `clase='accesorio'`: matching por keyword en `nombre` (case-insensitive):
 *       'cargador' | 'charger'                  → cargadores
 *       'auricular' | 'airpod' | 'headphone'    → auriculares
 *       'watch'                                 → watch
 *       'consola' | 'playstation' | 'ps4' | 'ps5' | 'xbox' | 'nintendo' | 'switch' → consolas
 *       'ipad'                                  → ipads
 *       'macbook' | 'notebook' | 'laptop' | 'computadora' | 'pc ' → computadoras
 *       resto (funda, cable, adaptador, protector, etc.) → accesorios_varios
 *
 * Idempotente: se puede re-correr sin efectos. Los productos ya migrados a
 * las nuevas clases no matchean los WHERE del backfill (clase IN ('celular',
 * 'accesorio')).
 *
 * Rollback (down): NO revertimos el CHECK ni la data — sería destructivo con
 * data operacional. Si hace falta rollback semántico, un follow-up puede
 * mergear todas las nuevas clases de vuelta a celular/accesorio, pero es
 * decisión de producto, no de infra.
 */

/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 0. RLS bypass para bulk UPDATE.
    --
    -- Incidente 2026-07-09: esta migration falló 10 veces en Railway prod
    -- + 1 vez en staging al intentar auto-deploy post-merge. Root cause:
    -- productos tiene FORCE ROW LEVEL SECURITY (migration 20260615000001
    -- multi-tenant) que aplica también al owner del schema (ipro_app). El
    -- backend Node corre 'npm run migrate' con user ipro_app; sin
    -- app.current_tenant seteado en la sesión, los UPDATE de los pasos
    -- 2-4 son filtrados por RLS y afectan 0 filas. El ADD CONSTRAINT
    -- final (paso 5) valida contra TODA la tabla física y encuentra
    -- filas con clase='celular'/'accesorio' no migradas → violation.
    --
    -- Fix: como owner, el rol ipro_app puede desactivar FORCE RLS
    -- transaccionalmente, hacer el bulk UPDATE, y restaurarlo al final.
    -- Alternativas descartadas:
    --   · SET LOCAL row_security = off — no funciona con FORCE RLS.
    --   · SET SESSION AUTHORIZATION postgres — requiere superuser en el
    --     pool del backend; no queremos elevar el user prod solo por esto.
    --   · UPDATE por-tenant en loop con SET LOCAL app.current_tenant —
    --     requiere enumerar tenants; complejo si la tabla se vacía.
    --
    -- Ver runbook: docs/runbooks/rls-bulk-migration.md
    ALTER TABLE productos NO FORCE ROW LEVEL SECURITY;

    -- 1. Ampliar el CHECK constraint de productos.clase para aceptar las 9
    --    categorías nuevas + preservar 'celular' y 'accesorio' legacy hasta
    --    que el backfill migre todo. Después del UPDATE, hacemos un segundo
    --    ALTER que restringe a solo los 9 valores nuevos (elimina el legacy).
    ALTER TABLE productos DROP CONSTRAINT IF EXISTS productos_clase_check;
    ALTER TABLE productos ADD CONSTRAINT productos_clase_check
      CHECK (clase IN (
        -- Legacy (removidos al final de esta misma migration).
        'celular', 'accesorio',
        -- Nuevas (Fase 1 2026-07-08).
        'celular_sellado', 'celular_usado', 'watch', 'auriculares',
        'consolas', 'computadoras', 'ipads', 'cargadores', 'accesorios_varios'
      ));

    -- 2. Backfill celulares por condicion. condicion es NOT NULL DEFAULT
    --    'nuevo' desde migration 20260603000011, así que no puede haber NULLs.
    UPDATE productos
       SET clase = CASE
                     WHEN condicion = 'usado' THEN 'celular_usado'
                     ELSE 'celular_sellado'
                   END
     WHERE clase = 'celular'
       AND deleted_at IS NULL;

    -- 3. Backfill accesorios por matching de keyword en nombre. LOWER +
    --    ILIKE mantiene case-insensitive. Los patrones cubren las variantes
    --    en español e inglés que aparecen en el catálogo real (según análisis
    --    de nombres típicos con Lucas 2026-07-08). Un producto sólo matchea
    --    UNA categoría — el orden de los WHEN es prioridad (más específico
    --    primero: 'watch' antes que caiga en accesorios_varios).
    --
    --    Productos ya migrados (clase IN nuevas) no matchean el WHERE, así
    --    que la migration es idempotente.
    UPDATE productos
       SET clase = CASE
                     WHEN nombre ~* '(cargador|charger)'                     THEN 'cargadores'
                     WHEN nombre ~* '(auricular|airpod|headphone|earbud)'    THEN 'auriculares'
                     WHEN nombre ~* '\\ywatch\\y'                            THEN 'watch'
                     WHEN nombre ~* '(consola|playstation|\\yps[45]\\y|xbox|nintendo|\\yswitch\\y)' THEN 'consolas'
                     WHEN nombre ~* '\\yipad\\y'                             THEN 'ipads'
                     WHEN nombre ~* '(macbook|notebook|laptop|computadora|\\ypc\\y)' THEN 'computadoras'
                     ELSE 'accesorios_varios'
                   END
     WHERE clase = 'accesorio'
       AND deleted_at IS NULL;

    -- 4. Ahora que el backfill terminó, ajustamos el CHECK para eliminar los
    --    legacy 'celular'/'accesorio'. Cualquier INSERT futuro con esos
    --    valores va a fallar — el frontend/backend ya tienen que usar el
    --    enum nuevo.
    --
    --    Si algún registro soft-deleted todavía tuviera 'celular'/'accesorio'
    --    en clase (no lo tocamos en los UPDATE porque WHERE deleted_at IS NULL),
    --    el CHECK NO valida filas existentes con el nuevo constraint por
    --    default en Postgres — solo aplica a inserts/updates futuros. Pero
    --    para no dejar la puerta abierta, refrescamos también los deleted.
    UPDATE productos
       SET clase = CASE
                     WHEN clase = 'celular' AND condicion = 'usado' THEN 'celular_usado'
                     WHEN clase = 'celular'                         THEN 'celular_sellado'
                     WHEN clase = 'accesorio'                       THEN 'accesorios_varios'
                     ELSE clase
                   END
     WHERE clase IN ('celular', 'accesorio')
       AND deleted_at IS NOT NULL;

    ALTER TABLE productos DROP CONSTRAINT IF EXISTS productos_clase_check;
    ALTER TABLE productos ADD CONSTRAINT productos_clase_check
      CHECK (clase IN (
        'celular_sellado', 'celular_usado', 'watch', 'auriculares',
        'consolas', 'computadoras', 'ipads', 'cargadores', 'accesorios_varios'
      ));

    -- 5. El DEFAULT viejo era 'celular' — no vale más. Cambiamos a
    --    'celular_sellado' que es la categoría más común y equivalente
    --    semántica del default anterior (venta nueva de celular sellado).
    ALTER TABLE productos ALTER COLUMN clase SET DEFAULT 'celular_sellado';

    -- 6. Restauramos FORCE RLS (paso 0 lo desactivó para el bulk UPDATE).
    --    El estado post-migration es idéntico al pre-migration en cuanto a
    --    RLS enforcement — el bypass fue solo transitorio dentro de esta tx.
    ALTER TABLE productos FORCE ROW LEVEL SECURITY;
  `);
};

exports.down = (pgm) => {
  // No revertible determinísticamente — la partición de accesorio en
  // {cargadores, auriculares, watch, consolas, ipads, computadoras,
  // accesorios_varios} no tiene forma de "des-clasificar" salvo colapsar
  // TODO a 'accesorio' (pierde info). Idem con celular_sellado/usado.
  //
  // Si un rollback semántico hace falta, un DBA puede correr:
  //   UPDATE productos SET clase = 'celular'   WHERE clase LIKE 'celular_%';
  //   UPDATE productos SET clase = 'accesorio' WHERE clase NOT LIKE 'celular_%';
  //   ALTER TABLE productos DROP CONSTRAINT productos_clase_check;
  //   ALTER TABLE productos ADD  CONSTRAINT productos_clase_check
  //     CHECK (clase IN ('celular','accesorio'));
  //   ALTER TABLE productos ALTER COLUMN clase SET DEFAULT 'celular';
  // Pero es decisión de producto, no de infra.
  pgm.sql('SELECT 1;');
};

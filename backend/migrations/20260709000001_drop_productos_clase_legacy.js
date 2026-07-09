/**
 * 20260709000001_drop_productos_clase_legacy.js
 *
 * Categorías reales F3.d-3 — DROP COLUMN `productos.clase`.
 *
 * Contexto:
 *   - F1 (#523) creó la columna VARCHAR con CHECK de 9 slugs.
 *   - F3.a (#528) agregó `clase_id UUID` FK a `clases_producto` + backfilleó
 *     todos los productos existentes.
 *   - F3.c-1 (#530) empezó a derivar `clase` desde `clase_id` en cada write
 *     (helper resolveClaseAndClaseId). Doble escritura durante toda la serie.
 *   - F3.c-2 PR-1..3 migraron los consumers principales al `clase_id`.
 *   - F3.d-1 (#535) removió fallbacks F1 hardcoded del frontend.
 *   - F3.d-2 (#536) migró LECTURAS backend a JOIN con `slug_legacy`.
 *   - **Este PR (F3.d-3)** cierra la serie: remove escrituras + DROP COLUMN
 *     + remove helpers legacy backend/frontend.
 *
 * Rollback estrategia:
 *   El `exports.down` recrea la columna VARCHAR(40) + CHECK constraint +
 *   backfill desde `clases_producto.slug_legacy` via JOIN. NOT NULL NO se
 *   restaura porque hay productos con `clase_id` NULL (edge case del
 *   backfill original F3.a — productos que no matchearon ningún slug) que
 *   quedarían con `clase = NULL` post-rollback. Documentado en el design
 *   doc `docs/design/categorias-crud-tenant-f3.md`.
 *
 * Riesgo:
 *   - Consumers residuales que aún lean `p.clase` fallarían silenciosamente
 *     (columna dropeada = undefined en JS, NULL en SQL). Auditoría exhaustiva
 *     en F3.d-2 confirmó que solo escrituras remain — todas migradas en este
 *     PR antes del DROP.
 *   - Rollout: la migration corre en Railway al startup. Si el deploy
 *     alcanza staging + producción antes de que Netlify termine (raro), el
 *     frontend viejo podría hacer POST con `clase` en el body — el backend
 *     ignora silenciosamente (schema `clase` removido y ya no está en
 *     PRODUCTO_COLS). Zero-downtime.
 */

exports.up = async (pgm) => {
  // 1) Drop del CHECK constraint que limitaba a 9 slugs. Nombre viene de la
  //    migration F1 (20260708000001) — verificamos con `IF EXISTS` para ser
  //    idempotentes.
  pgm.sql(`
    ALTER TABLE productos
      DROP CONSTRAINT IF EXISTS productos_clase_check;
  `);

  // 2) Drop del NOT NULL. Necesario ANTES del DROP COLUMN si hay alguna
  //    query concurrente en flight que INSERT sin clase (defensive; en
  //    práctica los deploys esperan health check antes de traer tráfico).
  pgm.sql(`
    ALTER TABLE productos
      ALTER COLUMN clase DROP NOT NULL;
  `);

  // 3) DROP COLUMN. Destructivo — todos los slugs se pierden. Los tests de
  //    la serie F3 verificaron que ningún consumer lee p.clase directo:
  //    lecturas usan JOIN a clases_producto.slug_legacy desde F3.d-2 (#536).
  pgm.sql(`
    ALTER TABLE productos
      DROP COLUMN IF EXISTS clase;
  `);
};

exports.down = async (pgm) => {
  // Rollback: recreamos la columna + CHECK + backfill.
  //
  // 1) Recrear la columna VARCHAR(40) NULLABLE (no restauramos NOT NULL —
  //    productos con clase_id NULL post-backfill de F3.a quedarían sin
  //    slug al restaurar; NULLABLE los deja explícitos).
  pgm.sql(`
    ALTER TABLE productos
      ADD COLUMN IF NOT EXISTS clase VARCHAR(40);
  `);

  // 2) Backfill desde clases_producto.slug_legacy vía la FK ya existente.
  //    Los productos con clase_id sin base match (slug_legacy=NULL en
  //    categorías custom del tenant) quedan con clase=NULL — es coherente:
  //    esa clase no encaja en ninguno de los 9 slugs originales.
  pgm.sql(`
    UPDATE productos p
       SET clase = cp.slug_legacy
      FROM clases_producto cp
     WHERE cp.id = p.clase_id
       AND cp.slug_legacy IS NOT NULL
       AND p.clase IS NULL;
  `);

  // 3) Recrear el CHECK constraint SOLO para filas con clase no-null.
  //    Nueva sintaxis con `NOT VALID` + `VALIDATE` en pasos separados para
  //    no bloquear la tabla durante el ALTER (patrón zero-downtime).
  pgm.sql(`
    ALTER TABLE productos
      ADD CONSTRAINT productos_clase_check
        CHECK (clase IS NULL OR clase IN (
          'celular_sellado', 'celular_usado', 'watch', 'auriculares',
          'consolas', 'computadoras', 'ipads', 'cargadores', 'accesorios_varios'
        )) NOT VALID;
    ALTER TABLE productos VALIDATE CONSTRAINT productos_clase_check;
  `);
};

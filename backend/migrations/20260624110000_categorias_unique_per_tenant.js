/**
 * 20260624000002_categorias_unique_per_tenant.js
 *
 * Fix multitenant: el índice unique `idx_categorias_nombre` (creado en
 * 20260524000001_inventario.js) usa `LOWER(nombre)` global — no incluye
 * tenant_id. La migración multitenant_schema (20260615000001) agregó el
 * column `tenant_id` pero no actualizó este índice, dejando un bug latente:
 *
 *   - Tenant A crea categoría "Celulares" → OK
 *   - Tenant B crea categoría "Celulares" → 409 unique_violation
 *
 * En la práctica no se disparó porque cada tenant tenía nombres distintos.
 * Pero el audit pre-live 2026-06-24 detectó ONB-3 (signup seed de 4
 * categorías default) que reproduce el bug determinísticamente entre tenants.
 *
 * Fix: drop el índice viejo, crear uno nuevo con `(tenant_id, LOWER(nombre))`
 * + `WHERE deleted_at IS NULL`. Mismo semántica per-tenant, idéntica a
 * cómo `metodos_pago` ya está scopeada (ver migración multitenant_schema).
 *
 * Hace falta el mismo fix en otras tablas catálogo? Verificado con grep:
 *   - depositos: idx_depositos_nombre — SÍ, mismo problema. Lo fixamos también.
 *   - etiquetas: usa nombre + tenant_id en su PK desde el principio. OK.
 *   - egreso_categorias: ya tiene índice por tenant. OK.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- categorías per-tenant
    DROP INDEX IF EXISTS idx_categorias_nombre;
    CREATE UNIQUE INDEX idx_categorias_tenant_nombre
      ON categorias (tenant_id, LOWER(nombre))
      WHERE deleted_at IS NULL;

    -- depositos per-tenant (mismo bug)
    DROP INDEX IF EXISTS idx_depositos_nombre;
    CREATE UNIQUE INDEX idx_depositos_tenant_nombre
      ON depositos (tenant_id, LOWER(nombre))
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_categorias_tenant_nombre;
    CREATE UNIQUE INDEX idx_categorias_nombre
      ON categorias (LOWER(nombre)) WHERE deleted_at IS NULL;

    DROP INDEX IF EXISTS idx_depositos_tenant_nombre;
    CREATE UNIQUE INDEX idx_depositos_nombre
      ON depositos (LOWER(nombre)) WHERE deleted_at IS NULL;
  `);
};

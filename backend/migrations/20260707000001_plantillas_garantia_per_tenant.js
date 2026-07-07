/**
 * 20260707000001_plantillas_garantia_per_tenant.js
 *
 * Fix multitenant: los índices unique de `plantillas_garantia` (creados en
 * 20260524000004_plantillas-garantia.js) son GLOBALES — no incluyen
 * tenant_id. La migración multitenant_schema agregó el column `tenant_id`
 * pero no actualizó estos índices, dejando dos bugs:
 *
 *   BUG 1 — nombre único global:
 *     - Tenant A crea plantilla "Equipos Sellados" → OK
 *     - Tenant B intenta lo mismo → 23505 unique_violation
 *     - Tenant B NO puede ver la plantilla del A (RLS filtra), pero el
 *       UNIQUE constraint se aplica ANTES de RLS.
 *     - Reportado en prod 2026-07-07 por tenant UY intentando crear
 *       "Equipos Sellados" cuando el nombre ya existía en otro tenant.
 *
 *   BUG 2 — solo puede existir UNA plantilla default en todo el sistema:
 *     - `idx_plantillas_garantia_default` es UNIQUE sobre `((es_default))
 *       WHERE es_default = true` sin tenant_id.
 *     - Consecuencia: si tenant A tiene una plantilla default, tenant B
 *       NO puede marcar ninguna como default.
 *     - En la práctica, cuando el route POST/PUT hace
 *       `UPDATE plantillas_garantia SET es_default = false WHERE es_default = true`
 *       antes del INSERT/UPDATE, RLS filtra la UPDATE al tenant actual,
 *       pero el INSERT/UPDATE final choca con la fila default de OTRO tenant.
 *
 * Fix: drop los índices viejos, crear nuevos con `(tenant_id, ...)`. Mismo
 * patrón que 20260624110000_categorias_unique_per_tenant.js.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- BUG 1: nombre único per-tenant.
    DROP INDEX IF EXISTS idx_plantillas_garantia_nombre;
    CREATE UNIQUE INDEX idx_plantillas_garantia_tenant_nombre
      ON plantillas_garantia (tenant_id, LOWER(nombre))
      WHERE deleted_at IS NULL;

    -- BUG 2: 1 default per-tenant.
    DROP INDEX IF EXISTS idx_plantillas_garantia_default;
    CREATE UNIQUE INDEX idx_plantillas_garantia_tenant_default
      ON plantillas_garantia (tenant_id)
      WHERE es_default = true AND deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_plantillas_garantia_tenant_nombre;
    CREATE UNIQUE INDEX idx_plantillas_garantia_nombre
      ON plantillas_garantia (LOWER(nombre))
      WHERE deleted_at IS NULL;

    DROP INDEX IF EXISTS idx_plantillas_garantia_tenant_default;
    CREATE UNIQUE INDEX idx_plantillas_garantia_default
      ON plantillas_garantia ((es_default))
      WHERE es_default = true AND deleted_at IS NULL;
  `);
};

/**
 * 20260711170000_redb2b_p0_ensure_tenant_filter_and_unique.js
 *
 * Fix P0-1 de la auditoría Red B2B (2026-07-11):
 *
 * Contexto: los helpers `ensureSellerClienteCc` (crossTenantPagos.js:178) y
 * `ensureBuyerProveedor` (crossTenantPagos.js:206), así como los inlines en
 * `crossTenantOps.js:263-282` y `:448-467`, hacían lookup por
 * `LOWER(nombre)` SIN filtro `tenant_id`. Como todos corren bajo `adminQuery`
 * (BYPASSRLS), el `SET LOCAL app.current_tenant` no filtraba — el SELECT
 * podía devolver el `id` de un `cliente_cc` o `proveedor` de OTRO tenant
 * con el mismo nombre. El INSERT posterior en `movimientos_cc` /
 * `proveedor_movimientos` quedaba con `cliente_cc_id` / `proveedor_id`
 * cross-tenant → contabilidad mezclada entre tenants.
 *
 * El fix del backend está en el mismo PR (filtro `AND tenant_id = $N` en los
 * SELECTs). Esta migration agrega el BLINDAJE de DB:
 *
 *   UNIQUE (tenant_id, LOWER(nombre)) WHERE deleted_at IS NULL
 *
 * en `clientes_cc` y `proveedores`. Beneficios:
 *
 *   1. Previene duplicados case-insensitive por tenant en el futuro (race
 *      condition entre dos requests concurrentes que quieran crear el mismo
 *      cliente/proveedor).
 *   2. Permite reusar nombres soft-deleted (el WHERE deleted_at IS NULL
 *      excluye las filas borradas).
 *   3. Permite ON CONFLICT (tenant_id, LOWER(nombre)) DO NOTHING RETURNING id
 *      en futuras optimizaciones (evita el patrón lookup-then-insert).
 *
 * Verificación previa (2026-07-11): 0 duplicados en prod. La constraint se
 * puede crear sin dedupe.
 *
 * Rollback: DROP INDEX. No destructivo.
 */

exports.up = async (pgm) => {
  pgm.sql(`
    -- clientes_cc: prevenir duplicados case-insensitive por tenant.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_cc_tenant_nombre_ci
      ON clientes_cc (tenant_id, LOWER(nombre))
      WHERE deleted_at IS NULL;

    -- proveedores: idem.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_proveedores_tenant_nombre_ci
      ON proveedores (tenant_id, LOWER(nombre))
      WHERE deleted_at IS NULL;
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS uq_clientes_cc_tenant_nombre_ci;
    DROP INDEX IF EXISTS uq_proveedores_tenant_nombre_ci;
  `);
};

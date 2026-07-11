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
    -- clientes_cc: previene duplicados case-insensitive por tenant.
    -- IMPORTANTE: el UNIQUE incluye apellido porque el schema separa nombre
    -- + apellido (dos "Juan" con distintos apellidos son personas distintas).
    -- Sin apellido incluido, cualquier "Juan Pérez" y "Juan Gómez" chocarían
    -- (E2E cobranza-masiva reveló el issue con "Cliente A" + "Cliente B").
    -- Para el auto-create de Red B2B (que solo usa nombre sin apellido),
    -- el COALESCE(apellido, '') deja la constraint efectivamente en
    -- (tenant_id, LOWER(nombre)) porque el apellido siempre es NULL → '' —
    -- se preserva el aislamiento por tenant tal como se diseñó.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_cc_tenant_nombre_ci
      ON clientes_cc (tenant_id, LOWER(nombre), LOWER(COALESCE(apellido, '')))
      WHERE deleted_at IS NULL;

    -- proveedores: no tiene apellido en el schema (contacto_apellido es de
    -- la PERSONA de contacto, no del proveedor). UNIQUE por (tenant_id, nombre)
    -- es correcto: no debería haber 2 proveedores idénticos en el mismo tenant.
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

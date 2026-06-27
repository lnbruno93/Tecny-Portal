/**
 * Migration: Red B2B F3 — ALTER movimientos_cc + proveedor_movimientos
 *                          con cross_tenant_operation_id.
 *
 * Diseño en docs/design/red-b2b-cross-tenant.md sección 4.2 (cambios a
 * `ventas` y `compras`). El diseño habla de las tablas `ventas` y `compras`,
 * pero en este repo el flujo B2B vive sobre:
 *   - movimientos_cc       (B2B venta) — el lado del SELLER
 *   - proveedor_movimientos (compra a proveedor) — el lado del BUYER
 *
 * Decisión #1 fuera del doc: usamos las tablas reales del módulo B2B+
 * proveedores en vez de `ventas`/`compras` retail. Razones:
 *   - La operación cross-tenant es B2B por definición — vive en CC, no en
 *     retail con tarjetas/efectivo.
 *   - El modal "Nueva venta B2B" (CC) es el que se va a wirear con partners
 *     desde frontend.
 *   - `ventas` retail no tiene CC del cliente B2B (usa venta_pagos + cliente_id
 *     retail), y el flujo cross-tenant SIEMPRE genera CC en ambos lados.
 *
 * Aplica el mismo patrón que el doc original:
 *   - cross_tenant_operation_id BIGINT REFERENCES cross_tenant_operations(id)
 *   - Index parcial WHERE NOT NULL — la mayoría de las filas tienen NULL
 *     (operaciones B2B locales), el index es minúsculo pero acelera el
 *     "dame todas las ops cross-tenant del tenant X" del GET /operations.
 *
 * Reversible: down dropea el index parcial + la columna, en ese orden.
 *
 * F3 NO toca `ventas` retail ni `compras`. Si en el futuro Lucas decide
 * sumar también retail cross-tenant, agregamos una migration posterior que
 * extienda ventas con la misma columna — sin tocar la lógica existente.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- ─── movimientos_cc (lado SELLER de la operación) ─────────────────────
    ALTER TABLE movimientos_cc
      ADD COLUMN cross_tenant_operation_id BIGINT
        REFERENCES cross_tenant_operations(id);

    COMMENT ON COLUMN movimientos_cc.cross_tenant_operation_id IS
      'Red B2B F3: FK a la cross_tenant_operations maestra cuando esta venta CC fue creada vía /api/red-b2b/operations. NULL para ventas B2B locales (no cross-tenant).';

    -- Index parcial: queries calientes son del tipo
    --   "dame las ops cross-tenant del tenant X" (GET /operations).
    -- La mayoría de movimientos_cc no tienen cross_tenant_operation_id, así
    -- que el index parcial es minúsculo. Por tenant_id porque el filtro RLS
    -- siempre incluye el tenant del caller.
    CREATE INDEX idx_mov_cc_cross_tenant
      ON movimientos_cc(tenant_id, cross_tenant_operation_id)
      WHERE cross_tenant_operation_id IS NOT NULL;

    -- ─── proveedor_movimientos (lado BUYER de la operación) ───────────────
    ALTER TABLE proveedor_movimientos
      ADD COLUMN cross_tenant_operation_id BIGINT
        REFERENCES cross_tenant_operations(id);

    COMMENT ON COLUMN proveedor_movimientos.cross_tenant_operation_id IS
      'Red B2B F3: FK a la cross_tenant_operations maestra cuando esta compra a proveedor fue creada vía /api/red-b2b/operations. NULL para compras locales (no cross-tenant).';

    CREATE INDEX idx_prov_mov_cross_tenant
      ON proveedor_movimientos(tenant_id, cross_tenant_operation_id)
      WHERE cross_tenant_operation_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_prov_mov_cross_tenant;
    ALTER TABLE proveedor_movimientos DROP COLUMN IF EXISTS cross_tenant_operation_id;

    DROP INDEX IF EXISTS idx_mov_cc_cross_tenant;
    ALTER TABLE movimientos_cc DROP COLUMN IF EXISTS cross_tenant_operation_id;
  `);
};

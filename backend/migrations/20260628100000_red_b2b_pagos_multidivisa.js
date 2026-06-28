/**
 * Migration: Red B2B F4 — pagos cross-tenant + multi-divisa + devoluciones.
 *
 * Diseño en docs/design/red-b2b-cross-tenant.md sección 4.1 (cross_tenant_pagos)
 * + decisión #16 (multi-divisa re-cálculo bilateral) + decisión #11 (devoluciones).
 *
 * Cambios:
 *
 * 1. `cross_tenant_pagos` extiende con multi-divisa:
 *    - moneda_pago TEXT NOT NULL DEFAULT 'USD' CHECK IN ('USD', 'ARS')
 *      → la moneda real en la que se hizo el pago (puede diferir de la moneda
 *        de la venta, que siempre es USD interno)
 *    - tc_venta NUMERIC(10,4) → TC original de la venta (snapshot desde
 *        cross_tenant_operations.tc_used al momento del pago). Permite
 *        recalcular la diferencia cambiaria sin depender de la op viva.
 *    - tc_pago NUMERIC(10,4) → renombre conceptual de tc_used (que pasa a
 *        representar el TC del PAGO específico). Mantenemos tc_used original
 *        como NOT NULL para compat con F1 schema; tc_pago se persiste como
 *        columna nueva NULLABLE — en código el caller llena ambos. Sin renombre
 *        físico para no romper code que pueda hacer SELECT *.
 *    - diferencia_cambiaria_ars NUMERIC(14,2) DEFAULT 0
 *      → gain/loss en ARS por la diferencia entre tc_venta y tc_pago.
 *        Positivo si seller GANÓ (TC subió desde venta), negativo si perdió.
 *        Cero si moneda_pago='USD' o tc_pago==tc_venta.
 *    - cambio_divisa_id INTEGER → FK lógica al cambio_movimientos del seller
 *        donde se registró la diferencia cambiaria. NULL si moneda_pago=USD
 *        (no hay diferencia). Sin FK física porque cambio_movimientos es
 *        tenant-scoped y este enlace cruza el límite lógico.
 *
 * 2. **DECISIÓN CRÍTICA**: NO renombramos seller_cobro_id / buyer_pago_id.
 *    En F1 el schema los nombró así. F3 wireó sobre movimientos_cc +
 *    proveedor_movimientos (ver divergencia sección 4.2 del doc), así que
 *    ahora los IDs apuntan a esas tablas, NO a `cobros`/`pagos` separadas
 *    (que en este repo NO existen como tablas distintas — todo es CC).
 *
 *    Justificación de mantener nombres:
 *      - Code en F1 ya tiene los nombres. Renombrar requiere ALTER + update
 *        de cualquier reference futura. Bajo valor.
 *      - El COMMENT en columna explica claramente que apuntan a
 *        movimientos_cc (seller) / proveedor_movimientos (buyer).
 *      - F4 es 100% código nuevo; los helpers usan nombres claros internamente
 *        (seller_movimiento_id en variable local) y sólo el INSERT final mapea
 *        a la columna seller_cobro_id.
 *
 * 3. ALTER `tenants` agregando `red_b2b_caja_default_id INTEGER`:
 *    - FK a metodos_pago(id) ON DELETE SET NULL
 *    - Caja default del tenant donde recibe pagos cross-tenant propagados
 *      desde el OTRO lado. Si NULL, el código usa la primera caja del tenant
 *      con misma moneda compatible.
 *    - Configurable vía PATCH /api/red-b2b/config/caja-default.
 *
 * 4. ALTER `cross_tenant_operations` agregando `parent_op_id BIGINT`:
 *    - FK lógica (RLS dual) a la op original cuando esta es una devolución.
 *    - NULL para ops normales.
 *    - Decisión #11 doc: devoluciones cross-tenant = nueva op con total
 *      negativo apuntando a la original con parent_op_id.
 *
 * 5. CHECK constraint de `cross_tenant_pagos.registered_by_side` ya estaba en
 *    F1 (seller/buyer). No tocamos.
 *
 * Reversible: down deshace todas las ALTERs en orden inverso.
 *
 * NOTA sobre F1 schema:
 *   F1 puso `seller_cobro_id`, `buyer_pago_id`, `caja_seller_id`,
 *   `caja_buyer_id`, `monto_ars`, `tc_used` como NOT NULL. F4 mantiene esa
 *   restricción — el código siempre llena estos campos. El nuevo `tc_venta`
 *   también se llena siempre (snapshot al momento del pago).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- ─── 1. cross_tenant_pagos: multi-divisa columns ──────────────────────
    -- moneda_pago: en qué moneda el pago se efectivizó (puede diferir de la
    -- venta que siempre es USD). Default 'USD' para retrocompatibilidad si
    -- alguna fila existiera (F1 dejó la tabla vacía).
    ALTER TABLE cross_tenant_pagos
      ADD COLUMN moneda_pago TEXT NOT NULL DEFAULT 'USD'
        CHECK (moneda_pago IN ('USD', 'ARS'));

    COMMENT ON COLUMN cross_tenant_pagos.moneda_pago IS
      'Red B2B F4: moneda real del pago (USD o ARS). Puede diferir de la moneda de la venta — la venta siempre se asienta en USD internamente; si el pago se hace en ARS al TC del día, este campo lo refleja.';

    -- tc_venta: snapshot del TC original de la operación al momento del pago.
    -- Default copiado desde cross_tenant_operations.tc_used vía UPDATE post-ALTER
    -- para filas existentes (debería ser 0 en producción — F1 dejó la tabla
    -- vacía). En código F4 SIEMPRE se llena explícito.
    ALTER TABLE cross_tenant_pagos
      ADD COLUMN tc_venta NUMERIC(10, 4);

    COMMENT ON COLUMN cross_tenant_pagos.tc_venta IS
      'Red B2B F4: snapshot del TC de la venta (cross_tenant_operations.tc_used) al momento de registrar el pago. Permite calcular la diferencia cambiaria sin depender de la op viva (que podría editarse después).';

    -- tc_pago: TC al momento del pago. Si moneda_pago=USD, igual a tc_venta
    -- (diferencia=0). Si moneda_pago=ARS, lo provee el frontend (TC del día).
    ALTER TABLE cross_tenant_pagos
      ADD COLUMN tc_pago NUMERIC(10, 4);

    COMMENT ON COLUMN cross_tenant_pagos.tc_pago IS
      'Red B2B F4: TC efectivo al momento del pago. Puede diferir de tc_venta — la diferencia se registra en diferencia_cambiaria_ars.';

    -- diferencia_cambiaria_ars: en ARS, positivo = seller ganó (TC subió),
    -- negativo = seller perdió (TC bajó). Calculado en helper crossTenantPagos.js.
    ALTER TABLE cross_tenant_pagos
      ADD COLUMN diferencia_cambiaria_ars NUMERIC(14, 2) NOT NULL DEFAULT 0;

    COMMENT ON COLUMN cross_tenant_pagos.diferencia_cambiaria_ars IS
      'Red B2B F4: gain/loss en ARS por diferencia entre tc_venta y tc_pago. Positivo = seller ganó (TC subió desde venta). Negativo = perdió. Cero si moneda_pago=USD o tc=tc.';

    -- cambio_divisa_id: FK lógica a cambio_movimientos del seller cuando se
    -- registró la diferencia cambiaria como movimiento. NULL si no hubo
    -- diferencia (moneda_pago=USD) o si TC iguales.
    ALTER TABLE cross_tenant_pagos
      ADD COLUMN cambio_divisa_id INTEGER;

    COMMENT ON COLUMN cross_tenant_pagos.cambio_divisa_id IS
      'Red B2B F4: FK lógica a cambio_movimientos del SELLER donde se asentó la diferencia cambiaria. NULL si no hubo diferencia. No usamos FK física porque cambio_movimientos es tenant-scoped al seller — el enlace cruza límite lógico.';

    -- Comments aclarando los _id existentes apuntan a CC, no a cobros/pagos
    -- (F3 wireó sobre movimientos_cc + proveedor_movimientos — ver doc sec 4.2).
    COMMENT ON COLUMN cross_tenant_pagos.seller_cobro_id IS
      'Red B2B F4: FK lógica al movimientos_cc (tipo=pago) del SELLER. Nombre histórico de F1; el cobro real vive en movimientos_cc, no en una tabla cobros separada.';
    COMMENT ON COLUMN cross_tenant_pagos.buyer_pago_id IS
      'Red B2B F4: FK lógica al proveedor_movimientos (tipo=pago) del BUYER. Nombre histórico de F1; el pago real vive en proveedor_movimientos, no en una tabla pagos separada.';

    -- ─── 2. tenants.red_b2b_caja_default_id ───────────────────────────────
    -- Caja default del tenant para recibir pagos cross-tenant propagados.
    --
    -- IMPORTANTE: FK LOGICA (NO fisica) a metodos_pago(id). Razon:
    --   tenants es la tabla raiz del sistema multi-tenant. Una FK fisica
    --   desde tenants a metodos_pago causa que TRUNCATE metodos_pago CASCADE
    --   (usado en test setup) elimine tambien las filas de tenants — efecto
    --   colateral catastrofico para tests que asumen tenant 1 vivo.
    --   Validamos en codigo (PATCH /caja-default chequea que el id existe + activo).
    ALTER TABLE tenants
      ADD COLUMN red_b2b_caja_default_id INTEGER;

    COMMENT ON COLUMN tenants.red_b2b_caja_default_id IS
      'Red B2B F4: caja default donde el tenant recibe pagos cross-tenant propagados desde el otro lado. Si NULL, el sistema usa la primera caja con moneda compatible. Configurable en /red-b2b/config. FK lógica a metodos_pago(id) — validada en código, no a nivel DB.';

    -- ─── 3. cross_tenant_operations.parent_op_id ──────────────────────────
    -- FK lógica a la op original cuando esta es una devolución (decisión #11).
    -- Devoluciones se modelan como NEW op con total negativo apuntando a la
    -- original. NULL para ops normales.
    --
    -- ON DELETE SET NULL: si la op original se borrara (no debería — cancel
    -- es soft), la devolución queda huérfana pero conservada.
    ALTER TABLE cross_tenant_operations
      ADD COLUMN parent_op_id BIGINT
        REFERENCES cross_tenant_operations(id) ON DELETE SET NULL;

    COMMENT ON COLUMN cross_tenant_operations.parent_op_id IS
      'Red B2B F4: si esta op es una DEVOLUCIÓN cross-tenant (decisión #11), apunta a la op original. NULL para ops normales. Total_usd/ars son NEGATIVOS en devoluciones.';

    CREATE INDEX idx_cross_ops_parent
      ON cross_tenant_operations(parent_op_id)
      WHERE parent_op_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Drop en orden inverso.
    DROP INDEX IF EXISTS idx_cross_ops_parent;
    ALTER TABLE cross_tenant_operations DROP COLUMN IF EXISTS parent_op_id;

    ALTER TABLE tenants DROP COLUMN IF EXISTS red_b2b_caja_default_id;

    ALTER TABLE cross_tenant_pagos DROP COLUMN IF EXISTS cambio_divisa_id;
    ALTER TABLE cross_tenant_pagos DROP COLUMN IF EXISTS diferencia_cambiaria_ars;
    ALTER TABLE cross_tenant_pagos DROP COLUMN IF EXISTS tc_pago;
    ALTER TABLE cross_tenant_pagos DROP COLUMN IF EXISTS tc_venta;
    ALTER TABLE cross_tenant_pagos DROP COLUMN IF EXISTS moneda_pago;
  `);
};

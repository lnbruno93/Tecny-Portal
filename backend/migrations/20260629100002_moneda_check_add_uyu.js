/**
 * Multi-país (Pesos UY) — F1: extender CHECK de `moneda` a UYU globalmente.
 *
 * Contexto: ver `docs/design/multi-pais-uyu.md`, sección 3.2.2.
 *
 * Qué hace:
 *   - Para cada columna `moneda` (y `costo_moneda` / `precio_moneda` en
 *     productos) con un CHECK explícito que enumera valores, DROP el
 *     constraint existente y ADD uno nuevo con el enum globalmente extendido
 *     a `('ARS','USD','USDT','UYU')`.
 *
 * Decisión durable (Lucas, 2026-06-29):
 *   - El CHECK DB es PERMISSIVE GLOBAL. La validación de "qué moneda puede
 *     usar este tenant" vive en Zod backend (`isMonedaValidaParaPais`) +
 *     dropdown UI gating por `tenant.pais`. Mantenemos DB desacoplada del
 *     concepto de país — más fácil de mantener, una sola lista de 4 valores.
 *   - Algunas columnas hoy son `('USD','ARS')` (sin USDT): `productos.costo_moneda`,
 *     `productos.precio_moneda`, `venta_items.moneda`. Las llevamos directo al
 *     enum de 4. El gating fino (qué pares de moneda son válidos para cada
 *     flow) es responsabilidad de la capa de aplicación.
 *
 * No tocadas en F1 (explícito):
 *   - `cross_tenant_pagos.moneda_pago` queda `('USD','ARS')` — F4 (Red B2B
 *     cross-frontera) lo extiende cuando agreguemos el flow Argentina↔Uruguay.
 *   - `items_movimiento_cc.costo_moneda` y `cambio_movimientos` no tienen
 *     CHECK explícito de moneda (free TEXT o monto ARS/USD separados) —
 *     no se agregan constraints nuevos en F1 (sería cambio de comportamiento).
 *
 * Constraint names: PostgreSQL autogenera nombres con el patrón
 * `<tabla>_<columna>_check` cuando el CHECK se define inline en CREATE TABLE.
 * Usamos `DROP CONSTRAINT IF EXISTS` para hacer la migration idempotente:
 * si el nombre real difiere (algún migration intermedia lo renombró), el
 * DROP IF EXISTS no falla, y el ADD nuevo recompacta el estado correcto.
 */

// Notas sobre tablas NO incluidas (verificado vs DDL de origen):
//   - `ventas` (cabecera) NO tiene columna `moneda` — el total se asienta
//     siempre en USD (campos `total_usd`, `ganancia_usd`, `tc_venta`). La
//     moneda vive a nivel item (`venta_items.moneda`) y pago (`venta_pagos.moneda`).
//   - `pagos` (B2B Financiera, no confundir con `venta_pagos` de retail)
//     NO tiene columna `moneda` — usa `monto` + `tc` + `monto_usd` (post
//     migration 20260607000002).
//   - `canjes.moneda` ('USD','ARS') queda fuera del scope F1 — los canjes
//     son operaciones de retail puramente AR hoy; extender si Uruguay
//     habilita canjes en una fase futura.
const TABLES = [
  // [tabla,                 columna,         constraint_name_convencional]
  ['productos',              'costo_moneda',  'productos_costo_moneda_check'],
  ['productos',              'precio_moneda', 'productos_precio_moneda_check'],
  ['metodos_pago',           'moneda',        'metodos_pago_moneda_check'],
  ['venta_items',            'moneda',        'venta_items_moneda_check'],
  ['venta_pagos',            'moneda',        'venta_pagos_moneda_check'],
  ['proveedor_movimientos',  'moneda',        'proveedor_movimientos_moneda_check'],
  ['egresos',                'moneda',        'egresos_moneda_check'],
  ['egresos_recurrentes',    'moneda',        'egresos_recurrentes_moneda_check'],
  ['tarjeta_movimientos',    'moneda',        'tarjeta_movimientos_moneda_check'],
  ['envio_items',            'moneda',        'envio_items_moneda_check'],
];

const ENUM_NEW = `('ARS','USD','USDT','UYU')`;
// Enum original — para el down. Restauramos exactamente el shape histórico
// de cada CHECK constraint según las migrations de origen (verificado en
// 20260524000001_inventario.js, 20260524000002_ventas.js,
// 20260525000002_proveedores.js, 20260528000001_egresos_modulo.js,
// 20260530000001_tarjetas.js, 20260603000004_envio_item_moneda_tc.js,
// 20260624100000_egresos_recurrentes_overrides.js).
//
// Importante: `venta_items.moneda` (retail) NO tenía USDT originalmente —
// sólo (USD,ARS). El módulo Ventas históricamente no aceptaba pagos en USDT
// a nivel item (USDT vivía solo en `venta_pagos`). El down restaura eso.
const DOWN_ENUMS = {
  'productos_costo_moneda_check':              `('USD','ARS')`,
  'productos_precio_moneda_check':             `('USD','ARS')`,
  'venta_pagos_moneda_check':                  `('USD','ARS','USDT')`,
  'metodos_pago_moneda_check':                 `('USD','ARS','USDT')`,
  'venta_items_moneda_check':                  `('USD','ARS')`,
  'proveedor_movimientos_moneda_check':        `('USD','ARS','USDT')`,
  'egresos_moneda_check':                      `('USD','ARS','USDT')`,
  'egresos_recurrentes_moneda_check':          `('USD','ARS','USDT')`,
  'tarjeta_movimientos_moneda_check':          `('USD','ARS','USDT')`,
  'envio_items_moneda_check':                  `('ARS','USD','USDT')`,
};

exports.up = (pgm) => {
  for (const [tabla, columna, constraint] of TABLES) {
    pgm.sql(`ALTER TABLE ${tabla} DROP CONSTRAINT IF EXISTS ${constraint};`);
    pgm.sql(`
      ALTER TABLE ${tabla}
        ADD CONSTRAINT ${constraint}
        CHECK (${columna} IN ${ENUM_NEW});
    `);
  }
};

exports.down = (pgm) => {
  for (const [tabla, columna, constraint] of TABLES) {
    const originalEnum = DOWN_ENUMS[constraint];
    pgm.sql(`ALTER TABLE ${tabla} DROP CONSTRAINT IF EXISTS ${constraint};`);
    pgm.sql(`
      ALTER TABLE ${tabla}
        ADD CONSTRAINT ${constraint}
        CHECK (${columna} IN ${originalEnum});
    `);
  }
};

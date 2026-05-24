/* eslint-disable camelcase */
/**
 * Migración 007 — CHECK constraints de montos (defensa en profundidad).
 *
 * La app ya valida con Zod, pero estos CHECK garantizan a nivel DB que nunca
 * entren montos negativos por otra vía. NO se restringe ganancia_usd: una venta
 * a pérdida (precio < costo) es válida y puede dar ganancia negativa.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE productos   ADD CONSTRAINT productos_costo_chk      CHECK (costo >= 0);
    ALTER TABLE productos   ADD CONSTRAINT productos_precio_chk     CHECK (precio_venta >= 0);
    ALTER TABLE venta_items ADD CONSTRAINT venta_items_precio_chk   CHECK (precio_vendido >= 0);
    ALTER TABLE venta_items ADD CONSTRAINT venta_items_costo_chk    CHECK (costo >= 0);
    ALTER TABLE venta_items ADD CONSTRAINT venta_items_comision_chk CHECK (comision >= 0);
    ALTER TABLE venta_pagos ADD CONSTRAINT venta_pagos_monto_chk    CHECK (monto >= 0 AND monto_usd >= 0);
    ALTER TABLE canjes      ADD CONSTRAINT canjes_valor_chk         CHECK (valor_toma >= 0);
    ALTER TABLE egresos     ADD CONSTRAINT egresos_monto_chk        CHECK (monto >= 0 AND monto_usd >= 0);
    ALTER TABLE ventas      ADD CONSTRAINT ventas_total_chk         CHECK (total_usd >= 0);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE productos   DROP CONSTRAINT IF EXISTS productos_costo_chk;
    ALTER TABLE productos   DROP CONSTRAINT IF EXISTS productos_precio_chk;
    ALTER TABLE venta_items DROP CONSTRAINT IF EXISTS venta_items_precio_chk;
    ALTER TABLE venta_items DROP CONSTRAINT IF EXISTS venta_items_costo_chk;
    ALTER TABLE venta_items DROP CONSTRAINT IF EXISTS venta_items_comision_chk;
    ALTER TABLE venta_pagos DROP CONSTRAINT IF EXISTS venta_pagos_monto_chk;
    ALTER TABLE canjes      DROP CONSTRAINT IF EXISTS canjes_valor_chk;
    ALTER TABLE egresos     DROP CONSTRAINT IF EXISTS egresos_monto_chk;
    ALTER TABLE ventas      DROP CONSTRAINT IF EXISTS ventas_total_chk;
  `);
};

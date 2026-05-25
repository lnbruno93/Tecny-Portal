/* eslint-disable camelcase */
/**
 * Ítems de los movimientos de proveedor — espejo de items_movimiento_cc (B2B).
 *
 * Una COMPRA a proveedor carga los productos comprados como líneas (igual que el
 * registro de venta B2B): producto, modelo, tamaño, color, IMEI/serial, valor.
 * Los PAGOS no llevan ítems.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS proveedor_movimiento_items (
      id                       SERIAL PRIMARY KEY,
      proveedor_movimiento_id  INTEGER NOT NULL REFERENCES proveedor_movimientos(id) ON DELETE CASCADE,
      producto                 TEXT,
      modelo                   TEXT,
      tamano                   TEXT,
      color                    TEXT,
      imei_serial              TEXT,
      valor                    NUMERIC(12,2) CHECK (valor IS NULL OR valor >= 0),
      verificado               BOOLEAN NOT NULL DEFAULT false,
      notas                    TEXT,
      created_at               TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_prov_mov_items_mov ON proveedor_movimiento_items (proveedor_movimiento_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS proveedor_movimiento_items CASCADE;');
};

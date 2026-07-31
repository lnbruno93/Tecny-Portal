/* eslint-disable camelcase */
/**
 * Migración — agregar `producto_id` FK a `proveedor_movimiento_items`.
 *
 * ── Motivación ────────────────────────────────────────────────────────
 *
 * Feature Fase B del pedido Gianfranco Amato (2026-07-30, PR #951): al
 * editar una compra a proveedor, los cambios en campos del item (nombre,
 * modelo, color, IMEI, valor) deben sincronizarse al producto asociado en
 * Inventario. En PR #951 el sync se hizo matcheando por IMEI ORIGINAL —
 * funcionó pero dejó una limitación: **items sin IMEI (accesorios como
 * cargadores, cables, fundas) no se pueden matchear con seguridad**, así
 * que sus productos asociados no sincronizan.
 *
 * Fix arquitectónico: FK explícita `producto_id` → `productos.id`. Al
 * crear una compra que crea productos, populamos el FK. Al editar, usamos
 * el FK para localizar el producto en lugar del matching por IMEI. Cero
 * heurística, cero límite por presencia de IMEI.
 *
 * ── Diseño ────────────────────────────────────────────────────────────
 *
 * - `producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL`:
 *   nullable porque no todos los items crean producto (los "puros" de
 *   concepto/gasto no lo hacen). ON DELETE SET NULL para que si un
 *   producto se elimina (soft-delete no toca la FK, DELETE físico sí),
 *   la fila del item sobrevive.
 * - Index en (producto_id) para queries reverse (dado un producto, ¿de
 *   qué compra vino?). Útil para trazabilidad + reports futuros.
 *
 * ── Backfill ──────────────────────────────────────────────────────────
 *
 * Populamos `producto_id` en filas históricas matcheando por
 * `proveedor_movimiento_id + imei_serial`:
 *
 *   UPDATE proveedor_movimiento_items pmi
 *      SET producto_id = p.id
 *     FROM productos p
 *    WHERE p.proveedor_movimiento_id = pmi.proveedor_movimiento_id
 *      AND p.imei = pmi.imei_serial
 *      AND p.deleted_at IS NULL
 *      AND pmi.imei_serial IS NOT NULL;
 *
 * Items sin IMEI en la historia quedan con producto_id = NULL — no se
 * pueden matchear determinísticamente. Para sincronizarlos, hay que
 * editarlos manualmente desde Inventario. La FK aplica a items NUEVOS
 * de acá para adelante.
 *
 * NO usamos NO FORCE ROW LEVEL SECURITY porque el UPDATE es JOIN con
 * columnas de productos (misma tenant scope), y proveedor_movimiento_items
 * hereda RLS via proveedor_movimiento_id → proveedor_movimientos.tenant_id.
 * El SUPERUSER de migrations bypassea RLS.
 *
 * ── Reversibilidad ────────────────────────────────────────────────────
 *
 * `down()` dropea columna + index. Es aditivo y compatible con backfill,
 * así que la reversión es limpia. Si en el futuro se agrega lógica que
 * REQUIERA producto_id NOT NULL, cambiar down para preservar data.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1) Agregar columna nullable con FK. ON DELETE SET NULL para que
    --    borrar un producto (raro, normalmente es soft-delete) no
    --    cascade-borre el item de la compra.
    ALTER TABLE proveedor_movimiento_items
      ADD COLUMN IF NOT EXISTS producto_id INTEGER
        REFERENCES productos(id) ON DELETE SET NULL;

    -- 2) Index para queries reverse (dado un producto, ¿en qué compra vino?)
    --    y también para acelerar el JOIN del handler PUT /movimientos/:mid
    --    cuando filtra items del mov + productos.
    CREATE INDEX IF NOT EXISTS idx_prov_mov_items_producto
      ON proveedor_movimiento_items (producto_id)
      WHERE producto_id IS NOT NULL;

    -- 3) Backfill: matchear items históricos con productos por IMEI.
    --    Solo items con imei_serial no vacío pueden matchearse — los
    --    accesorios sin IMEI quedan con producto_id = NULL. Para
    --    sincronizarlos en el futuro, editarlos desde Inventario o
    --    borrar/recargar la compra.
    UPDATE proveedor_movimiento_items pmi
       SET producto_id = p.id
      FROM productos p
     WHERE p.proveedor_movimiento_id = pmi.proveedor_movimiento_id
       AND p.imei = pmi.imei_serial
       AND p.deleted_at IS NULL
       AND pmi.imei_serial IS NOT NULL
       AND pmi.producto_id IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_prov_mov_items_producto;
    ALTER TABLE proveedor_movimiento_items
      DROP COLUMN IF EXISTS producto_id;
  `);
};

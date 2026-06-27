/**
 * Migration: Red B2B F2 — productos.pending_cross_tenant_review.
 *
 * Diseño en docs/design/red-b2b-cross-tenant.md sección 4.2 (cambios a
 * productos). F2 agrega los flags de "auto-create con flag" del side buyer.
 *
 * Semántica:
 *   - `pending_cross_tenant_review = true` → producto auto-creado por una
 *     operación cross-tenant en el lado del buyer; el buyer todavía no lo
 *     revisó. La UI muestra badge "Pendiente revisión" + acción
 *     "Confirmar como nuevo" o "Mergear con producto existente".
 *   - `created_from_cross_tenant_op_id` → trazabilidad de dónde vino el
 *     producto auto-creado. Puede ser NULL para productos normales del
 *     buyer (default — la mayoría de productos del catálogo).
 *
 * El trigger de auto-create (F3) populará estas columnas en cada venta
 * cross-tenant. F2 solo agrega el schema + los endpoints buyer-side para
 * revisar/confirmar/mergear. Los tests F2 inserta productos con el flag a
 * mano para simular F3.
 *
 * Index parcial: queries para "productos pendientes de revisión" son
 * frecuentes en la UI del buyer (badge en sidebar, pantalla dedicada)
 * pero superficiales del lado del seller (siempre false). El partial index
 * por tenant_id WHERE pending_cross_tenant_review = true es minúsculo en
 * tamaño y rápido para counts/listados.
 *
 * Reversible: down dropea ambas columnas + el index parcial. Las columnas
 * son ALTER ADD con default false y NULL, así la migration no necesita
 * backfill — las filas existentes quedan con `pending_cross_tenant_review
 * = false` y `created_from_cross_tenant_op_id = NULL`, que es exactamente
 * la semántica que queremos (productos pre-existentes no son auto-creados).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE productos
      ADD COLUMN pending_cross_tenant_review BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE productos
      ADD COLUMN created_from_cross_tenant_op_id BIGINT
        REFERENCES cross_tenant_operations(id);

    COMMENT ON COLUMN productos.pending_cross_tenant_review IS
      'Red B2B F2: producto auto-creado por una operación cross-tenant pendiente de revisión del buyer (confirm-new o merge-into).';
    COMMENT ON COLUMN productos.created_from_cross_tenant_op_id IS
      'Red B2B F2: FK a la cross_tenant_operations que originó este producto (NULL para productos normales).';

    -- Partial index: queries del buyer son frecuentes pero apenas algunas filas
    -- por tenant tienen el flag=true. Por tenant_id porque la pantalla
    -- "Pendientes de revisión" siempre filtra por tenant del caller.
    CREATE INDEX idx_productos_pending_review
      ON productos(tenant_id)
      WHERE pending_cross_tenant_review = true;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_productos_pending_review;
    ALTER TABLE productos DROP COLUMN IF EXISTS created_from_cross_tenant_op_id;
    ALTER TABLE productos DROP COLUMN IF EXISTS pending_cross_tenant_review;
  `);
};

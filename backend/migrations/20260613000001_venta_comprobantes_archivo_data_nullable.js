/* eslint-disable camelcase */
// Fix P-03 Fase 5: drop NOT NULL en venta_comprobantes.archivo_data.
//
// Bug del diseño P-03 detectado en smoke test 2026-06-13.
//
// Contexto:
//   En la migración inicial del módulo Ventas B2B (20260524000003_venta-comprobantes.js)
//   `venta_comprobantes.archivo_data TEXT NOT NULL` fue declarado así porque
//   era el ÚNICO campo donde vivía el blob. Sin él, no había comprobante.
//
//   En P-03 Fase 2 agregamos `archivo_key TEXT` y `archivo_size INTEGER` para
//   alojar la referencia R2 cuando el flag `storage_r2_ventas_comprobantes` está
//   ON. En ese path, `archivo_data` queda NULL (el blob está en R2). Pero
//   omití droppear el NOT NULL en esa migración → el INSERT explota con
//   23502 not_null_violation cuando el path R2 corre.
//
//   Las otras 2 tablas (`comprobantes.archivo_data`, `productos.foto_data`)
//   YA eran NULLABLE de origen (porque históricamente esos endpoints
//   permitían crear filas sin archivo). Solo venta_comprobantes era NOT NULL.
//
// Esta migración:
//   ALTER TABLE venta_comprobantes ALTER COLUMN archivo_data DROP NOT NULL.
//   La data existente no se toca — todas las filas pre-fase-5 tienen
//   archivo_data poblada y siguen ahí. Solo permite que filas NUEVAS la
//   tengan NULL si archivo_key está poblada.
//
// Invariante operativo (no enforceada en DB todavía, ver doc P-03):
//   Para cada fila: (archivo_data IS NOT NULL) XOR (archivo_key IS NOT NULL).
//   Una fila NUNCA debe tener ambas NULL (= comprobante sin archivo, sin sentido).
//   El check constraint queda para una migración post-backfill cuando se
//   limpie el campo archivo_data de filas migradas (Fase 6 P-03 cleanup).
//
// Down: re-aplica NOT NULL. Solo es seguro si TODAS las filas tienen
//   archivo_data poblada (rollback antes de activar el flag R2 en prod).

exports.up = pgm => {
  pgm.alterColumn('venta_comprobantes', 'archivo_data', { notNull: false });
};

exports.down = pgm => {
  pgm.alterColumn('venta_comprobantes', 'archivo_data', { notNull: true });
};

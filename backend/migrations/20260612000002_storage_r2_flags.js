/* eslint-disable camelcase */
// P-03 Fase 3 — Seed de feature flags para R2 storage por entity.
//
// Doc de diseño: docs/design/p03-r2-storage.md
//
// Contexto:
//   El driver R2 está disponible desde Fase 2 (STORAGE_DRIVER=r2 en Railway),
//   pero NO se activa todavía para ningún endpoint. Esta migración seedea 3
//   feature flags que controlan el rollout entity-by-entity:
//
//     - storage_r2_comprobantes        → POST /api/comprobantes
//     - storage_r2_productos           → POST/PUT /api/inventario/productos
//     - storage_r2_ventas_comprobantes → POST /api/ventas/:id/comprobantes
//
//   Cuando un flag está ON Y STORAGE_DRIVER=r2, los uploads NUEVOS de esa
//   entity van a R2 (columna `*_key`). Cuando está OFF, van a `*_data` (legacy).
//   Reads tienen fallback automático: si la fila tiene `*_key`, R2; si solo
//   `*_data`, legacy. Eso permite prender el flag sin perder acceso a
//   uploads anteriores.
//
//   Activación planeada (orden):
//     1. Esta migración con todos los flags en `enabled = false`.
//     2. Fase 3 (este PR) refactoriza POST /api/comprobantes para chequear el
//        flag. Mergeada → deploy → flag sigue OFF → comportamiento idéntico.
//     3. PATCH al flag en staging → smoke test con upload real.
//     4. PATCH al flag en prod → 24h de observación en Sentry.
//     5. Fase 4 (PR aparte): repetir para productos.
//     6. Fase 5 (PR aparte): repetir para venta_comprobantes.
//     7. Fase 6: backfill de blobs históricos + RUNBOOK.
//
// Down: borra los 3 flags. Reversibilidad full (los flags son metadata
// operativa, no datos del negocio).

const FLAGS = [
  {
    name: 'storage_r2_comprobantes',
    description: 'P-03 Fase 3 — cuando ON + STORAGE_DRIVER=r2, los uploads de POST /api/comprobantes van a R2. Lecturas con fallback automático a archivo_data legacy.',
  },
  {
    name: 'storage_r2_productos',
    description: 'P-03 Fase 4 — cuando ON + STORAGE_DRIVER=r2, las fotos de productos van a R2. Lecturas con fallback automático a foto_data legacy.',
  },
  {
    name: 'storage_r2_ventas_comprobantes',
    description: 'P-03 Fase 5 — cuando ON + STORAGE_DRIVER=r2, los comprobantes de venta van a R2. Lecturas con fallback automático a archivo_data legacy.',
  },
];

exports.up = pgm => {
  for (const flag of FLAGS) {
    // ON CONFLICT DO NOTHING — idempotente. Si la migración se re-corre por
    // algún motivo (raro pero defendible), no falla con duplicate key.
    pgm.sql(`
      INSERT INTO feature_flags (name, enabled, description)
      VALUES ('${flag.name}', false, '${flag.description.replace(/'/g, "''")}')
      ON CONFLICT (name) DO NOTHING
    `);
  }
};

exports.down = pgm => {
  for (const flag of FLAGS) {
    pgm.sql(`DELETE FROM feature_flags WHERE name = '${flag.name}'`);
  }
};

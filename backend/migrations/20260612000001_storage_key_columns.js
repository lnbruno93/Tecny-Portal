/* eslint-disable camelcase */
// P-03 GRAN auditoría 2026-06-10 — Columnas para object storage externo (R2).
//
// Doc de diseño: docs/design/p03-r2-storage.md (aprobado por Lucas 2026-06-12).
//
// Contexto:
//   Los archivos subidos por usuarios (comprobantes Financiera, fotos de
//   productos, comprobantes de venta B2B) viven hoy como base64 en columnas
//   TEXT de PostgreSQL. PostgreSQL TOAST los almacena fuera de la fila, pero a
//   escala SaaS (cientos de empresas con miles de fotos) esto infla la DB,
//   ralentiza backups y desperdicia CPU en decoding base64 por cada GET.
//
//   La migración a Cloudflare R2 se hace progresivamente: Fase 1 ya introdujo
//   la abstracción fileStore.js. Esta migración (Fase 2) agrega las columnas
//   donde el driver R2 va a guardar la referencia al object (object key) y el
//   tamaño en bytes, para tracking de uso del bucket.
//
// Esta migración:
//   1) Agrega `archivo_key TEXT NULL` + `archivo_size INTEGER NULL` a
//      `comprobantes` y `venta_comprobantes`.
//   2) Agrega `foto_key TEXT NULL` + `foto_size INTEGER NULL` a `productos`.
//
// Invariante (NO enforced por DB en esta migración — agregar CHECK constraint
// se difiere a una migración post-backfill):
//   Para cada fila, las columnas `*_data` y `*_key` son mutuamente exclusivas
//   en el sentido lógico: una fila nueva (post-flag-ON) tiene `*_key` seteada
//   y `*_data` NULL. Una fila legacy (pre-flag-ON) tiene `*_data` seteada y
//   `*_key` NULL. Una fila sin archivo tiene ambas NULL.
//
//   El CHECK constraint NO se mete acá porque durante el backfill (Fase 6)
//   las filas en migración van a tener ambas columnas seteadas brevemente
//   (write a R2 + write a key column + delete data column como pasos atómicos).
//
// Notas de diseño:
//   · Las 4 columnas son NULLABLE — no toca filas existentes (zero downtime).
//   · `archivo_key` y `foto_key` son TEXT (no VARCHAR) porque los object keys
//     R2 pueden tener formato variable. Ejemplo: 'ipro/prod/comprobantes/2026/
//     06/12/abc-uuid.pdf' (~60 chars típico, hasta ~250 con paths anidados).
//   · `archivo_size` y `foto_size` son INTEGER (no BIGINT) — el body limit de
//     Express es 10MB, INT max es 2GB. 1000× headroom es suficiente.
//   · NO agregamos índices en estas columnas — son writes-once + reads-by-id
//     (vía join al PK de la fila). Cualquier query forense ("cuál es el bucket
//     usage actual") sería un SUM agregado, que toca todos los rows igual.
//
// Down: T-05 enforcement. Dropea las 6 columnas. Como son NULLABLE y no hay
// índices, el rollback es instantáneo y safe — no se pierden datos legacy
// (archivo_data/foto_data) porque esas columnas no se tocan.

exports.up = pgm => {
  pgm.addColumns('comprobantes', {
    archivo_key:  { type: 'text',    notNull: false },
    archivo_size: { type: 'integer', notNull: false },
  });

  pgm.addColumns('productos', {
    foto_key:  { type: 'text',    notNull: false },
    foto_size: { type: 'integer', notNull: false },
  });

  pgm.addColumns('venta_comprobantes', {
    archivo_key:  { type: 'text',    notNull: false },
    archivo_size: { type: 'integer', notNull: false },
  });
};

exports.down = pgm => {
  pgm.dropColumns('venta_comprobantes', ['archivo_key', 'archivo_size']);
  pgm.dropColumns('productos',          ['foto_key', 'foto_size']);
  pgm.dropColumns('comprobantes',       ['archivo_key', 'archivo_size']);
};

/**
 * Multi-país (Pesos UY) — F1: agregar `tenants.pais`.
 *
 * Contexto: ver `docs/design/multi-pais-uyu.md`, sección 3.2.1.
 *
 * Qué hace:
 *   - Agrega columna `pais` CHAR(2) NOT NULL DEFAULT 'AR' con CHECK (pais IN ('AR','UY')).
 *   - Todos los tenants existentes son argentinos — el DEFAULT cubre el backfill,
 *     pero corremos un UPDATE defensivo para evidenciar la decisión en el audit log.
 *   - COMMENT explícito para el próximo maintainer.
 *
 * Decisión durable (Lucas, 2026-06-29):
 *   - País del tenant es inmutable desde la UI post-signup. Cualquier cambio
 *     real requiere intervención de super-admin via SQL directo. NO se expone
 *     endpoint para cambiarlo.
 *   - Enum extensible (CL/PY/MX/etc.) cambiando solamente el CHECK constraint.
 *   - El CHECK del enum de moneda (en otras tablas) NO se valida país-aware acá
 *     — esa validación vive en Zod backend + dropdown UI. El CHECK DB queda
 *     globalmente permissive (`('ARS','USD','USDT','UYU')`) para evitar
 *     acoplamiento DB↔país.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants
      ADD COLUMN pais CHAR(2) NOT NULL DEFAULT 'AR'
        CHECK (pais IN ('AR','UY'));
  `);
  // Backfill explícito (defensive — el DEFAULT ya cubre, pero documentamos
  // la decisión en el SQL real que corre la migration).
  pgm.sql(`UPDATE tenants SET pais = 'AR' WHERE pais IS NULL;`);
  pgm.sql(`
    COMMENT ON COLUMN tenants.pais IS
      'País del tenant (AR=Argentina, UY=Uruguay). Inmutable desde UI post-signup. Determina moneda local + locale + TC defaults. Ver docs/design/multi-pais-uyu.md';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE tenants DROP COLUMN pais;`);
};

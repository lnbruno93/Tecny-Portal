/**
 * Release notes (task #141).
 *
 * 2026-07-16: nuevo sistema para comunicar cambios/features al cliente
 * final desde el portal. Motivación: en 48h se mergearon 13 PRs con features
 * y fixes visibles al usuario, pero el cliente no se entera. Cuando algo se
 * ve distinto no puede distinguir "mejora" de "bug" — genera dudas por WA.
 *
 * Diseño:
 *   · `release_notes` — tabla global (mismas notas para todos los tenants,
 *     no per-tenant como el CMS Landing). El super-admin las crea/edita
 *     desde admin-frontend.
 *   · `users.last_seen_release_notes_at` — timestamp por user para saber
 *     qué notas son "nuevas" desde su última visita a /novedades. El badge
 *     en el menu muestra el count desde ese timestamp.
 *
 * Sin RLS (admin-only writes; reads públicas para todos los tenants).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE release_notes (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      titulo        TEXT NOT NULL,
      descripcion   TEXT NOT NULL,
      tipo          TEXT NOT NULL,
      publicado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT release_notes_titulo_len       CHECK (length(trim(titulo)) BETWEEN 1 AND 60),
      CONSTRAINT release_notes_descripcion_len  CHECK (length(trim(descripcion)) BETWEEN 1 AND 280),
      CONSTRAINT release_notes_tipo_valid       CHECK (tipo IN ('feature', 'mejora', 'fix'))
    );

    -- Index para el ORDER BY publicado_en DESC del listado público
    -- (el caso más frecuente: "traeme las últimas N notas").
    CREATE INDEX release_notes_publicado_en_idx ON release_notes (publicado_en DESC);

    -- Tracking por-user de "hasta cuándo vio novedades". NULL = nunca vio →
    -- todas las notas cuentan como no vistas. Se actualiza a NOW() cuando
    -- el user abre /novedades (POST /release-notes/mark-seen).
    ALTER TABLE users
      ADD COLUMN last_seen_release_notes_at TIMESTAMPTZ;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users DROP COLUMN IF EXISTS last_seen_release_notes_at;
    DROP TABLE IF EXISTS release_notes;
  `);
};

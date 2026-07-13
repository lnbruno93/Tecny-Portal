/**
 * Extender `site_landing_config` con `google_reviews_enabled BOOLEAN` —
 * toggle admin para activar/pausar la sección de reseñas de Google en la landing.
 *
 * 2026-07-13 (feature):
 *
 * Fase 2 extendida (migration 20260713300000) agregó testimonials editables.
 * Después conectamos la landing a Places API para mostrar reseñas reales del
 * Google Business Profile. Ahora Lucas quiere poder pausar la integración
 * desde el admin sin tocar env vars ni redeploy.
 *
 * Comportamiento:
 *   · true (default) → backend `/api/public/google-reviews` llama a Google
 *     Places API (cache 6hs) y devuelve las reseñas normalizadas.
 *   · false → mismo endpoint devuelve `{ reviews: [], disabled: true }` sin
 *     llamar a Google (ahorra API + rate limit). La landing usa sus reseñas
 *     manuales de la CMS Fase 2 (o los 12 fallback hardcodeados).
 *
 * Diseño:
 *   · NOT NULL DEFAULT true — mantiene el comportamiento pre-migration
 *     (Google Reviews activadas). Los tenants que se hayan integrado ya no
 *     ven cambio al aplicar la migration.
 *   · Sin CHECK — es un boolean simple, no hay dominio custom.
 *   · Live en la tabla singleton `site_landing_config` (row id=1),
 *     mismo patrón que los otros toggles/config del CMS.
 *
 * Alternativa considerada: env var GOOGLE_REVIEWS_ENABLED. Descartado porque
 * cambiar require redeploy de Railway — la idea del toggle es que Lucas lo
 * pause/active en <5s desde el admin.
 */

exports.up = (pgm) => {
  pgm.addColumns('site_landing_config', {
    google_reviews_enabled: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('site_landing_config', ['google_reviews_enabled']);
};

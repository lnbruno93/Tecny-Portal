/**
 * Extender `site_landing_config` con Hero + CTA final + FAQ editables desde admin.
 *
 * 2026-07-13 (CMS Landing Fase 3):
 *
 * Fase 1 (20260713200000) → Contacto editable
 * Fase 2 (20260713300000) → Testimonials
 * Fase 2b (20260713400000) → toggle google_reviews
 * Fase 3 (esta) → Hero + CTA final + FAQ editables. Lucas quiere poder iterar
 *                 copy de landing sin redeploy (A/B mental, testeo de gancho,
 *                 estacionalidad).
 *
 * Diseño:
 *   Textos (hero + cta): columnas TEXT nullable. NULL/vacío → landing usa
 *   los fallback hardcoded (los defaults actuales del design). Permite:
 *   - Migration retro-compatible (rows viejas siguen con NULL, no requiere backfill).
 *   - Lucas puede editar solo lo que quiera (ej. cambiar hero_headline pero no
 *     hero_subheadline).
 *
 *   FAQ: JSONB array de {id, question, answer}. Mismo patrón que testimonials.
 *   Server genera UUID al agregar items nuevos. Landing usa fallback hardcoded
 *   si el array está vacío (patrón consistente).
 *
 * Sin CHECK constraints sobre el contenido — validación completa en Zod al PATCH.
 * Longitud máx de textos definida por Zod (no en DB) para poder ajustar sin
 * migration si en un futuro cambia el diseño y necesitamos headlines más largos.
 */

exports.up = (pgm) => {
  pgm.addColumns('site_landing_config', {
    // ── HERO ────────────────────────────────────────────────
    hero_headline:    { type: 'text' },   // "Todo tu negocio, en una sola pantalla."
    hero_subheadline: { type: 'text' },   // subtítulo debajo del headline
    hero_blurb:       { type: 'text' },   // párrafo descriptivo (150-300 chars)
    // Nota: no hago hero_headline NOT NULL porque las rows viejas quedarían
    // rotas hasta que Lucas edite. Con nullable, si es NULL → landing usa
    // hardcoded fallback. La UI del admin muestra el fallback como placeholder.

    // ── CTA FINAL ────────────────────────────────────────
    cta_headline: { type: 'text' },       // "Ordená tu negocio hoy"
    cta_body:     { type: 'text' },       // subtítulo del CTA (call-to-conversion)

    // ── FAQ ─────────────────────────────────────────────────
    // Shape (matchea el hardcoded actual en Landing.jsx):
    //   { id: uuid, question: string, answer: string }
    // Max 20 items — la landing muestra en <details>, más de 20 es UX pobre.
    // Default '[]' → array vacío → landing muestra las 6 hardcoded actuales.
    faq: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'[]'::jsonb"),
    },
  });

  // Re-seed de la row singleton con FAQ vacío para consistencia con testimonials.
  pgm.sql(`UPDATE site_landing_config SET faq = '[]'::jsonb WHERE id = 1`);
};

exports.down = (pgm) => {
  pgm.dropColumns('site_landing_config', [
    'hero_headline', 'hero_subheadline', 'hero_blurb',
    'cta_headline', 'cta_body',
    'faq',
  ]);
};

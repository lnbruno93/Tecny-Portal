/**
 * Extender `site_landing_config` con `testimonials JSONB` — CMS Landing Fase 2.
 *
 * 2026-07-13 (feature):
 *
 * Fase 1 (migration 20260713200000) creó la tabla singleton con solo campos
 * de contacto. Fase 2 agrega las reseñas/testimonios editables desde el admin.
 *
 * Contexto: la landing tecnyapp.com tiene 12 testimonios HARDCODED en
 * App.tsx (`reviews[]` array, ~línea 1355). Lucas quiere agregarlos/quitarlos
 * sin redeploy.
 *
 * Shape acordado (matchea el actual en App.tsx):
 *   {
 *     id: string (uuid, server-generated),
 *     name: string,
 *     initial: string (1-2 chars),
 *     color: string (hex, ej. "#4285F4"),
 *     time: string ("hace 3 días", texto libre),
 *     text: string (cuerpo del testimonio)
 *   }
 *
 * Diseño:
 *   · Columna JSONB con default `'[]'` — filas viejas quedan con array vacío,
 *     landing renderiza los defaults hardcodeados si el array viene vacío
 *     (fallback ya está en el hook use-site-config.ts).
 *   · NOT NULL para simplificar queries (nunca es NULL, siempre `[]`).
 *   · Sin CHECK de shape — validación completa vive en Zod al PATCH.
 *     JSONB permite queries futuras si hace falta (@> operator).
 *
 * Fase 3 (footer) agregará otra columna con el mismo patrón.
 */

exports.up = (pgm) => {
  pgm.addColumns('site_landing_config', {
    testimonials: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'[]'::jsonb"),
    },
  });
  // Seed inicial en la row singleton — arranca vacío, Lucas los carga desde
  // el admin. La landing muestra el fallback hardcodeado mientras esté vacío.
  pgm.sql(`UPDATE site_landing_config SET testimonials = '[]'::jsonb WHERE id = 1`);
};

exports.down = (pgm) => {
  pgm.dropColumns('site_landing_config', ['testimonials']);
};

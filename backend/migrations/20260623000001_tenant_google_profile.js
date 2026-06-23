/**
 * Migration: Tenant Google Profile — configuración de ficha de Google por tenant.
 *
 * Bug detectado por Lucas (2026-06-22, 22:55): el Cotizador genera un mensaje
 * con la frase hardcodeada:
 *   "Nos encontrás en Google como "Tecny Tech | Reseller" con +3200 reseñas..."
 *
 * Esto se filtra a TODOS los tenants del SaaS — cada cliente Tecny ve la
 * frase con datos de Tecny Tech (el negocio personal de Lucas), no del suyo.
 * Multi-tenancy roto en la capa de UX.
 *
 * Fix: 3 columnas en `tenants` para configurar la ficha de Google por
 * tenant. Si el tenant NO tiene ficha en Google (`google_business_enabled =
 * false`), la oración se omite por completo del mensaje generado. Si la
 * tiene (true), se renderea con su nombre real + cantidad de reseñas.
 *
 * Default conservador: `enabled = false`. Los tenants existentes (incluido
 * el tenant de Lucas con id=1) arrancan SIN la frase. Lucas configura el
 * suyo desde Config y el resto queda sin la oración hasta que la habilite.
 *
 * Reversible: down borra las 3 columnas. Si en prod hay tenants con valores
 * configurados, los pierde — backup antes de revertir.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants
      ADD COLUMN google_business_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN google_business_name    TEXT,
      ADD COLUMN google_reviews_count    INTEGER
        CHECK (google_reviews_count IS NULL OR google_reviews_count >= 0);

    COMMENT ON COLUMN tenants.google_business_enabled IS
      'Si el tenant tiene ficha de negocio en Google. Default false. Cuando true, el cotizador agrega la oración "Nos encontrás en Google..." al mensaje generado.';
    COMMENT ON COLUMN tenants.google_business_name IS
      'Nombre que aparece en la ficha de Google del tenant. Solo se usa si google_business_enabled = true.';
    COMMENT ON COLUMN tenants.google_reviews_count IS
      'Cantidad aproximada de reseñas en Google. Solo se usa si google_business_enabled = true. El operador la actualiza manualmente cuando crece su ficha.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants
      DROP COLUMN IF EXISTS google_reviews_count,
      DROP COLUMN IF EXISTS google_business_name,
      DROP COLUMN IF EXISTS google_business_enabled;
  `);
};

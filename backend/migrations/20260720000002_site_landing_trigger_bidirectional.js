/**
 * site_landing_config trigger → flip a bidireccional.
 *
 * Sprint 3 M4c del roadmap post-auditoría (docs/AUDIT_LANDING_2026-07-19.md).
 *
 * ── Contexto ──────────────────────────────────────────────────────────
 *
 * M4a agregó la columna `content JSONB` con un trigger BEFORE INSERT/UPDATE
 * que la sincroniza desde las columnas legacy (cols → content).
 *
 * M4b hizo el flip de READS: los endpoints leen desde `content` JSONB.
 * Los writes siguen escribiendo a las cols (por el trigger de M4a).
 *
 * M4c (este PR) hace el flip de WRITES: el PATCH del admin escribe
 * directamente a `content` JSONB via `UPDATE SET content = ...`. Pero
 * durante la ventana de deploy transition, el server viejo (todavía
 * escribiendo a cols) sigue vivo unos segundos. Para NO romperlo,
 * necesitamos que el trigger sea BIDIRECTIONAL:
 *
 *   · Si el write tocó `content` (nuevo server) → sync cols FROM content
 *   · Si el write NO tocó `content` (viejo server, INSERT nuevo, o legacy
 *     SQL manual) → sync content FROM cols (comportamiento M4a original)
 *
 * Así ambos servers coexisten durante la ventana de deploy sin conflicto:
 *   · Old server: escribe cols → trigger deriva content ← cols (invariante mantenida)
 *   · New server: escribe content → trigger deriva cols ← content (invariante mantenida)
 *
 * Cuando M4d haga el DROP COLUMN + DROP TRIGGER, ya vamos a estar 100%
 * en el mundo "content is source of truth" con cero rastros del legacy.
 *
 * ── Diseño del trigger bidireccional ──────────────────────────────────
 *
 * La detección "¿tocó content?" es via `NEW.content IS DISTINCT FROM
 * OLD.content`:
 *   · INSERT: OLD no existe → siempre entra en la rama "sync desde cols"
 *     (por default `content = '{}'`; si el caller pasó content explícito,
 *     ese comportamiento es raro y aceptamos que se re-derive de cols).
 *   · UPDATE tocando solo cols: NEW.content == OLD.content → rama "cols → content"
 *   · UPDATE tocando solo content: NEW.content != OLD.content → rama "content → cols"
 *   · UPDATE tocando ambos: entra rama "content → cols" (content wins)
 *     — en la práctica ningún endpoint hace esto; los servers escriben
 *     una fuente o la otra.
 */

const SYNC_CONTENT_FN = 'site_landing_config_sync_content';

exports.up = (pgm) => {
  // Replace la function del trigger. Notar: NO recreamos el CREATE TRIGGER
  // porque ya apunta al FN name — reemplazar la function via `CREATE OR
  // REPLACE FUNCTION` es suficiente. El trigger levanta la nueva definición
  // en el siguiente fire.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION ${SYNC_CONTENT_FN}()
    RETURNS TRIGGER AS $fn$
    BEGIN
      -- Rama A: write NO tocó content → derive content ← cols (M4a legacy path).
      -- Cubre: INSERT (OLD no existe), UPDATE tocando solo cols (viejo server,
      -- SQL manual, seeds, tests).
      IF TG_OP = 'INSERT' OR NEW.content IS NOT DISTINCT FROM OLD.content THEN
        NEW.content := jsonb_build_object(
          'contact', jsonb_build_object(
            'email',            NEW.contact_email,
            'whatsapp',         NEW.contact_whatsapp,
            'whatsapp_display', NEW.contact_whatsapp_display,
            'address',          NEW.contact_address,
            'instagram_handle', NEW.contact_instagram_handle,
            'instagram_url',    NEW.contact_instagram_url
          ),
          'hero', jsonb_build_object(
            'headline',    NEW.hero_headline,
            'subheadline', NEW.hero_subheadline,
            'blurb',       NEW.hero_blurb
          ),
          'cta', jsonb_build_object(
            'headline', NEW.cta_headline,
            'body',     NEW.cta_body
          ),
          'testimonials', COALESCE(NEW.testimonials, '[]'::jsonb),
          'faq',          COALESCE(NEW.faq, '[]'::jsonb),
          'features', jsonb_build_object(
            'google_reviews_enabled', COALESCE(NEW.google_reviews_enabled, true)
          )
        );
      ELSE
        -- Rama B: write tocó content explícitamente → derive cols ← content (M4c path).
        -- Cubre: UPDATE del nuevo server que escribe content directo. Las cols
        -- se mantienen sincronizadas para NO romper reads legacy que aún estén
        -- referenciando cols antes de que M4d haga el DROP COLUMN.
        --
        -- Cada extracción usa el operador ->> (text) o cast explícito para
        -- boolean. Nullish values quedan NULL — matchea el semantico de
        -- rama A donde también quedan NULL si el JSONB tiene null/missing.
        NEW.contact_email             := NEW.content->'contact'->>'email';
        NEW.contact_whatsapp          := NEW.content->'contact'->>'whatsapp';
        NEW.contact_whatsapp_display  := NEW.content->'contact'->>'whatsapp_display';
        NEW.contact_address           := NEW.content->'contact'->>'address';
        NEW.contact_instagram_handle  := NEW.content->'contact'->>'instagram_handle';
        NEW.contact_instagram_url     := NEW.content->'contact'->>'instagram_url';
        NEW.hero_headline    := NEW.content->'hero'->>'headline';
        NEW.hero_subheadline := NEW.content->'hero'->>'subheadline';
        NEW.hero_blurb       := NEW.content->'hero'->>'blurb';
        NEW.cta_headline     := NEW.content->'cta'->>'headline';
        NEW.cta_body         := NEW.content->'cta'->>'body';
        -- JSONB arrays van tal cual (o [] si missing).
        NEW.testimonials := COALESCE(NEW.content->'testimonials', '[]'::jsonb);
        NEW.faq          := COALESCE(NEW.content->'faq',          '[]'::jsonb);
        -- Boolean: cast text→bool. Si missing/null → default true (mantiene el
        -- fail-open del endpoint de google-reviews).
        NEW.google_reviews_enabled := COALESCE(
          (NEW.content->'features'->>'google_reviews_enabled')::boolean,
          true
        );
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
};

exports.down = (pgm) => {
  // Rollback: restaurar el trigger unidireccional de M4a (solo cols → content).
  // Es el mismo body que la migration 20260720000001 pero repetido para que
  // este archivo sea autocontenido.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION ${SYNC_CONTENT_FN}()
    RETURNS TRIGGER AS $fn$
    BEGIN
      NEW.content := jsonb_build_object(
        'contact', jsonb_build_object(
          'email',            NEW.contact_email,
          'whatsapp',         NEW.contact_whatsapp,
          'whatsapp_display', NEW.contact_whatsapp_display,
          'address',          NEW.contact_address,
          'instagram_handle', NEW.contact_instagram_handle,
          'instagram_url',    NEW.contact_instagram_url
        ),
        'hero', jsonb_build_object(
          'headline',    NEW.hero_headline,
          'subheadline', NEW.hero_subheadline,
          'blurb',       NEW.hero_blurb
        ),
        'cta', jsonb_build_object(
          'headline', NEW.cta_headline,
          'body',     NEW.cta_body
        ),
        'testimonials', COALESCE(NEW.testimonials, '[]'::jsonb),
        'faq',          COALESCE(NEW.faq, '[]'::jsonb),
        'features', jsonb_build_object(
          'google_reviews_enabled', COALESCE(NEW.google_reviews_enabled, true)
        )
      );
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
};

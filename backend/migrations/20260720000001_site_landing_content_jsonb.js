/**
 * site_landing_config → agregar `content JSONB` con trigger de sync.
 *
 * Sprint 3 M4a del roadmap post-auditoría (docs/AUDIT_LANDING_2026-07-19.md).
 *
 * ── Contexto ──────────────────────────────────────────────────────────
 *
 * `site_landing_config` es una tabla singleton (id=1) que sirve de CMS
 * para la landing pública. Hoy tiene 18 columnas repartidas en 4 secciones
 * conceptuales (contact, hero, cta, features + arrays JSONB testimonials/faq).
 * Cada feature nueva agrega 2-6 columnas. La audit lo ancló como M4:
 * refactor a `content JSONB` con Zod schema.
 *
 * Este PR es la fase 1 de 3 (additive):
 *   - Se agrega la columna `content JSONB` NOT NULL DEFAULT '{}'.
 *   - Un trigger BEFORE INSERT/UPDATE recomputa `content` a partir del
 *     resto de las columnas → el JSONB queda SIEMPRE sincronizado con
 *     las columnas legacy sin tocar código de escritura.
 *   - Los reads NO cambian todavía: siguen viniendo desde las columnas
 *     via GET público y GET super-admin. Es decir: this deploy es
 *     transparente al frontend/admin. Zero risk.
 *
 * Fase 2 (M4b): backend switch a leer desde `content` JSONB.
 * Fase 3 (M4c): DROP de las 12 columnas legacy + remove del trigger.
 *
 * ── Diseño del trigger ────────────────────────────────────────────────
 *
 * Alternativas consideradas:
 *   (a) Dual-write explícito en el PATCH endpoint (JavaScript arma el
 *       jsonb y lo escribe). CONTRA: 2 lugares para cambiar cuando se
 *       agrega un campo (columna + código); frágil.
 *   (b) Trigger BEFORE UPDATE que sincroniza en el server side (ELEGIDA).
 *       PRO: idempotente, transparente, cualquier writer (endpoint, hot-
 *       fix manual SQL, futuro admin) mantiene la invariante. Menos
 *       superficie de bug.
 *   (c) Generated column (`content JSONB GENERATED ALWAYS AS ...`). PG
 *       15+ soporta STORED generated columns pero NO permite JSONB
 *       generado desde otras columnas (solo tipos escalares y limited
 *       expresiones). Descartado por incompatibilidad.
 *
 * Elegimos (b). El trigger vive en la tabla, no depende del driver de la
 * app, y no puede quedar out-of-sync con un ALTER TABLE futuro (excepto
 * si alguien agrega columna nueva y olvida actualizar el trigger — el
 * test smoke de siteConfig.test.js valida que el JSONB matchea las cols).
 *
 * ── Shape del content JSONB ───────────────────────────────────────────
 *
 * {
 *   "contact": {
 *     "email":            string|null,
 *     "whatsapp":         string|null,
 *     "whatsapp_display": string|null,
 *     "address":          string|null,
 *     "instagram_handle": string|null,
 *     "instagram_url":    string|null
 *   },
 *   "hero": {
 *     "headline":    string|null,
 *     "subheadline": string|null,
 *     "blurb":       string|null
 *   },
 *   "cta": {
 *     "headline": string|null,
 *     "body":     string|null
 *   },
 *   "testimonials": [ { id, name, initial, color, time, text }, ... ],
 *   "faq":          [ { id, question, answer }, ... ],
 *   "features": {
 *     "google_reviews_enabled": boolean
 *   }
 * }
 *
 * Consumidores del contract (para grep futuro):
 *   - backend/src/routes/public.js       (GET /api/public/site-config, /google-reviews)
 *   - backend/src/routes/superAdmin.js   (GET+PATCH /api/super-admin/site-config)
 *   - backend/src/schemas/superAdmin.js  (Zod maestro se agrega en M4b)
 *   - frontend/src/screens/Landing.hooks.js (useLandingCMS)
 *   - admin-frontend/src/pages/SitioPublico.jsx
 */

const SYNC_CONTENT_FN = 'site_landing_config_sync_content';
const SYNC_CONTENT_TRIGGER = 'site_landing_config_sync_content_trg';

exports.up = (pgm) => {
  // 1. Agregar la columna content JSONB con default '{}'. NOT NULL para
  //    forzar la invariante desde el arranque (default garantiza que
  //    inserts que no la especifican no violen la constraint).
  pgm.addColumns('site_landing_config', {
    content: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'{}'::jsonb"),
    },
  });

  // 2. Function que arma el JSONB desde las columnas legacy. Se separa de
  //    la trigger para facilitar testing y evolución (Fase 2 el read la
  //    puede llamar directo si necesita re-computar sin escribir).
  //
  //    COALESCE en testimonials/faq porque el default en columna es '[]'::jsonb
  //    pero por defensa contra rows mal seteadas manualmente.
  //    COALESCE(google_reviews_enabled, true) — el default de la columna es
  //    TRUE, pero por si un backfill quedó NULL.
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

  // 3. Trigger BEFORE INSERT/UPDATE. BEFORE (no AFTER) porque necesitamos
  //    modificar NEW.content antes de que se escriba a disco — así no
  //    disparamos una segunda pasada.
  pgm.sql(`
    CREATE TRIGGER ${SYNC_CONTENT_TRIGGER}
    BEFORE INSERT OR UPDATE ON site_landing_config
    FOR EACH ROW
    EXECUTE FUNCTION ${SYNC_CONTENT_FN}();
  `);

  // 4. Backfill de la row singleton (id=1). Un UPDATE no-op (`SET id = id`)
  //    dispara el trigger BEFORE UPDATE → NEW.content queda seteado con
  //    el jsonb_build_object desde las columnas actuales. PG no optimiza
  //    esto out (es un formal write que pasa por la trigger machinery).
  //
  //    Después de este statement, la invariante `content == columnas` está
  //    garantizada para la única row de la tabla. Los tests verifican
  //    exactly eso.
  pgm.sql(`UPDATE site_landing_config SET id = id WHERE id = 1;`);
};

exports.down = (pgm) => {
  // Rollback en orden inverso: trigger → function → column.
  pgm.sql(`DROP TRIGGER IF EXISTS ${SYNC_CONTENT_TRIGGER} ON site_landing_config;`);
  pgm.sql(`DROP FUNCTION IF EXISTS ${SYNC_CONTENT_FN}();`);
  pgm.dropColumns('site_landing_config', ['content']);
};

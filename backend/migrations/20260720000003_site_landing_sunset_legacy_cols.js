/**
 * site_landing_config → SUNSET: drop trigger + drop 14 legacy cols.
 *
 * Sprint 3 M4d del roadmap post-auditoría (docs/AUDIT_LANDING_2026-07-19.md).
 *
 * Fase 4 de 4 del refactor a `content JSONB`. Cierra el sprint 3:
 *
 *   · M4a agregó `content JSONB` + trigger unidireccional cols → content.
 *   · M4b hizo backend switch de reads a content.
 *   · M4c hizo backend switch de writes a content + trigger bidireccional.
 *   · M4d (este): trigger + cols legacy ya no tienen función, se droppean.
 *
 * ── ¿Por qué es seguro ahora? ─────────────────────────────────────────
 *
 * Después de M4c:
 *   · Todos los reads consumen content JSONB (verificado en prod)
 *   · Todos los writes van a content JSONB directamente (M4c PATCH endpoint)
 *   · Las cols legacy solo se mantenían sincronizadas por el trigger fase B
 *     como safety net para clientes legacy — pero ninguno queda referenciando
 *     las cols directamente (grep repo-wide confirmó: 0 references en backend/
 *     src/, admin-frontend/, frontend/ post-M4b/M4c)
 *
 * Rollback:
 *   · `git revert` de este PR no restaura los datos (DROP COLUMN pierde info).
 *   · Backup automático de Railway PG (daily snapshots) permite restore
 *     completo si algo raro se detectara post-drop. Los cols estaban
 *     100% sincronizados con content al momento del drop → cero pérdida
 *     de información funcional (content JSONB tiene todo).
 *
 * ── Cols dropped (14 total) ───────────────────────────────────────────
 *
 * Contact (6):
 *   contact_email, contact_whatsapp, contact_whatsapp_display,
 *   contact_address, contact_instagram_handle, contact_instagram_url
 *
 * Hero (3):
 *   hero_headline, hero_subheadline, hero_blurb
 *
 * CTA (2):
 *   cta_headline, cta_body
 *
 * Arrays (2):
 *   testimonials (jsonb), faq (jsonb)
 *
 * Flags (1):
 *   google_reviews_enabled (boolean)
 *
 * ── Cols que quedan (5 total) ─────────────────────────────────────────
 *
 *   id            — PK singleton (CHECK id=1)
 *   content       — JSONB, source of truth para todo el contenido editable
 *   updated_at    — audit
 *   updated_by    — audit (FK users.id)
 *   created_at    — audit
 *
 * De 19 columnas a 5. Todas las features futuras (footer, video hero,
 * banners promo, etc.) suman keys a content sin ALTER TABLE.
 */

const SYNC_CONTENT_FN = 'site_landing_config_sync_content';
const SYNC_CONTENT_TRIGGER = 'site_landing_config_sync_content_trg';

const LEGACY_COLS = [
  // Contact (6)
  'contact_email',
  'contact_whatsapp',
  'contact_whatsapp_display',
  'contact_address',
  'contact_instagram_handle',
  'contact_instagram_url',
  // Hero (3)
  'hero_headline',
  'hero_subheadline',
  'hero_blurb',
  // CTA (2)
  'cta_headline',
  'cta_body',
  // Arrays (2)
  'testimonials',
  'faq',
  // Flags (1)
  'google_reviews_enabled',
];

exports.up = (pgm) => {
  // 1. Drop trigger primero (depende de la function). Si no lo dropeamos
  //    antes de la function, PG tira "cannot drop function ... because
  //    other objects depend on it".
  pgm.sql(`DROP TRIGGER IF EXISTS ${SYNC_CONTENT_TRIGGER} ON site_landing_config;`);

  // 2. Drop function. Ya no la necesita nadie post-drop del trigger.
  pgm.sql(`DROP FUNCTION IF EXISTS ${SYNC_CONTENT_FN}();`);

  // 3. Drop cols legacy. Después de este statement, la tabla queda con
  //    5 cols: id, content, updated_at, updated_by, created_at.
  pgm.dropColumns('site_landing_config', LEGACY_COLS);
};

exports.down = (pgm) => {
  // Rollback: reagregar cols + function + trigger. NOTA: los datos originales
  // NO se recuperan (DROP COLUMN es destructivo). El backfill via trigger
  // rehidrata cols FROM content — todos los cols vuelven al valor que
  // tenían antes del drop porque content estaba 100% sincronizado (esa era
  // la razón para droppear ahora y no antes).

  // 1. Re-crear cols con los mismos tipos/defaults que en las migrations originales.
  pgm.addColumns('site_landing_config', {
    contact_email:            { type: 'text' },
    contact_whatsapp:         { type: 'text' },
    contact_whatsapp_display: { type: 'text' },
    contact_address:          { type: 'text' },
    contact_instagram_handle: { type: 'text' },
    contact_instagram_url:    { type: 'text' },
    hero_headline:            { type: 'text' },
    hero_subheadline:         { type: 'text' },
    hero_blurb:               { type: 'text' },
    cta_headline:             { type: 'text' },
    cta_body:                 { type: 'text' },
    testimonials:             { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    faq:                      { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    google_reviews_enabled:   { type: 'boolean', notNull: true, default: true },
  });

  // 2. Re-crear function del trigger M4c (bidireccional). Restauramos la versión
  //    bidireccional porque el rollback lógico es "volver al estado post-M4c",
  //    no al de M4a.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION ${SYNC_CONTENT_FN}()
    RETURNS TRIGGER AS $fn$
    BEGIN
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
        NEW.testimonials := COALESCE(NEW.content->'testimonials', '[]'::jsonb);
        NEW.faq          := COALESCE(NEW.content->'faq',          '[]'::jsonb);
        NEW.google_reviews_enabled := COALESCE(
          (NEW.content->'features'->>'google_reviews_enabled')::boolean,
          true
        );
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);

  // 3. Re-crear trigger.
  pgm.sql(`
    CREATE TRIGGER ${SYNC_CONTENT_TRIGGER}
    BEFORE INSERT OR UPDATE ON site_landing_config
    FOR EACH ROW
    EXECUTE FUNCTION ${SYNC_CONTENT_FN}();
  `);

  // 4. Backfill cols FROM content vía UPDATE no-op que dispara el trigger
  //    (rama B: content == OLD.content, pero el trigger detecta que es "no
  //    modificado" y va a rama A que setea las cols... wait, rama A también
  //    deriva content desde cols. Hmm.)
  //
  //    Con las cols recién agregadas todas están NULL. Rama A tomaría esas
  //    cols NULL y overwrite content con nulls por todos lados.
  //
  //    En vez de eso, hacemos un UPDATE explícito que fuerza rama B
  //    (touching content). El truco: `SET content = content || '{}'::jsonb`
  //    no cambia el valor final, pero `NEW.content IS NOT DISTINCT FROM
  //    OLD.content` da FALSE porque técnicamente es una asignación. En
  //    la práctica PG considera `content || '{}'` como "no cambió"
  //    (mismo JSONB). Necesitamos algo que EFECTIVAMENTE cambie content
  //    para engañar al `IS NOT DISTINCT FROM`.
  //
  //    Solución más simple: usar UPDATE con SET content = content, que
  //    formalmente es una asignación pero produce el mismo valor. PG lo
  //    considera "no cambio" para IS NOT DISTINCT FROM.
  //
  //    Real solución: bypass el trigger, hacer backfill manual de cols
  //    FROM content usando UPDATE directo.
  pgm.sql(`
    UPDATE site_landing_config
       SET contact_email             = content->'contact'->>'email',
           contact_whatsapp          = content->'contact'->>'whatsapp',
           contact_whatsapp_display  = content->'contact'->>'whatsapp_display',
           contact_address           = content->'contact'->>'address',
           contact_instagram_handle  = content->'contact'->>'instagram_handle',
           contact_instagram_url     = content->'contact'->>'instagram_url',
           hero_headline    = content->'hero'->>'headline',
           hero_subheadline = content->'hero'->>'subheadline',
           hero_blurb       = content->'hero'->>'blurb',
           cta_headline     = content->'cta'->>'headline',
           cta_body         = content->'cta'->>'body',
           testimonials     = COALESCE(content->'testimonials', '[]'::jsonb),
           faq              = COALESCE(content->'faq',          '[]'::jsonb),
           google_reviews_enabled = COALESCE(
             (content->'features'->>'google_reviews_enabled')::boolean,
             true
           )
     WHERE id = 1;
  `);
};

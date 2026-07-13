/**
 * Tabla `site_landing_config` — CMS mínimo para el sitio público
 * https://www.tecnyapp.com.
 *
 * 2026-07-13 (feature Fase 1: Contacto):
 *
 * Contexto: la landing pública (iPro-Website/App.tsx) tiene TODO el contenido
 * hardcoded — dirección, mail, WhatsApp, Instagram. Peor: los valores siguen
 * siendo de la marca vieja (`@ipro.arg`, `iprocomexsoluciones@gmail.com`) tras
 * el rebrand a Tecny. Cambiar cualquier dato hoy requiere fork + commit +
 * redeploy Netlify (fricción brutal para un ajuste de teléfono).
 *
 * Fix: tabla singleton (1 sola row, id fijo=1) con la config editable desde
 * el admin del portal. La landing hace GET al endpoint público al cargar
 * y hydra los valores. Cache 5min (HTTP + react-query) para no martillar
 * Railway con cada visita anónima.
 *
 * Fase 1 (este PR) — solo campos de Contacto:
 *   · contact_email, contact_whatsapp, contact_whatsapp_display, contact_address,
 *     contact_instagram_handle, contact_instagram_url.
 *
 * Fases futuras (agregar columnas cuando se implementen):
 *   · Fase 2: client_testimonials JSONB (array reseñas)
 *   · Fase 3: footer_data JSONB (Empresa, Legal, Redes)
 *
 * Diseño singleton:
 *   · id fijo=1 vía CHECK. Un INSERT con id=2 falla.
 *   · Row semilla al aplicar migration (con los valores nuevos de Tecny —
 *     Lucas los edita post-deploy desde el admin).
 *   · Sin `deleted_at`: no tiene sentido "borrar" la config; se edita.
 *
 * Sin RLS: es config global de Tecny, no per-tenant.
 * `updated_by` FK opcional a users (super-admin que hizo el último cambio).
 */

exports.up = (pgm) => {
  pgm.createTable('site_landing_config', {
    id: {
      type: 'integer',
      primaryKey: true,
      // Fuerza singleton (1 sola row) con CHECK id=1. Cualquier INSERT
      // con id distinto es rechazado por PG.
      check: 'id = 1',
      default: 1,
    },
    // ── Contacto (Fase 1) ─────────────────────────────────────────────────
    contact_email: {
      type: 'text',
      notNull: false, // permite quedar vacío si Lucas todavía no lo cargó
    },
    contact_whatsapp: {
      type: 'text',
      notNull: false,
      // Número en formato E.164 crudo (ej. "5491126165007") para el link wa.me/*
    },
    contact_whatsapp_display: {
      type: 'text',
      notNull: false,
      // Formato visible al usuario (ej. "+54 9 11 2616-5007")
    },
    contact_address: {
      type: 'text',
      notNull: false,
    },
    contact_instagram_handle: {
      type: 'text',
      notNull: false,
      // Handle sin @ (ej. "tecny.app")
    },
    contact_instagram_url: {
      type: 'text',
      notNull: false,
      // URL completa del perfil
    },
    // ── Meta ──────────────────────────────────────────────────────────────
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    updated_by: {
      type: 'integer',
      notNull: false,
      references: 'users(id)',
      onDelete: 'SET NULL',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Insertar la row singleton con valores default. Lucas los edita desde
  // el admin post-deploy. Valores placeholder para no shippear datos vacíos
  // (la landing muestra fallback hardcoded si vienen NULL, pero es mejor
  // tener algo válido de arranque).
  pgm.sql(`
    INSERT INTO site_landing_config (
      id, contact_email, contact_whatsapp, contact_whatsapp_display,
      contact_address, contact_instagram_handle, contact_instagram_url
    ) VALUES (
      1,
      'hola@tecnyapp.com',
      '5491126165007',
      '+54 9 11 2616-5007',
      'Buenos Aires, Argentina',
      'tecny.app',
      'https://instagram.com/tecny.app'
    );
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('site_landing_config');
};

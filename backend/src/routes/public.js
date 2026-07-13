/**
 * Routes públicas — accesibles SIN autenticación.
 *
 * Usado por:
 *   - Landing (tecnyapp.com) → fetch de `/api/public/pricing` para
 *     mostrar precios actualizados sin redeploy.
 *
 * Diseño:
 *   - NO requireAuth, NO requireSuperAdmin, NO tenant scope.
 *   - Lee del cache de planPricing (NO de DB directo) — el endpoint es
 *     hot path de la landing, queremos latency mínima. El cache se
 *     refresca cada 5min de todas formas.
 *   - Cache HTTP cabezera: 60s (Cache-Control). La landing puede tolerar
 *     drift de 1 min entre que Lucas cambia el precio y la landing lo
 *     refleja al usuario que la visita. Reduce hits al backend desde el
 *     CDN/usuario.
 *   - CORS abierto (*) — la landing puede estar en distintos orígenes
 *     (tecnyapp.com, staging-, local). El router CORS principal del app
 *     ya valida orígenes; este endpoint específico podría ir más laxo
 *     pero por ahora lo dejamos consistente.
 *
 * Por qué un router separado vs colgarlo de auth.js:
 *   Semántica: este namespace es para endpoints DELIBERADAMENTE públicos
 *   (no requieren login, no tienen tenant scope). Dejarlo claro evita
 *   que un dev futuro agregue accidentalmente algo sensible acá.
 */

const router = require('express').Router();
const { getPlanPrices } = require('../lib/planPricing');
const db = require('../config/database');
const logger = require('../lib/logger');

// ──────────────────────────────────────────────────────────────────────────
// GET /api/public/pricing — precios actuales de los planes (C.1.2 #353).
//
// Devuelve los precios USD/mes de los planes vigentes. La landing los
// renderiza en las cards. Si el cache aún no está primado (raro: solo en
// los primeros ~50ms del boot del backend), devuelve DEFAULT_PRICES.
//
// Estructura:
//   {
//     prices: { trial, starter, pro, enterprise },
//     currency: 'USD',
//     period: 'monthly'
//   }
//
// `currency`/`period` son metadata explícita — la landing los usa para
// renderizar "USD 39/mes" sin asumir constantes. Si en el futuro
// agregamos USD anual o ARS, este shape se extiende sin breaking change.
// ──────────────────────────────────────────────────────────────────────────
router.get('/pricing', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    prices: getPlanPrices(),
    currency: 'USD',
    period: 'monthly',
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/public/site-config — CMS Landing Fase 1: sección Contacto
//
// 2026-07-13 (feature): la landing tecnyapp.com consume este endpoint al
// cargar y renderiza email + WhatsApp + dirección + Instagram dinámicamente.
// Antes estaban HARDCODED en App.tsx con datos de la marca vieja
// (@ipro.arg, gmail.com). Ahora Lucas los edita desde el admin y aparecen
// en la landing en <5min.
//
// Cache:
//   · HTTP Cache-Control: 300s (5min). Landing hace fetch al mount,
//     react-query cachea client-side. Cada usuario anónimo hace máximo
//     1 hit / 5min → cero riesgo de saturar Railway.
//   · Si Lucas cambia algo y quiere ver YA, hard-refresh en el browser
//     invalida el cache client-side.
//
// Fallback:
//   · Si la tabla no está seedeada (migration no corrida en dev), devuelve
//     los defaults. La landing tiene fallback propio a hardcode si el
//     fetch entero falla.
//
// Fases futuras:
//   · Fase 2 (reseñas) → extiende el response con `testimonials: [...]`.
//   · Fase 3 (footer) → extiende con `footer: { empresa, legal, socials }`.
//   · El shape es aditivo (nuevos campos, no breakingly change los actuales)
//     para que la landing v-actual siga funcionando sin update forzado.
// ──────────────────────────────────────────────────────────────────────────
router.get('/site-config', async (_req, res) => {
  try {
    // db.adminQuery bypasea RLS (site_landing_config no es tenant-scoped,
    // pero usamos el pattern para queries admin-nivel).
    const row = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT contact_email, contact_whatsapp, contact_whatsapp_display,
                contact_address, contact_instagram_handle, contact_instagram_url,
                updated_at
           FROM site_landing_config WHERE id = 1`
      );
      return rows[0] || null;
    });

    res.set('Cache-Control', 'public, max-age=300');
    // Envelope explícito para permitir extensión futura sin breaking change.
    res.json({
      contact: {
        email:              row?.contact_email             || null,
        whatsapp:           row?.contact_whatsapp          || null,
        whatsapp_display:   row?.contact_whatsapp_display  || null,
        address:            row?.contact_address           || null,
        instagram_handle:   row?.contact_instagram_handle  || null,
        instagram_url:      row?.contact_instagram_url     || null,
      },
      // Placeholder para fases futuras — la landing puede acceder de forma
      // segura con optional chaining.
      testimonials: [],
      footer: null,
      updated_at: row?.updated_at || null,
    });
  } catch (err) {
    logger.error({ err: err.message }, '[public/site-config] fallo, devolviendo defaults');
    // Fail-open: si la DB explota, devolvemos shape vacío para que la
    // landing use su fallback hardcoded en vez de romper el render.
    res.status(200).json({
      contact: {
        email: null, whatsapp: null, whatsapp_display: null,
        address: null, instagram_handle: null, instagram_url: null,
      },
      testimonials: [],
      footer: null,
      updated_at: null,
    });
  }
});

module.exports = router;

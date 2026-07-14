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
const googleReviews = require('../lib/googleReviews');
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
                testimonials,
                hero_headline, hero_subheadline, hero_blurb,
                cta_headline, cta_body, faq,
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
      // 2026-07-13 Fase 2: reseñas editables desde el admin. Array vacío
      // significa "usá los hardcodeados de la landing" — el hook use-site-config
      // ya tiene ese fallback.
      testimonials: Array.isArray(row?.testimonials) ? row.testimonials : [],
      // 2026-07-13 Fase 3: Hero + CTA + FAQ editables. Null en cualquier campo
      // texto significa "landing usa hardcoded fallback"; FAQ vacío ídem.
      hero: {
        headline:    row?.hero_headline    || null,
        subheadline: row?.hero_subheadline || null,
        blurb:       row?.hero_blurb       || null,
      },
      cta: {
        headline: row?.cta_headline || null,
        body:     row?.cta_body     || null,
      },
      faq: Array.isArray(row?.faq) ? row.faq : [],
      // Placeholder Fase futura (footer, si Lucas decide hacerlo editable).
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
      testimonials: [], // fail-open: landing usa fallback hardcodeado
      footer: null,
      updated_at: null,
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/public/google-reviews — reseñas reales del Google Business Profile
//
// 2026-07-13 (feature): la landing tecnyapp.com muestra reseñas reales del
// listing de Google ("Tecny App", place_id ChIJt32vtDn5sCoRmCjEY6g98SU)
// además de las reseñas manuales de la CMS Fase 2. Objetivo: social proof
// orgánico + validación externa.
//
// Cache:
//   · Server-side: 6hs (in-memory, en src/lib/googleReviews.js). Refrescamos
//     4x/día → 120 llamadas/mes → ~USD 3/mes, dentro del free tier de $200
//     de Maps Platform. Zero cargo real.
//   · HTTP Cache-Control: 3600s (1h). React-query en la landing lo cachea
//     client-side; el server cache (6h) es más largo que el HTTP porque el
//     CDN puede tener múltiples usuarios pero un solo backend.
//
// Fallback:
//   · Si Google API falla, la lib devuelve `{ reviews: [] }` con `error`.
//     Este endpoint responde 200 igual (fail-open). La landing tiene
//     fallback a las manuales de la CMS Fase 2 → hardcoded en App.tsx.
//
// Config:
//   · GOOGLE_PLACES_API_KEY y GOOGLE_PLACES_PLACE_ID en Railway. Si faltan,
//     el endpoint devuelve `{ reviews: [], configured: false }` — la
//     landing sigue funcionando con solo las manuales.
//
// Threshold "mostrar/no mostrar" NO vive acá — es decisión del frontend.
// Este endpoint es un data source puro: expone lo que Google devuelve +
// metadata (rating agregado, count). La landing decide con su threshold.
// ──────────────────────────────────────────────────────────────────────────
router.get('/google-reviews', async (_req, res) => {
  try {
    // 2026-07-13 toggle admin: lee `google_reviews_enabled` de la row singleton.
    // Si false, no llamamos a Google — devolvemos empty. Ahorra API quota y da
    // control al admin sin redeploy. Ver migration 20260713400000 + admin card.
    //
    // Query es barata (single-row lookup + DB tiene todo caliente), y con el
    // HTTP cache de 1h abajo, en la práctica el endpoint recibe max 1 hit por
    // usuario por hora — lag DB no importa.
    let enabled = true; // fail-open default (feature ON si DB inaccesible)
    try {
      const row = await db.adminQuery(async (client) => {
        const { rows } = await client.query(
          `SELECT google_reviews_enabled FROM site_landing_config WHERE id = 1`
        );
        return rows[0];
      });
      enabled = row?.google_reviews_enabled !== false;
    } catch (e) {
      // Query falló (DB down / migration pendiente) — asumimos enabled=true
      // por default. Es fail-open: mejor mostrar reseñas que ocultarlas por
      // un blip transitorio de infra.
      logger.warn({ err: e.message }, '[public/google-reviews] flag lookup falló — asumiendo enabled=true');
    }

    // HTTP Cache 1h. El server cache interno es 6h, pero limitamos el HTTP
    // a 1h por conservadurismo: si la próxima reseña llegara y el server
    // cache la trae en <6h, el HTTP cache de intermediarios no la retiene
    // más de 1h. Un poco de latencia de propagación (1h) es aceptable en
    // exchange por reducir carga contra este proceso.
    //
    // Ojo: si el toggle está OFF, seguimos usando el mismo TTL — un cambio
    // del flag tarda hasta 1h en verse en la landing. Aceptable para un
    // toggle que se usa poco. Si Lucas necesita ver YA, hard-refresh.
    res.set('Cache-Control', 'public, max-age=3600');

    if (!enabled) {
      // Toggle OFF → no llamamos a Google, devolvemos estructura vacía con
      // `disabled: true` para diagnóstico. La landing lo trata como "sin
      // reseñas" y usa el fallback manual.
      return res.json({
        reviews: [], rating: null, count: 0, source: 'google',
        configured: true, disabled: true,
        cachedAt: new Date().toISOString(),
      });
    }

    const data = await googleReviews.getReviews();
    res.json(data);
  } catch (err) {
    // getReviews() no debería throw (fail-open interno), pero por si acaso
    // — nunca dejamos que un error de Google rompa la landing.
    logger.error({ err: err.message }, '[public/google-reviews] fallo inesperado, devolviendo vacío');
    res.status(200).json({
      reviews: [], rating: null, count: 0, source: 'google',
      configured: false, error: 'unexpected_error',
    });
  }
});

module.exports = router;

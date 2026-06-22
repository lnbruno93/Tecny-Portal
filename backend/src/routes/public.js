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

module.exports = router;

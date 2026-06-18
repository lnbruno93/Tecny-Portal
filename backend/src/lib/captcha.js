// hCaptcha verification para el endpoint público /api/auth/signup.
//
// Diseño:
//   - Single function `verifyCaptcha(token, remoteIp)` que POSTea a
//     `https://api.hcaptcha.com/siteverify` con form-urlencoded body
//     (per docs hCaptcha).
//   - Env vars:
//       HCAPTCHA_ENABLED     — 'true' para activar la verificación.
//                              Cualquier otro valor (incluyendo undefined)
//                              → bypass (devuelve success). Gate operacional
//                              sin redeploy si hCaptcha tiene outage o si
//                              queremos desactivar temporalmente.
//       HCAPTCHA_SECRET      — secret key de la cuenta hCaptcha.
//       HCAPTCHA_VERIFY_URL  — opcional. Default api.hcaptcha.com siteverify.
//                              Override para testing con mock server.
//       HCAPTCHA_FORCE_IN_TESTS — '1' fuerza la verificación incluso en
//                              NODE_ENV=test. Default: tests bypass para no
//                              depender de red externa.
//
//   - Si HCAPTCHA_ENABLED=true pero falta HCAPTCHA_SECRET, fail-closed
//     (error en logs + verifyCaptcha devuelve `{ success: false, error:
//     'config_error' }`). Esto evita que un misconfig silencioso deje el
//     signup totalmente abierto.
//
//   - Network timeout 5s — si hCaptcha no responde, fail-closed con
//     `{ success: false, error: 'network_error' }` y log Sentry. Trade-off:
//     un outage de hCaptcha bloquea signups, pero la alternativa (bypass
//     silencioso) abre el endpoint a bots. Si necesitás bypass durante
//     outage, seteás HCAPTCHA_ENABLED=false momentáneamente.
//
// Response shape:
//   { success: true }            ← verificación OK o bypass
//   { success: false, error }    ← bot/replay/expired/network/config
//   `error` ∈ { 'invalid_token', 'expired', 'duplicate',
//               'network_error', 'config_error', 'http_error' }

const logger = require('./logger');

const DEFAULT_VERIFY_URL = 'https://api.hcaptcha.com/siteverify';
const NETWORK_TIMEOUT_MS = 5_000;

function isEnabled() {
  return process.env.HCAPTCHA_ENABLED === 'true';
}

function shouldBypassInTests() {
  return process.env.NODE_ENV === 'test'
    && process.env.HCAPTCHA_FORCE_IN_TESTS !== '1';
}

// Mapea error codes de hCaptcha a categorías que el caller (signup route)
// puede usar para mensajes a UI. La lista completa:
//   https://docs.hcaptcha.com/#siteverify-error-codes
function categorizeErrors(codes) {
  if (!Array.isArray(codes) || codes.length === 0) return 'invalid_token';
  if (codes.includes('expired-input-response')) return 'expired';
  if (codes.includes('already-seen-response')) return 'duplicate';
  return 'invalid_token';
}

/**
 * Verifica un response token de hCaptcha.
 *
 * @param {string} token        — el response token del widget cliente.
 * @param {string} [remoteIp]   — opcional pero recomendado para scoring.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function verifyCaptcha(token, remoteIp) {
  if (shouldBypassInTests()) return { success: true, bypassed: true };
  if (!isEnabled()) return { success: true, bypassed: true };

  const secret = process.env.HCAPTCHA_SECRET;
  if (!secret) {
    logger.error('verifyCaptcha: HCAPTCHA_ENABLED=true pero HCAPTCHA_SECRET no está configurada — fail-closed');
    return { success: false, error: 'config_error' };
  }

  if (typeof token !== 'string' || token.length === 0) {
    return { success: false, error: 'invalid_token' };
  }

  const url = process.env.HCAPTCHA_VERIFY_URL || DEFAULT_VERIFY_URL;
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.append('remoteip', remoteIp);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'verifyCaptcha: network error al llamar siteverify — fail-closed');
    return { success: false, error: 'network_error' };
  } finally {
    clearTimeout(t);
  }

  if (!response.ok) {
    logger.warn({ status: response.status }, 'verifyCaptcha: HTTP no-2xx de siteverify — fail-closed');
    return { success: false, error: 'http_error' };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    logger.warn({ err: err.message }, 'verifyCaptcha: response no es JSON válido');
    return { success: false, error: 'http_error' };
  }

  if (data.success === true) return { success: true };

  const category = categorizeErrors(data['error-codes']);
  // No loggeamos los error-codes detallados como warn — son data del cliente,
  // ruido en prod. Solo si es category 'config_error' (raro).
  logger.debug({ codes: data['error-codes'], category }, 'verifyCaptcha: rechazado');
  return { success: false, error: category };
}

module.exports = { verifyCaptcha };

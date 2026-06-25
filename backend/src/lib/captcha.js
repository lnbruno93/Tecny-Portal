// hCaptcha verification para el endpoint público /api/auth/signup.
//
// Diseño:
//   - Single function `verifyCaptcha(token, remoteIp)` que POSTea a
//     `https://api.hcaptcha.com/siteverify` con form-urlencoded body
//     (per docs hCaptcha).
//   - Env vars:
//       HCAPTCHA_ENABLED     — 'true' para activar la verificación.
//                              En NODE_ENV='production' (Railway staging+prod),
//                              cualquier otro valor → fail-closed (SEG-4).
//                              En NODE_ENV='development' → bypass para que el
//                              dev local no necesite secret. En tests bypassa
//                              salvo HCAPTCHA_FORCE_IN_TESTS=1.
//       HCAPTCHA_SECRET      — secret key de la cuenta hCaptcha. Required en
//                              prod (sin él, isEnabled+config_error fail-closed).
//       HCAPTCHA_VERIFY_URL  — opcional. Default api.hcaptcha.com siteverify.
//                              Override para testing con mock server.
//       HCAPTCHA_FORCE_IN_TESTS — '1' fuerza la verificación incluso en
//                              NODE_ENV=test. Default: tests bypass para no
//                              depender de red externa.
//
//   - SEG-4 (auditoría pre-live 2026-06): antes el módulo bypassaba
//     silenciosamente si HCAPTCHA_ENABLED no estaba 'true'. En prod
//     significaba que un misconfig (env var sin setear) dejaba el signup
//     totalmente abierto a bots, sin warning ni 4xx. Ahora en
//     NODE_ENV='production', si HCAPTCHA_ENABLED!='true' devolvemos
//     `{ success: false, error: 'config_error' }` (fail-closed). El
//     operador tiene que setear explícitamente HCAPTCHA_ENABLED='true'
//     en Railway. Para desactivar momentáneamente durante un outage,
//     existe HCAPTCHA_OUTAGE_BYPASS='true' como kill-switch deliberado
//     (loggeado warn en cada uso, para que no se quede activo por olvido).
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
//     outage, seteás HCAPTCHA_OUTAGE_BYPASS='true' momentáneamente.
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

function isProductionEnv() {
  return process.env.NODE_ENV === 'production';
}

// SEG-4: kill-switch deliberado para emergencias (outage hCaptcha). Loggeado
// warn en cada uso para que no quede activo por olvido. NO confundir con
// HCAPTCHA_ENABLED — éste es para emergencias temporales, aquél es config
// normal.
function isOutageBypassActive() {
  return process.env.HCAPTCHA_OUTAGE_BYPASS === 'true';
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

  // SEG-4 kill-switch: bypass deliberado durante outage hCaptcha. Loggeado
  // warn en cada uso (operator tiene que verlo en Railway logs y removerlo
  // cuando termine el incident).
  if (isOutageBypassActive()) {
    logger.warn('verifyCaptcha: HCAPTCHA_OUTAGE_BYPASS=true activo — bypass por outage. NO dejar activo permanentemente.');
    return { success: true, bypassed: true, reason: 'outage_bypass' };
  }

  if (!isEnabled()) {
    // SEG-4 (auditoría pre-live): en prod, no estar enabled es un misconfig.
    // Fail-closed defensivo en vez del bypass silencioso anterior. En dev
    // local sigue bypassing para no requerir secret.
    if (isProductionEnv()) {
      logger.error('verifyCaptcha: HCAPTCHA_ENABLED!=true en NODE_ENV=production — fail-closed. Configurar HCAPTCHA_ENABLED=true en Railway o usar HCAPTCHA_OUTAGE_BYPASS=true para outage temporal.');
      return { success: false, error: 'config_error' };
    }
    return { success: true, bypassed: true, reason: 'dev_bypass' };
  }

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

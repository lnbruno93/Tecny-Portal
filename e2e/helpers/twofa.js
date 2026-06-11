// Helpers de 2FA para tests E2E.
//
// Diseño:
//   - Activamos/desactivamos 2FA por test vía la API REST del backend, no
//     manipulando DB directo. Eso ejercita el endpoint real (setup → enable →
//     disable) y evita acoplar el helper al schema (si cambia user_2fa, los
//     endpoints siguen estables).
//   - `enable2faForUser` hace todo el flow: login normal → /setup (devuelve
//     secret) → genera TOTP con speakeasy → /enable. Devuelve { secret } así
//     el test puede generar más códigos cuando necesite.
//   - `disable2faForUser` simétrico — limpia para el siguiente test.
//   - `generateTotp(secret)` wrapper de speakeasy para que el spec no tenga
//     que conocer las opciones TOTP (encoding/step/digits).
//
// Anti-replay (decisión durable):
//   El backend persiste `last_used_step` para impedir reusar el MISMO TOTP en
//   la misma ventana de 30s. La estrategia que elegimos para no chocar entre
//   tests es DESACTIVAR el 2FA en `afterAll`/`afterEach` y RE-ACTIVAR en el
//   siguiente test. `disable2faForUser` ejecuta `DELETE FROM user_2fa WHERE
//   user_id = $1` (vía POST /api/auth/2fa/disable, que internamente borra el
//   row), así el próximo `enable2faForUser` genera un secret NUEVO y arranca
//   con `last_used_step = 0` — no hay forma de colisión.
//
//   Alternativas descartadas:
//     · `waitForTimeout(30_000)` entre tests — agrega 30s por test 2FA, lento.
//     · Pasar `step` distinto a speakeasy — frágil, el backend sigue mirando
//       el tiempo actual del server al verificar, no el step que pasamos.

const speakeasy = require('speakeasy');

const DEFAULT_API_URL = 'http://localhost:3001';

// Opciones TOTP — deben coincidir EXACTAMENTE con backend/src/lib/twoFa.js
// (step=30, digits=6, encoding base32). Si el backend cambia los params,
// los códigos generados acá ya no van a verificar.
const TOTP_OPTS = { encoding: 'base32', step: 30, digits: 6 };

// Login por API (no UI). Devuelve { token, user }.
async function apiLogin({ username, password, code, apiUrl = DEFAULT_API_URL }) {
  const body = { username, password };
  if (code) body.code = code;
  const res = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `login failed (${res.status})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Llamada autenticada al backend con JWT en Authorization.
async function apiCall({ token, method, path, body, apiUrl = DEFAULT_API_URL }) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * Activa 2FA al usuario via API REST.
 *   1. Login normal (sin 2FA) → JWT.
 *   2. POST /api/auth/2fa/setup → { secret, otpauth_uri, recovery_codes }.
 *   3. Generar TOTP del secret y POST /api/auth/2fa/enable.
 *
 * Devuelve { secret, recovery_codes } para que el test pueda generar TOTPs
 * adicionales o usar un recovery code si quiere.
 *
 * Idempotencia: si el user ya tiene 2FA activo, /setup devuelve 409. En ese
 * caso lanzamos error explícito para que el test sepa que debe disable primero.
 */
async function enable2faForUser(username, password, { apiUrl = DEFAULT_API_URL } = {}) {
  const { token } = await apiLogin({ username, password, apiUrl });

  const setup = await apiCall({
    token, method: 'POST', path: '/api/auth/2fa/setup', apiUrl,
  });
  // setup devuelve { secret, otpauth_uri, recovery_codes }.
  // El secret está en base32 (mismo encoding que TOTP_OPTS).
  const { secret, recovery_codes } = setup;

  const code = generateTotp(secret);
  await apiCall({
    token, method: 'POST', path: '/api/auth/2fa/enable', body: { code }, apiUrl,
  });

  return { secret, recovery_codes };
}

/**
 * Desactiva 2FA. Hace login con TOTP correcto y llama /disable (que internamente
 * borra el row de user_2fa, dejando al user en estado "sin 2FA configurado").
 *
 * Requiere el secret actual del user — el caller suele tenerlo guardado del
 * `enable2faForUser` previo.
 *
 * Best-effort: si el user no tiene 2FA activo (por ejemplo el test anterior ya
 * lo desactivó), absorbemos el error 400 silenciosamente. Esto hace que el
 * helper sea seguro de llamar en `afterAll` sin chequeos previos.
 */
async function disable2faForUser(username, password, secret, { apiUrl = DEFAULT_API_URL } = {}) {
  // Necesitamos un TOTP válido para autenticar /disable. Generamos uno fresco.
  const code = generateTotp(secret);
  let token;
  try {
    const r = await apiLogin({ username, password, code, apiUrl });
    token = r.token;
  } catch (err) {
    // Si el login con TOTP falla porque 2FA NO está activo (caso "ya desactivado"),
    // el backend responde 200 con la pareja sin pedir code — entonces apiLogin
    // sin code basta. Reintento sin code.
    if (err.status === 401 && err.body && err.body.twofa_required === undefined) {
      // password incorrecta o algo más serio — propagar.
      throw err;
    }
    // Reintento sin code (asumiendo 2FA ya no está activo).
    try {
      const r2 = await apiLogin({ username, password, apiUrl });
      return r2; // no hay nada que disable, salimos.
    } catch (err2) {
      throw err2;
    }
  }

  try {
    await apiCall({
      token, method: 'POST', path: '/api/auth/2fa/disable', body: { code }, apiUrl,
    });
  } catch (err) {
    // 400 "2FA no está activado" — el row ya no existe, idempotente OK.
    if (err.status === 400) return;
    throw err;
  }
}

/**
 * Wrapper de speakeasy.totp para uso en specs. Devuelve el código de 6 dígitos
 * actual para el secret dado.
 *
 * El backend tolera ±1 step (90s ventana total) — el código generado acá va
 * a verificar mientras no tarden más de 30s en llegarle.
 */
function generateTotp(secret) {
  return speakeasy.totp({ secret, ...TOTP_OPTS });
}

module.exports = {
  enable2faForUser,
  disable2faForUser,
  generateTotp,
};

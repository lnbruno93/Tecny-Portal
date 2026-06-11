// Helpers de 2FA para tests E2E.
//
// Diseño:
//   - `enable2faForUser` hace el flow vía API REST (login normal → /setup →
//     /enable con TOTP). Eso ejercita los endpoints reales del backend.
//   - `disable2faForUser` hace DELETE directo en DB. La razón es anti-replay:
//     ver bloque abajo.
//   - `generateTotp(secret)` wrapper de speakeasy para que el spec no tenga
//     que conocer las opciones TOTP (encoding/step/digits).
//
// Anti-replay (decisión durable):
//   El backend persiste `last_used_step` para impedir reusar el MISMO TOTP en
//   la misma ventana de 30s. Esto rompía el patrón "test consume TOTP → afterAll
//   intenta disable con TOTP" porque ambos códigos caen en el mismo step y el
//   segundo es rechazado como replay.
//
//   Solución elegida: `disable2faForUser` hace `DELETE FROM user_2fa WHERE
//   user_id = (subquery)` directamente — bypassea el endpoint /disable y por
//   ende el verifyAndConsume. Eso es seguro porque:
//     1. El helper es para tests E2E: no es código de producción.
//     2. Nadie le pasa input no confiable (el caller es el spec).
//     3. La activación SÍ pasa por la API (ejercitamos /setup + /enable).
//   El próximo `enable2faForUser` genera secret nuevo y arranca con
//   `last_used_step = 0`.
//
//   Alternativas descartadas:
//     · `waitForTimeout(30_000)` entre tests — agrega 30s por test 2FA, lento.
//     · Pasar `step` distinto a speakeasy — frágil, el backend mira el tiempo
//       actual del server al verificar, no el step que pasamos.
//     · Usar recovery code para el disable — funciona, pero acopla el helper
//       a 8 ejecuciones máximo y agrega más latencia (bcrypt por code).

const speakeasy = require('speakeasy');
const { Pool } = require('pg');

const DEFAULT_API_URL = 'http://localhost:3001';

// Pool lazy — solo se crea si alguien llama `disable2faForUser`. Cerrarlo en
// el afterAll del spec sería overkill; el proceso de tests termina y libera.
let _pool;
function getPool() {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

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
 * Desactiva 2FA borrando directamente el row de `user_2fa` en la DB.
 *
 * No usamos POST /api/auth/2fa/disable porque para llamarlo necesitaríamos un
 * JWT, y para obtenerlo tendríamos que hacer login con TOTP — pero el test
 * recién consumió ese step, así que el siguiente TOTP cae en la misma ventana
 * y el backend lo rechaza por anti-replay (ver bloque "Anti-replay" arriba).
 *
 * El acceso directo a DB es seguro acá porque:
 *   - Es código de tests, no producción.
 *   - El identificador es el username del seed (`testadmin`), no input externo.
 *   - La DB es la dedicada `ipro_e2e` (chequeado en globalSetup).
 *
 * Idempotente: si el row no existe, el DELETE devuelve rowCount=0 sin error.
 *
 * El parámetro `secret` se conserva en la firma por simetría con
 * `enable2faForUser`, pero ya no se usa (no hacemos verify). Lo dejamos para
 * que un futuro cambio que vuelva a usar /disable no rompa los callsites.
 */
// eslint-disable-next-line no-unused-vars
async function disable2faForUser(username, password, secret) {
  await getPool().query(
    'DELETE FROM user_2fa WHERE user_id = (SELECT id FROM users WHERE username = $1)',
    [username],
  );
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

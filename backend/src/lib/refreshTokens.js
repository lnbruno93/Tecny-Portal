'use strict';

// refreshTokens.js — helper para issue/rotate/revoke de refresh tokens.
//
// Diseño (Task #190, 2026-07-21):
//   Access token JWT (localStorage, 15min TTL) + refresh token httpOnly
//   cookie (30d TTL). Frontend hace refresh silencioso ante 401 vía POST
//   /api/auth/refresh — el user no ve el flow.
//
// Seguridad:
//   - Token plaintext solo existe en memoria durante la request. La DB
//     guarda SOLO SHA-256(token). Si la DB se compromete, los tokens no
//     son reusables (necesitás el plaintext, que no está).
//   - Rotación en cada refresh: cada uso emite NUEVO refresh y revoca el
//     viejo. Attack detection: si alguien intenta reusar un refresh ya
//     rotado, sabemos que hubo robo → revocamos toda la cadena de refresh
//     de ese user (invalida cualquier sesión activa suya).
//   - httpOnly cookie: inmune a XSS. Un atacante que compromete JS del
//     bundle solo obtiene el access token (15min de ventana).
//   - `revoked_at` para no-borrado: mantiene historial forense (chain de
//     rotación, IP/UA de cada uso). Purge job mensual limpia expirados.
//
// Contrato:
//   - Los tokens son 32 bytes de randomness → 64 chars hex. Espacio:
//     2^256, imposible de brute-force incluso con GPUs.
//   - TTL 30 días balance conveniencia vs riesgo: si el device del user
//     se pierde, en 30 días max se cierra la sesión sola. El user puede
//     revocar antes con logout explícito (revoca TODOS sus tokens).
//   - `expires_at` en DB es el ceiling. Post-refresh reset a NOW() + TTL.

const { randomBytes, createHash } = require('node:crypto');
const db = require('../config/database');
const logger = require('./logger');

// TTL default. Env var permite override para testing local con vida corta.
const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_MS) || 30 * 24 * 60 * 60 * 1000; // 30 días
const REFRESH_TOKEN_BYTES = 32; // → 64 chars hex

// Nombre canonical del cookie. Frontends usan `credentials: 'include'` en
// fetch y el navegador maneja el envío automático — no toca este nombre.
const COOKIE_NAME = 'tecny_refresh';

// Helper para hash SHA-256 del token. Rápido (~1µs) y determinístico —
// mismo input → mismo hash. Necesario para lookup por hash en DB.
function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Options del cookie httpOnly. Uniforme entre issue/refresh/logout —
// distintas options crearían distintas cookies con el mismo nombre y
// se pisarían silenciosamente.
//
// - httpOnly: true — inaccesible desde JS (defensa XSS).
// - secure: true en prod, false en dev/test — HTTPS-only en prod.
// - sameSite: 'none' en prod, 'lax' en dev — CRÍTICO: frontend
//   (tecnyapp.com) y backend (Railway subdomain) están en dominios
//   distintos → cross-site. Con 'lax' el browser NO envía el cookie en
//   fetch POST cross-site → refresh siempre falla → user deslogueado
//   cada 15min (bug reportado 2026-07-22).
//   'none' requiere 'secure: true' (mandatorio desde Chrome 80/2020).
//   La defensa contra CSRF ya la da: (a) httpOnly, (b) path scoping
//   solo al /refresh, (c) el refresh endpoint valida via body/token
//   rotation.
// - path: '/api/auth/refresh' — cookie SOLO enviada al refresh endpoint.
//   Reduce superficie de ataque: cualquier otro endpoint del backend
//   NO ve el refresh token en ningún request header.
// - maxAge: 30 días — misma vida que el DB record.
function cookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/api/auth/refresh',
    maxAge: REFRESH_TOKEN_TTL_MS,
  };
}

/**
 * Emite un nuevo refresh token, lo persiste hasheado, y devuelve el
 * plaintext (para setear en cookie).
 *
 * @param {number} userId
 * @param {object} req    - request Express (para ip + user_agent).
 * @param {object} [opts]
 * @param {string} [opts.rotatedFromId] - UUID del refresh anterior (para
 *   trazabilidad de la cadena de rotación).
 * @returns {Promise<{token: string, id: string, expiresAt: Date}>}
 */
async function issueRefreshToken(userId, req, opts = {}) {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const ip = req?.ip || null;
  const userAgent = req?.headers?.['user-agent']?.slice(0, 512) || null;
  const rotatedFromId = opts.rotatedFromId || null;

  const { rows } = await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent, rotated_from_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [userId, tokenHash, expiresAt, ip, userAgent, rotatedFromId]
  );

  return { token, id: rows[0].id, expiresAt };
}

/**
 * Verifica un refresh token del cookie y lo rota (invalida el viejo,
 * emite uno nuevo).
 *
 * Reglas de rechazo (todas devuelven null):
 *   - Token no existe en DB (nunca fue emitido, o typo).
 *   - Token expirado (expires_at < NOW).
 *   - Token ya revocado.
 *   - Token ya rotado (usado previamente para emitir otro). Este caso
 *     es SEÑAL DE ATAQUE: alguien está reusando un refresh viejo →
 *     revocamos TODA la cadena de refresh del user (defensive).
 *
 * @param {string} token - Plaintext del cookie.
 * @param {object} req   - Request para forense del nuevo refresh.
 * @returns {Promise<{userId: number, newToken: string, newId: string, expiresAt: Date} | null>}
 */
async function verifyAndRotate(token, req) {
  if (!token || typeof token !== 'string' || token.length !== REFRESH_TOKEN_BYTES * 2) {
    return null;
  }

  const tokenHash = hashToken(token);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock exclusivo del row: previene el race donde 2 requests concurrent
    // usan el mismo refresh simultáneamente (multi-tab del mismo user).
    const { rows } = await client.query(
      `SELECT id, user_id, expires_at, revoked_at
         FROM refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [tokenHash]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const record = rows[0];

    // Ya revocado.
    if (record.revoked_at !== null) {
      // Attack signal: si alguien está reusando un refresh REVOCADO (que
      // ya fue rotado antes), es probable robo del token. Revocamos toda
      // la familia del user como defensa.
      logger.warn({ userId: record.user_id, tokenId: record.id, ip: req?.ip },
        '[refresh] intento de reuso de refresh revocado — revocando todos los tokens del user');
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = NOW()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [record.user_id]
      );
      await client.query('COMMIT');
      return null;
    }

    // Expirado por TTL.
    if (record.expires_at < new Date()) {
      await client.query('ROLLBACK');
      return null;
    }

    // OK: marcar el viejo como revocado y emitir nuevo. Todo en la misma
    // TX para atomicidad — no hay ventana donde ambos sean válidos.
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1`,
      [record.id]
    );

    // Nuevo token dentro del mismo client (misma TX).
    const newToken = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    const newTokenHash = hashToken(newToken);
    const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    const ip = req?.ip || null;
    const userAgent = req?.headers?.['user-agent']?.slice(0, 512) || null;

    const insertRes = await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent, rotated_from_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [record.user_id, newTokenHash, newExpiresAt, ip, userAgent, record.id]
    );

    await client.query('COMMIT');

    return {
      userId: record.user_id,
      newToken,
      newId: insertRes.rows[0].id,
      expiresAt: newExpiresAt,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err: err.message }, '[refresh] error en verifyAndRotate');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Revoca un refresh token específico (por su plaintext del cookie).
 * Usado en logout. Silent no-op si el token no existe o ya está revocado.
 */
async function revokeToken(token) {
  if (!token || typeof token !== 'string') return;
  const tokenHash = hashToken(token);
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}

/**
 * Revoca TODOS los refresh tokens activos de un user. Usado en:
 *   - Change password: previene que sesiones activas sigan válidas con la
 *     password vieja robada.
 *   - Reset password (mismo motivo).
 *   - Cierre de cuenta / borrado.
 */
async function revokeAllForUser(userId) {
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

module.exports = {
  issueRefreshToken,
  verifyAndRotate,
  revokeToken,
  revokeAllForUser,
  cookieOptions,
  COOKIE_NAME,
  // Exportados para tests:
  _hashToken: hashToken,
  _REFRESH_TOKEN_TTL_MS: REFRESH_TOKEN_TTL_MS,
};

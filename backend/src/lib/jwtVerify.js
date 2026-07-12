/**
 * Helper de verificación JWT compartido entre los rate limiters de app.js
 * (Pattern A cross-track, auditoría TOTAL 2026-07-12).
 *
 * Cierra el gap identificado por 3 tracks distintos (Plataforma P0-2 +
 * Auth P1-8 + Externa P1-2): un JWT firmado válido skippeaba TODO el rate
 * limiter global. Ahora hay 2 capas:
 *   1. Global limiter (300/15min por IP) — protege pre-login
 *   2. Authenticated limiter (1000/15min por user.id) — protege JWTs robados
 *
 * Ambos limiters llaman a `validateAndGetJwtUserId(req)` para saber si el
 * request tiene JWT válido y (en el caso del authenticated) obtener el user.id
 * para el keyGenerator. Cachear en `req._validatedJwtUserId` evita doble
 * jwt.verify por request.
 *
 * Extraído a módulo separado en vez de vivir en app.js para:
 *   - Testeable como unidad pura (sin cargar el pool DB, Redis, jobs, etc.
 *     al importar app.js completo).
 *   - Reusable si otros middlewares necesitan el mismo helper.
 */

const jwt = require('jsonwebtoken');

/**
 * Verifica firma HS256 del JWT en el Authorization header, decodifica el
 * payload y extrae el user.id. Cachea el resultado en `req._validatedJwtUserId`
 * (undefined = no consultado, null = inválido, número = user.id).
 *
 * @param {object} req — Express Request. Se muta agregando _validatedJwtUserId.
 * @returns {number|null} — user.id si el token es válido, null si no.
 */
function validateAndGetJwtUserId(req) {
  // Cache per-request: los 2 limiters (skip del global + keyGenerator del
  // authenticated) llaman a este helper. Sin cache serían 2× jwt.verify.
  if (req._validatedJwtUserId !== undefined) return req._validatedJwtUserId;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    req._validatedJwtUserId = null;
    return null;
  }
  const token = header.slice(7);
  if (!token || !process.env.JWT_SECRET) {
    req._validatedJwtUserId = null;
    return null;
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    // decoded.id viene del payload (seteado en makeToken). Si falta, cae a null.
    req._validatedJwtUserId = decoded.id != null ? Number(decoded.id) : null;
    return req._validatedJwtUserId;
  } catch {
    req._validatedJwtUserId = null;
    return null;
  }
}

/**
 * Wrapper booleano de `validateAndGetJwtUserId`. Mantiene compat con el
 * pattern histórico (2026-06-15) donde el skip del global limiter usaba
 * este nombre.
 */
function hasValidSignedJwt(req) {
  return validateAndGetJwtUserId(req) != null;
}

module.exports = { validateAndGetJwtUserId, hasValidSignedJwt };

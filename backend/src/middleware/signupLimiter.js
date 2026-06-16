/**
 * signupLimiter — rate limit estricto para POST /api/auth/signup (TANDA 1 prep).
 *
 * Política: 5 intentos / 1 hora / IP.
 *
 * Por qué tan estricto:
 *   El endpoint `/signup` (no implementado aún — llega en TANDA 2) crea cuentas
 *   nuevas, dispara email de verificación, y consume resources. Sin un limit
 *   dedicado, un atacante puede:
 *     - Spammear emails de verificación a víctimas (reputational/IP cost).
 *     - Saturar la tabla users con cuentas basura.
 *     - Causar bills altos en el provider de email (cuando se conecte uno).
 *   El loginLimiter (10/15min) y el globalLimiter (300/15min) NO defienden
 *   contra esto: el signup es un endpoint de "uso humano raro" — un usuario
 *   legítimo se registra UNA vez. 5 intentos/hora es MUY holgado para fat
 *   fingers y MUY ajustado para automated abuse.
 *
 * Store: PostgresRateLimitStore para que las 2 réplicas compartan el counter.
 *   (Si fuera MemoryStore, un atacante podría duplicar el límite efectivo
 *   alternando entre réplicas con un round-robin LB.) Mismo patrón que el
 *   loginLimiter / changePasswordLimiter / twoFaLimiter existentes.
 *
 * keyGenerator: IP normalizada (`ipKeyGenerator` colapsa IPv6 al /64 — evita
 *   bypass por rotación de sufijo). Acá no hay req.user (endpoint público).
 *
 * skipSuccessfulRequests: false (sí cuento exitosos también). Razón: un user
 *   legítimo se registra UNA vez exitosa. Si veo 5 "exitosos" desde la misma
 *   IP en 1 hora, es claramente abuse (o un script de testing). Para login el
 *   pattern era distinto (legit users fallan típicamente 1-2 veces, después
 *   aciertan).
 *
 * skip en tests: NODE_ENV='test' bypassea el limiter (las suites pueden hacer
 *   N signups en serie sin disparar el límite). Mismo patrón que otros limiters.
 *
 * Uso (TANDA 2 — wireado en app.js junto al route /signup):
 *   const signupLimiter = require('./middleware/signupLimiter')(loginStore, logger);
 *   app.use('/api/auth/signup', signupLimiter, signupRoute);
 *
 * Acá NO se wirea — el endpoint no existe todavía. Esto es solo la definición
 * lista para usarse cuando TANDA 2 construya el route.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Factory: devuelve un middleware express-rate-limit configurado.
 *
 * @param {object} [store] - PostgresRateLimitStore (opcional; si falta, usa
 *                           MemoryStore por default — solo aceptable single
 *                           replica).
 * @returns {Function} middleware
 */
function createSignupLimiter(store) {
  return rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos de registro desde esta IP. Esperá 1 hora antes de reintentar.' },
    keyGenerator: (req) => ipKeyGenerator(req),
    // No saltar exitosos — un user real se registra UNA vez, no hay flow
    // legítimo con múltiples exitosos por IP en una hora.
    skipSuccessfulRequests: false,
    skip: () => process.env.NODE_ENV === 'test',
    ...(store && { store }),
  });
}

module.exports = createSignupLimiter;

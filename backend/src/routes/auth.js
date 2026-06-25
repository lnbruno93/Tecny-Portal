const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const { loginSchema, changePasswordSchema, forgotPasswordSchema, resetPasswordSchema } = require('../schemas/auth');
const audit = require('../lib/audit');
const logger = require('../lib/logger');
const { resolveUserTenant } = require('../lib/userTenant');
const { loadUserCapsForTenant, capsForJwt } = require('../lib/capabilities');
const { CODES } = require('../lib/authErrorCodes');
const { sendPasswordResetEmail } = require('../lib/email');
// Importar el módulo (no destructurar) para soportar jest.spyOn desde tests.
const userAuthCache = require('../lib/userAuthCache');

// TANDA 0 #321: TTL del token de reset. 1h corto a propósito — ventana
// pequeña de exposición si el email del user es comprometido.
const RESET_TOKEN_BYTES = 32; // → 64 chars hex
const RESET_TOKEN_TTL_HOURS = 1;

// Costo de bcrypt — 12 rounds (resistencia a cracking offline; costo de CPU despreciable en login)
const BCRYPT_ROUNDS = 12;

// Hash dummy precalculado — garantiza tiempo constante aunque el usuario no exista
// Previene timing attacks que permiten enumerar usuarios válidos.
// Usa el MISMO costo que los hashes reales para que el tiempo sea comparable.
const DUMMY_HASH = bcrypt.hashSync('__dummy_password_for_timing__', BCRYPT_ROUNDS);

// algoritmo fijo: previene algorithm confusion attacks (none, RS256, etc.)
const JWT_ALGORITHM = 'HS256';

// Política de lockout por usuario (complementa el rate limit por IP existente):
// 10 fallos consecutivos → 15 min bloqueo. Resetea al login exitoso.
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_DURATION_MIN = 15;

/**
 * Firma el JWT del login. NO hace queries — los datos vienen pre-resueltos
 * del caller (login handler).
 *
 * 2026-06-23 Permisos F4: cutover capability-based. Antes el JWT embebía
 * `perms` (14 booleans flat). Ahora embebe:
 *   - tenant_cap_rol: el rol del user en su tenant (owner|admin|vendedor|
 *     encargado|lectura|custom). El middleware requireCapability lo usa
 *     para bypass owner/admin sin query DB.
 *   - caps: { 'pantalla.capability': true } — solo enabled. Undefined si
 *     el rol es bypass (owner/admin del tenant — no necesita enumerar).
 * Admin global (users.role='admin') ya bypassea en el middleware nuevo —
 * tampoco le embebemos caps.
 *
 * 2026-06-15 multi-tenant PR 3: incluye `tenant_id` y `tenant_rol` en el
 *   payload. El middleware requireAuth los decora como `req.tenantId` y
 *   `req.tenantRol`. Si el user cambia rol/overrides via PUT
 *   /capabilities/users/:id, se bumpea password_changed_at → token
 *   invalidado → user re-loguea con caps nuevas.
 *
 * @param {object} user — row de users con id/username/email/role mínimo
 * @param {object} tenant — { tenant_id, rol } del default tenant
 * @param {object} [capInfo] — { rol, caps } para non-admin. Si user.role
 *   es admin global, este arg se ignora.
 * @returns {string} JWT firmado
 */
function makeToken(user, tenant, capInfo) {
  // iat_ms: timestamp de emisión en milisegundos — permite comparación de
  // precisión sub-segundo contra password_changed_at (precisión µs en PG).
  // El jwt.iat estándar solo tiene precisión de segundos, lo que genera race
  // conditions cuando login y change-password ocurren en el mismo segundo.
  const payload = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    tenant_id: tenant.tenant_id,
    tenant_rol: tenant.rol,
    iat_ms: Date.now(),
  };
  // 2026-06-21 #353 Fase 1: is_super_admin como claim. NO es source of
  // truth (el middleware requireSuperAdmin re-valida contra userAuthCache
  // → DB), pero embeberlo evita un round-trip extra al frontend admin
  // app: el cliente lee `decoded.is_super_admin` del JWT y decide si
  // redirigir a /admin sin pegar a /api/admin/me primero. Defensa en
  // depth: aún si un atacante alterara el JWT, el backend lo rechaza
  // por firma HS256 (no se puede forjar sin JWT_SECRET).
  if (user.is_super_admin) {
    payload.is_super_admin = true;
  }
  if (capInfo && user.role !== 'admin') {
    payload.tenant_cap_rol = capInfo.rol;
    if (capInfo.caps !== undefined) {
      payload.caps = capInfo.caps;
    }
  }
  return jwt.sign(
    payload,
    process.env.JWT_SECRET,
    // 2026-06-10 SE-01: bajamos default de 7d → 8h. Token en localStorage con
    // vida larga es vector XSS: cualquier dep transitiva compromete = sesión
    // robada por una semana. Fix real (httpOnly cookie + refresh token) queda
    // para TANDA 6.
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h', algorithm: JWT_ALGORITHM }
  );
}

router.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    const field = username ? 'username' : 'email';
    const value = username || email;

    // 2026-06-16 TANDA 1: lookup case-insensitive cuando el field es email. La
    // DB tiene un índice único sobre LOWER(email) (migration 20260616000003),
    // así que `Lucas@x.com` y `lucas@x.com` resuelven al mismo user. El schema
    // ya normaliza `email` a minúsculas pero usamos LOWER() en ambos lados
    // como defense in depth.
    const filter = field === 'email' ? 'LOWER(email) = LOWER($1)' : `${field} = $1`;
    const { rows } = await db.query(
      `SELECT id, nombre, username, email, role, password_hash, password_changed_at,
              failed_login_count, lockout_until, email_verified_at, is_super_admin
       FROM users WHERE ${filter} AND deleted_at IS NULL`,
      [value]
    );
    const user = rows[0];

    // Lockout per-user: si el usuario está bloqueado, rechazamos antes de chequear
    // la password. NO revelamos al cliente si el usuario existe.
    //
    // 2026-06-16 TANDA 1 anti-enumeration: respuesta idéntica a "usuario no
    // existe" o "password incorrecta" — 401 con el mismo mensaje genérico.
    // Antes devolvíamos 423 con mensaje "bloqueada", pero eso permitía a un
    // atacante enumerar emails registrados (probar X → si tira 423, X existe).
    // Trade-off UX: un usuario legítimo bloqueado ahora ve "credenciales
    // inválidas" en vez de "bloqueada por X minutos". Aceptado: el lockout
    // solo dispara con 10 fallos consecutivos (caso edge), y el upside de
    // anti-enum es permanente (especialmente con /signup público en TANDA 2).
    // El admin sigue distinguiendo el caso en logs / audit / Sentry.
    if (user && user.lockout_until && new Date(user.lockout_until) > new Date()) {
      logger.warn({ user_id: user.id, ip: req.ip, lockout_until: user.lockout_until }, 'login bloqueado por lockout');
      // Igual ejecutamos bcrypt para que el tiempo de respuesta sea constante.
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos', code: CODES.INVALID_CREDENTIALS });
    }

    // Siempre ejecutar bcrypt.compare (tiempo constante) para no revelar si el usuario existe
    const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) {
      logger.warn({ field, ip: req.ip }, 'login fallido');
      // Si el usuario existe, incrementamos el contador. Si llega al threshold,
      // seteamos lockout_until. Esto es best-effort: una falla acá NO debe romper
      // el response 401 al cliente.
      if (user) {
        try {
          // 2026-06-25 SOL-3 (audit pre-live): UPDATE atómico en lugar de
          // read-then-write. Antes el patrón era `nuevo = user.count + 1;
          // UPDATE SET count = $nuevo` — bajo brute-force concurrente
          // (50 requests paralelas), todas leían el mismo valor y escribían
          // N+1, perdiendo updates. El contador subía mucho más lento que
          // los intentos reales → el lockout disparaba mucho después del
          // threshold configurado.
          //
          // Ahora `failed_login_count + 1` en SQL es atómico (el server
          // serializa el UPDATE por row lock). El CASE setea lockout_until
          // en el mismo statement si el nuevo valor cruza el threshold,
          // sin race entre el incremento y la decisión.
          const { rows } = await db.query(
            `UPDATE users
                SET failed_login_count = failed_login_count + 1,
                    lockout_until = CASE
                      WHEN failed_login_count + 1 >= $1
                      THEN NOW() + INTERVAL '${LOCKOUT_DURATION_MIN} minutes'
                      ELSE lockout_until
                    END
              WHERE id = $2
              RETURNING failed_login_count`,
            [LOCKOUT_THRESHOLD, user.id]
          );
          const nuevo = rows[0]?.failed_login_count;
          if (nuevo >= LOCKOUT_THRESHOLD) {
            logger.warn({ user_id: user.id, intentos: nuevo }, 'usuario bloqueado por lockout');
          }
        } catch (e) {
          logger.error({ err: e }, 'no se pudo actualizar failed_login_count');
        }
      }
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos', code: CODES.INVALID_CREDENTIALS });
    }

    // ─── 2FA gate ───
    // Importante (H1 auditoría 2026-06): el reset de `failed_login_count` se
    // movió DESPUÉS de este gate. Antes se reseteaba apenas la password era
    // OK — eso significaba que el contador volvía a 0 antes del check 2FA,
    // y un fallo de 2FA empezaba a contar desde 0. Ahora se resetea solo
    // cuando TODOS los gates (password + 2FA) pasan exitosos.
    // Si el user tiene 2FA enabled, exigir un segundo factor antes de emitir
    // el JWT. Si vino el código en el body, lo verificamos. Si no, devolvemos
    // 401 con un flag para que el frontend muestre el input del código.
    //
    // Política: 2FA es OPCIONAL al inicio (decisión durable, ver ARCHITECTURE).
    // Usuarios sin row en user_2fa o con enabled_at NULL hacen login normal.
    //
    // `verifyAndConsume` — verificación ATÓMICA en DB:
    //   - TOTP: persiste `last_used_step`, rechaza replay del mismo código
    //     dentro del window de 90s (defensa B2 auditoría 2026-06).
    //   - Recovery code: UPDATE con WHERE específico, rechaza doble uso en
    //     requests concurrentes (defensa B3 auditoría 2026-06).
    //
    // H1 auditoría 2026-06: fallo de 2FA también incrementa `failed_login_count`
    // y dispara lockout per-user al threshold. Antes, solo el fallo de password
    // disparaba el contador — un atacante con password leakeada podía brute-
    // forcear el TOTP de 6 dígitos rotando IPs (el espacio ~10^6 con window ±1
    // es factible en horas). Ahora el lockout per-user defiende independiente
    // del rate-limit por IP.
    const { load2fa, verifyAndConsume } = require('./twoFa');
    const twoFa = await load2fa(user.id);
    if (twoFa && twoFa.enabled_at) {
      const code = req.body.code; // opcional en el body del login
      if (!code) {
        return res.status(401).json({
          error: 'Se requiere código 2FA.',
          twofa_required: true, // flag para que el front muestre el input
          code: CODES.TWOFA_REQUIRED,
        });
      }
      const { ok } = await verifyAndConsume(user.id, String(code));
      if (!ok) {
        logger.warn({ user_id: user.id, ip: req.ip }, 'login 2FA fallido');
        // 2026-06-25 SOL-3: mismo UPDATE atómico que el fallo de password
        // arriba. Race condition idéntica si la única dim de attack es 2FA.
        try {
          const { rows } = await db.query(
            `UPDATE users
                SET failed_login_count = failed_login_count + 1,
                    lockout_until = CASE
                      WHEN failed_login_count + 1 >= $1
                      THEN NOW() + INTERVAL '${LOCKOUT_DURATION_MIN} minutes'
                      ELSE lockout_until
                    END
              WHERE id = $2
              RETURNING failed_login_count`,
            [LOCKOUT_THRESHOLD, user.id]
          );
          const nuevo = rows[0]?.failed_login_count;
          if (nuevo >= LOCKOUT_THRESHOLD) {
            logger.warn({ user_id: user.id, intentos: nuevo }, 'usuario bloqueado por lockout (2FA)');
          }
        } catch (e) {
          logger.error({ err: e }, 'no se pudo actualizar failed_login_count (2FA)');
        }
        return res.status(401).json({ error: 'Código 2FA incorrecto.', code: CODES.INVALID_TWOFA_CODE });
      }
      // 2FA OK: verifyAndConsume ya hizo el UPDATE atómico de last_used_at + last_used_step.
    }

    // Éxito completo (password + 2FA): reseteamos contador + lockout si los había.
    // Best-effort, no bloquea la respuesta si falla.
    if (user.failed_login_count > 0 || user.lockout_until) {
      try {
        await db.query(
          'UPDATE users SET failed_login_count = 0, lockout_until = NULL WHERE id = $1',
          [user.id]
        );
      } catch (e) { logger.error({ err: e }, 'no se pudo resetear failed_login_count'); }
    }

    // 2026-06-23 Permisos F4: resolución capability-based. Antes había acá
    // un SELECT a user_permissions (14 booleans) — esa tabla murió en F4.
    // Ahora:
    //   1. resolveUserTenant — query a tenant_users (sin RLS).
    //   2. loadUserCapsForTenant — query a tenant_user_roles + user_capabilities
    //      vía withTenant (RLS-safe).
    // Admin global (users.role='admin') bypassea: no necesita caps embebidas.
    // Si la resolución de caps falla por algún edge, NO rompemos login —
    // logueamos y el middleware hace fallback a DB en el primer request.
    //
    // 2026-06-24 SEG-2: resolveUserTenant ahora puede tirar NO_TENANT si
    // el user NO tiene row en tenant_users. Antes era fallback silencioso
    // a tenant 1 (data-leak risk). El login devuelve 401 con código
    // estable — el frontend puede mostrar mensaje específico al user.
    let tenant;
    try {
      tenant = await resolveUserTenant(user.id);
    } catch (e) {
      if (e.code === 'NO_TENANT') {
        return res.status(401).json({
          error: 'Tu cuenta no está asignada a una organización. Contactá soporte.',
          code: CODES.NO_TENANT,
        });
      }
      throw e;
    }

    let capInfo;
    let capsResponse = null; // para el response.user.caps (frontend)
    let rolResponse = null;
    if (user.role !== 'admin') {
      try {
        const { rol, caps } = await loadUserCapsForTenant(user.id, tenant.tenant_id);
        capInfo = { rol, caps: capsForJwt(rol, caps) };
        rolResponse = rol;
        // capsResponse: para el cliente. null = bypass (owner/admin). Si
        // no es bypass, mandamos un array de slugs activos (más compacto
        // que el objeto del JWT, mismo shape consumible).
        capsResponse = caps === null ? null : Array.from(caps);
      } catch (e) {
        logger.warn({ err: e, userId: user.id, tenantId: tenant.tenant_id },
          'login: error resolviendo capabilities — sigue sin capInfo (fallback DB en middleware)');
      }
    }

    res.json({
      token: makeToken(user, tenant, capInfo),
      user: {
        id: user.id,
        nombre: user.nombre,
        username: user.username,
        email: user.email,
        role: user.role,
        // 2026-06-16 TANDA 2.1: el frontend usa este flag para mostrar el banner
        // de verificación + deshabilitar acciones de escritura. El backend lo
        // re-verifica en cada request (middleware/auth.js) — no confiamos
        // unicamente en el cliente.
        email_verified: !!user.email_verified_at,
        // 2026-06-21 #353 Fase 1: admin app lee este flag del response del
        // login para decidir si redirigir a /admin. NO source of truth para
        // autorización — eso es el middleware `requireSuperAdmin` server-side.
        is_super_admin: !!user.is_super_admin,
        // 2026-06-23 F4: response capability-based. tenant_cap_rol = rol
        // nuevo (owner/admin/vendedor/...). caps = array de slugs activos
        // o null para bypass (owner/admin). Admin global → caps undefined.
        tenant_cap_rol: rolResponse,
        caps: capsResponse,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, nombre, username, email, role, email_verified_at, is_super_admin FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado', code: CODES.USER_NOT_FOUND });

    // 2026-06-23 F4: resolución capability-based (igual que login). Admin
    // global no necesita caps en el response — el frontend lo trata como
    // bypass por role.
    const userRow = rows[0];
    let rolResponse = null;
    let capsResponse = null;
    if (userRow.role !== 'admin') {
      try {
        const { tenant_id } = await resolveUserTenant(req.user.id);
        const { rol, caps } = await loadUserCapsForTenant(req.user.id, tenant_id);
        rolResponse = rol;
        capsResponse = caps === null ? null : Array.from(caps);
      } catch (e) {
        // 2026-06-24 SEG-2: NO_TENANT no debe devolver caps vacíos y 200 —
        // forzar re-login. Otros errores (DB hiccup, etc.) siguen logueando
        // warn y devolviendo el user sin caps (igual que antes).
        if (e.code === 'NO_TENANT') {
          return res.status(401).json({
            error: 'Tu cuenta no está asignada a una organización. Contactá soporte.',
            code: CODES.NO_TENANT,
          });
        }
        logger.warn({ err: e, userId: req.user.id },
          '/me: error resolviendo capabilities — devuelve sin caps');
      }
    }

    // 2026-06-16 TANDA 2.1: incluir email_verified en la respuesta de /me para
    // que el frontend sepa si mostrar el banner de verificación. Excluimos
    // email_verified_at (timestamp) del response — el cliente solo necesita el bool.
    const { email_verified_at, is_super_admin, ...rest } = userRow;
    res.json({
      ...rest,
      email_verified: !!email_verified_at,
      // 2026-06-21 #353 Fase 1: ver comentario en /login response.
      is_super_admin: !!is_super_admin,
      tenant_cap_rol: rolResponse,
      caps: capsResponse,
    });
  } catch (err) {
    next(err);
  }
});

// Logout — bump password_changed_at invalida TODOS los tokens activos (todos los dispositivos).
// Solución stateless: no requiere blocklist ni Redis. El middleware ya verifica iat_ms < changedAt.
//
// 2026-06-12: bumpeamos por +1ms (no NOW() pelado) para evitar una race condition
// pre-existente. El JWT iat_ms tiene precisión de milisegundos (Date.now() en login).
// PG NOW() tiene precisión de microsegundos pero al convertirse a JS Date en el
// middleware (`new Date(pgTimestamp).getTime()`) pierde los sub-ms. Si login y
// logout ocurren en el MISMO ms (caso típico: test que loguea + invoca logout
// in-process), el middleware ve `iat_ms === changedAtMs` y el check `iat_ms <
// changedAtMs` da FALSE → el token sigue siendo válido. Causa flake intermitente
// (~3% rate) en historial.test.js que valida el flow de logout y cascada en 7
// tests siguientes que usan el mismo token. El +1 garantiza changedAt > iat_ms
// en TODOS los casos sin romper el flow de change-password (cuyo login posterior
// ocurre con varios ms de latencia HTTP).
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE users SET password_changed_at = to_timestamp(($1::bigint + 1) / 1000.0) WHERE id = $2`,
      [Date.now(), req.user.id]
    );
    // P-04 Fase 3.6: invalidar cache de auth meta (cross-instance Redis).
    // Sin esto, otra réplica con el row cacheado seguiría aceptando el token
    // hasta TTL de 60s. Fire-and-forget — userAuthCache loggea fallos
    // internamente (TANDA 1 fix H1-Sol).
    userAuthCache.invalidateUserAuth(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', requireAuth, validate(changePasswordSchema), async (req, res, next) => {
  try {
    const { currentPassword, newPassword, twofa_code } = req.body;

    const { rows } = await db.query(
      'SELECT id, password_hash FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado', code: CODES.USER_NOT_FOUND });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta', code: CODES.INVALID_CURRENT_PASSWORD });

    // 2026-06-11 SE-07: re-verificar 2FA si está activa. Sin esto, un token
    // robado podía cambiar la password sin que el atacante supiera el TOTP →
    // account takeover persistente. Ahora, aunque tenga la password actual del
    // user, sin el código TOTP no puede cerrar la cuenta.
    const { load2fa, verifyAndConsume } = require('./twoFa');
    const twoFa = await load2fa(user.id);
    if (twoFa && twoFa.enabled_at) {
      if (!twofa_code) {
        return res.status(401).json({
          error: 'Se requiere código 2FA para cambiar la contraseña.',
          twofa_required: true,
          code: CODES.TWOFA_REQUIRED,
        });
      }
      const { ok } = await verifyAndConsume(user.id, String(twofa_code));
      if (!ok) {
        logger.warn({ user_id: user.id, ip: req.ip }, 'change-password 2FA fallido');
        return res.status(401).json({ error: 'Código 2FA incorrecto.', code: CODES.INVALID_TWOFA_CODE });
      }
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // TANDA 3 fix M2 auditoría 2026-06-17: audit-in-tx. Antes el UPDATE
    // corría con db.query (pool global) y el audit corría DESPUÉS, también
    // con pool global. Si el audit fallaba (network, Sentry down), el
    // password ya estaba cambiado pero la traza se perdía — regresión vs
    // el patrón audit-in-tx que routes/usuarios.js aplica.
    // Ahora UPDATE + audit van en la misma tx; si audit falla, ROLLBACK.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2',
        [hash, user.id]
      );
      // 2026-06-11 SE-05: req se propaga al audit para capturar IP/UA/request_id.
      await audit(client, 'users', 'UPDATE', user.id, {
        tipo: 'cambio_password', user_id: req.user.id, req,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    // P-04 Fase 3.6: invalidar cache de auth meta DESPUÉS del COMMIT.
    // password_changed_at cambió → cualquier réplica con el row cacheado
    // debe re-fetchar para que el siguiente request vea iat < changedAt
    // y rechace el token viejo.
    userAuthCache.invalidateUserAuth(user.id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Forgot / Reset password (TANDA 0 #321) ────────────────────────────────
//
// Flow:
//   1. User olvidó su pass → frontend POSTea /forgot-password con email.
//   2. Backend lookup case-insensitive. Si existe + verificado, genera token,
//      INSERT en password_reset_tokens, envía email con link.
//   3. Response: 200 genérica (anti-enum, idéntica para existing/non-existing).
//   4. User clickea link → frontend POSTea /reset-password con token + newPassword.
//   5. Backend valida token (existe + not used + not expired) + policy de pass.
//   6. UPDATE users.password_hash + password_changed_at en tx + mark token used.
//   7. JWT viejo del user queda inválido (password_changed_at bumped).
//   8. Audit + invalidate userAuthCache.
//
// Decisiones durables:
//   - TTL 1 hora (corto a propósito — ventana de exposición chica si el email
//     leakea). User puede pedir otro link si vence.
//   - Token UUID-hex 32 bytes (256 bits) — espacio infactible brute-force.
//   - Single-shot (used_at IS NOT NULL ⇒ rechazado). Si el user clickea el
//     link 2 veces, el segundo falla con USED_RESET_TOKEN — UX guides al login.
//   - No auto-login post-reset: el user va a la pantalla de login con su
//     nueva pass. Razón: si alguien interceptó el link, no le damos sesión.
//   - Rate limits dedicados (app.js): 3/h en /forgot, 10/h en /reset.

/**
 * POST /forgot-password — pide reset por email. Anti-enum.
 *
 * Body: { email, hcaptcha_response? }
 * Response 200: { reset_required: true, reset_token_ttl_hours }
 *   (idéntico para email existente vs. no-existente)
 */
router.post('/forgot-password', validate(forgotPasswordSchema), async (req, res, next) => {
  const { email } = req.body;

  // Captcha gate — antes de cualquier query a DB (mismo pattern que signup).
  // Si HCAPTCHA_ENABLED!='true' o NODE_ENV=test, verifyCaptcha bypassa.
  const captcha = require('../lib/captcha');
  const captchaResult = await captcha.verifyCaptcha(req.body.hcaptcha_response, req.ip);
  if (!captchaResult.success) {
    const errMap = {
      expired:       'La verificación expiró. Intentá de nuevo.',
      duplicate:     'La verificación ya fue usada. Recargá la página.',
      invalid_token: 'Verificación inválida. Completá el captcha y reintentá.',
    };
    const msg = errMap[captchaResult.error] || 'No pudimos verificar el captcha. Reintentá en un minuto.';
    logger.info({ source: 'forgot_password_captcha_fail', error: captchaResult.error },
      'forgot-password rechazado por captcha');
    return res.status(400).json({ error: msg, reason: 'captcha_failed' });
  }

  try {
    // Lookup case-insensitive. Solo users con email verificado pueden resetear —
    // si el email no está verificado, no probablemente no es del user real.
    // (Si fuera del user, primero debe verificar via /resend-verification.)
    const { rows } = await db.query(
      `SELECT id, nombre, email FROM users
        WHERE LOWER(email) = LOWER($1)
          AND deleted_at IS NULL
          AND email_verified_at IS NOT NULL`,
      [email]
    );
    const user = rows[0];

    if (user) {
      // Generar token + insertar + send email (fire-and-forget).
      const token = randomBytes(RESET_TOKEN_BYTES).toString('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000);
      await db.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [user.id, token, expiresAt]
      );
      logger.info({ user_id: user.id, source: 'forgot_password_token_issued' },
        'token de reset emitido');

      // fire-and-forget — si email provider falla, el log lo captura. El user
      // puede reintentar via /forgot-password (rate limit aplica).
      setImmediate(async () => {
        try {
          const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;
          await sendPasswordResetEmail({
            to: user.email,
            name: user.nombre,
            resetUrl,
            ttlHours: RESET_TOKEN_TTL_HOURS,
          });
        } catch (e) {
          logger.error({ err: e, user_id: user.id },
            'No se pudo enviar password reset email. User debe reintentar.');
        }
      });
    } else {
      // Anti-enum: dummy bcrypt para equalizar timing con el path "user existe"
      // (que después manda email — más latencia). Sin esto, response time
      // permite distinguir email registrado vs no, anulando el anti-enum.
      // Mismo patrón que el login (DUMMY_HASH) y el signup duplicate.
      await bcrypt.compare('__dummy_timing_equalizer__', DUMMY_HASH);
      logger.info({ source: 'forgot_password_unknown_email' },
        'forgot-password con email desconocido — respondiendo genérico (anti-enum)');
    }

    // Response idéntica para ambos paths (anti-enum). El user ve siempre el
    // mismo "Si el email es válido, te mandamos un link" en el frontend.
    res.status(200).json({
      reset_required: true,
      reset_token_ttl_hours: RESET_TOKEN_TTL_HOURS,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /reset-password — consume el token + setea nueva pass.
 *
 * Body: { token, newPassword }
 * Response 200: { ok: true }
 * Errors:
 *   - 401 INVALID_RESET_TOKEN — token no existe (mal copiado del email)
 *   - 401 EXPIRED_RESET_TOKEN — token venció
 *   - 401 USED_RESET_TOKEN    — token ya fue consumido
 *   - 400 Datos inválidos     — password policy fail (zod validate antes)
 */
router.post('/reset-password', validate(resetPasswordSchema), async (req, res, next) => {
  const { token, newPassword } = req.body;

  try {
    // Lookup el token. JOIN con users para tomar el row del user en la
    // misma query y evitar un extra hop.
    const { rows } = await db.query(
      `SELECT prt.id AS token_id, prt.user_id, prt.expires_at, prt.used_at,
              u.email, u.nombre
         FROM password_reset_tokens prt
         JOIN users u ON u.id = prt.user_id
        WHERE prt.token = $1 AND u.deleted_at IS NULL`,
      [token]
    );
    const row = rows[0];

    if (!row) {
      return res.status(401).json({ error: 'Token inválido.', code: CODES.INVALID_RESET_TOKEN });
    }
    if (row.used_at) {
      return res.status(401).json({ error: 'Este link ya fue usado. Pedí uno nuevo si lo necesitás.', code: CODES.USED_RESET_TOKEN });
    }
    if (new Date(row.expires_at) <= new Date()) {
      return res.status(401).json({ error: 'El link venció. Pedí uno nuevo.', code: CODES.EXPIRED_RESET_TOKEN });
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // UPDATE password + mark token used + audit en una tx para atomicity.
    // Si el audit falla, el reset se revierte (mismo patrón que change-password).
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2',
        [hash, row.user_id]
      );
      await client.query(
        'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
        [row.token_id]
      );
      // Audit como system event (no tenemos req.user — el endpoint es público).
      // user_id en el extra para attribution.
      await audit(client, 'users', 'UPDATE', row.user_id, {
        tipo: 'password_reset',
        user_id: row.user_id,
        req,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Invalidate auth cache → el JWT viejo del user queda inválido (next
    // /me request lee password_changed_at fresh y rechaza el token).
    userAuthCache.invalidateUserAuth(row.user_id);

    logger.info({ user_id: row.user_id, source: 'password_reset_completed' },
      'password reset completado exitosamente');

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

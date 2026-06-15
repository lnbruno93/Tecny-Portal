const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const { loginSchema, changePasswordSchema } = require('../schemas/auth');
const audit = require('../lib/audit');
const logger = require('../lib/logger');
const { TOOLS } = require('../lib/tools');
const { loadUserPerms } = require('../lib/permissions');

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

// 2026-06-15 multi-tenant PR 3: resuelve el tenant del user al hacer login.
// Mientras estamos en single-tenant, todo user nuevo se vincula al tenant 1
// vía la migration de PR 1, así que esta query siempre devuelve algo. Cuando
// arranque el SaaS, el user puede pertenecer a varios tenants — por ahora
// elegimos el primero (ordered por id). UI futura permitirá switch entre
// tenants y refrescará el JWT.
async function resolveDefaultTenant(userId) {
  const { rows } = await db.query(
    `SELECT tenant_id, rol FROM tenant_users
      WHERE user_id = $1
      ORDER BY tenant_id ASC LIMIT 1`,
    [userId]
  );
  // Fallback defensivo: si el user no tiene tenant (caso edge, no debería
  // pasar post-PR1 backfill), lo asignamos al tenant 1.
  return rows[0] || { tenant_id: 1, rol: 'member' };
}

async function makeToken(user) {
  // iat_ms: timestamp de emisión en milisegundos — permite comparación de precisión
  // sub-segundo contra password_changed_at (que tiene precisión de microsegundos en PG).
  // El jwt.iat estándar solo tiene precisión de segundos, lo que genera race conditions
  // cuando el login y el cambio de contraseña ocurren en el mismo segundo.
  //
  // 2026-06-11 P-02: embebemos `perms` en el JWT para evitar la query DB por
  // request del middleware requirePermission. Admin no necesita perms en el token
  // (el middleware ya bypassea por role). Para users con role='op', leemos las
  // perms de DB en el login y las incluimos. Si después cambian los perms (via
  // PUT /usuarios/:id), bumpeamos password_changed_at del afectado y el user
  // re-loguea para refrescar el token.
  //
  // 2026-06-15 multi-tenant PR 3: sumamos `tenant_id` y `tenant_rol` al payload.
  // El middleware requireAuth los decora a `req.tenantId` y `req.tenantRol`. Los
  // endpoints (refactor en PR 4) lo usarán para queries multi-tenant aware.
  // RLS de PR 2 ya está activo — cuando `app.current_tenant` se setee al inicio
  // del request, Postgres filtra automáticamente.
  const tenant = await resolveDefaultTenant(user.id);
  const payload = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    tenant_id: tenant.tenant_id,
    tenant_rol: tenant.rol,
    iat_ms: Date.now(),
  };
  if (user.role !== 'admin') {
    payload.perms = await loadUserPerms(user.id);
  }
  return jwt.sign(
    payload,
    process.env.JWT_SECRET,
    // 2026-06-10 SE-01: bajamos default de 7d → 8h. Token en localStorage con vida
    // larga es vector XSS: cualquier dep transitiva compromete = sesión robada por
    // una semana. Fix real (httpOnly cookie + refresh token) queda para TANDA 6.
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h', algorithm: JWT_ALGORITHM }
  );
}

router.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    const field = username ? 'username' : 'email';
    const value = username || email;

    const { rows } = await db.query(
      `SELECT id, nombre, username, email, role, password_hash, password_changed_at,
              failed_login_count, lockout_until
       FROM users WHERE ${field} = $1 AND deleted_at IS NULL`,
      [value]
    );
    const user = rows[0];

    // Lockout per-user: si el usuario está bloqueado, rechazamos antes de chequear
    // la password. NO revelamos al cliente si el usuario existe (mensaje genérico).
    // Usamos 423 Locked para que el frontend pueda mostrar un mensaje diferenciado
    // si quiere; el body sigue genérico para que un atacante no enumere usuarios.
    if (user && user.lockout_until && new Date(user.lockout_until) > new Date()) {
      logger.warn({ user_id: user.id, ip: req.ip, lockout_until: user.lockout_until }, 'login bloqueado por lockout');
      // Igual ejecutamos bcrypt para que el tiempo de respuesta sea constante.
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(423).json({ error: 'Cuenta temporalmente bloqueada por intentos fallidos. Probá más tarde.' });
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
          const nuevo = (user.failed_login_count || 0) + 1;
          if (nuevo >= LOCKOUT_THRESHOLD) {
            await db.query(
              `UPDATE users SET failed_login_count = $1,
                      lockout_until = NOW() + INTERVAL '${LOCKOUT_DURATION_MIN} minutes'
                 WHERE id = $2`,
              [nuevo, user.id]
            );
            logger.warn({ user_id: user.id, intentos: nuevo }, 'usuario bloqueado por lockout');
          } else {
            await db.query('UPDATE users SET failed_login_count = $1 WHERE id = $2', [nuevo, user.id]);
          }
        } catch (e) {
          logger.error({ err: e }, 'no se pudo actualizar failed_login_count');
        }
      }
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
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
        });
      }
      const { ok } = await verifyAndConsume(user.id, String(code));
      if (!ok) {
        logger.warn({ user_id: user.id, ip: req.ip }, 'login 2FA fallido');
        // Incrementar contador y disparar lockout si llegamos al threshold.
        // Best-effort (no bloquea response). Misma lógica que el fallo de password.
        try {
          const nuevo = (user.failed_login_count || 0) + 1;
          if (nuevo >= LOCKOUT_THRESHOLD) {
            await db.query(
              `UPDATE users SET failed_login_count = $1,
                      lockout_until = NOW() + INTERVAL '${LOCKOUT_DURATION_MIN} minutes'
                 WHERE id = $2`,
              [nuevo, user.id]
            );
            logger.warn({ user_id: user.id, intentos: nuevo }, 'usuario bloqueado por lockout (2FA)');
          } else {
            await db.query('UPDATE users SET failed_login_count = $1 WHERE id = $2', [nuevo, user.id]);
          }
        } catch (e) {
          logger.error({ err: e }, 'no se pudo actualizar failed_login_count (2FA)');
        }
        return res.status(401).json({ error: 'Código 2FA incorrecto.' });
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

    const { rows: perms } = await db.query(
      'SELECT tool, enabled FROM user_permissions WHERE user_id = $1',
      [user.id]
    );
    const defaultPerms = Object.fromEntries(TOOLS.map(t => [t, false]));
    const permissions = { ...defaultPerms, ...Object.fromEntries(perms.map(p => [p.tool, p.enabled])) };

    res.json({
      token: await makeToken(user),
      user: { id: user.id, nombre: user.nombre, username: user.username, email: user.email, role: user.role, perms: permissions },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, nombre, username, email, role FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { rows: perms } = await db.query(
      'SELECT tool, enabled FROM user_permissions WHERE user_id = $1',
      [req.user.id]
    );
    const defaultPerms = Object.fromEntries(TOOLS.map(t => [t, false]));
    res.json({ ...rows[0], perms: { ...defaultPerms, ...Object.fromEntries(perms.map(p => [p.tool, p.enabled])) } });
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
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

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
        });
      }
      const { ok } = await verifyAndConsume(user.id, String(twofa_code));
      if (!ok) {
        logger.warn({ user_id: user.id, ip: req.ip }, 'change-password 2FA fallido');
        return res.status(401).json({ error: 'Código 2FA incorrecto.' });
      }
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await db.query(
      'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2',
      [hash, user.id]
    );
    // 2026-06-11 SE-05: req se propaga al audit para capturar IP/UA/request_id.
    await audit('users', 'UPDATE', user.id, { tipo: 'cambio_password', user_id: req.user.id, req });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

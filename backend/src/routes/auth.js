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

function makeToken(user) {
  // iat_ms: timestamp de emisión en milisegundos — permite comparación de precisión
  // sub-segundo contra password_changed_at (que tiene precisión de microsegundos en PG).
  // El jwt.iat estándar solo tiene precisión de segundos, lo que genera race conditions
  // cuando el login y el cambio de contraseña ocurren en el mismo segundo.
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role, iat_ms: Date.now() },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d', algorithm: JWT_ALGORITHM }
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

    // Éxito: reseteamos contador + lockout (si los había). Best-effort, no bloquea
    // la respuesta si falla.
    if (user.failed_login_count > 0 || user.lockout_until) {
      try {
        await db.query(
          'UPDATE users SET failed_login_count = 0, lockout_until = NULL WHERE id = $1',
          [user.id]
        );
      } catch (e) { logger.error({ err: e }, 'no se pudo resetear failed_login_count'); }
    }

    // ─── 2FA gate ───
    // Si el user tiene 2FA enabled, exigir un segundo factor antes de emitir
    // el JWT. Si vino el código en el body, lo verificamos. Si no, devolvemos
    // 401 con un flag para que el frontend muestre el input del código.
    //
    // Política: 2FA es OPCIONAL al inicio (decisión durable, ver ARCHITECTURE).
    // Usuarios sin row en user_2fa o con enabled_at NULL hacen login normal.
    const { load2fa, verifyAny, touchLastUsed } = require('./twoFa');
    const twoFa = await load2fa(user.id);
    if (twoFa && twoFa.enabled_at) {
      const code = req.body.code; // opcional en el body del login
      if (!code) {
        return res.status(401).json({
          error: 'Se requiere código 2FA.',
          twofa_required: true, // flag para que el front muestre el input
        });
      }
      const { ok, kind } = await verifyAny(twoFa, String(code));
      if (!ok) {
        logger.warn({ user_id: user.id, ip: req.ip }, 'login 2FA fallido');
        return res.status(401).json({ error: 'Código 2FA incorrecto.' });
      }
      if (kind === 'totp') {
        // recovery codes ya actualizan last_used_at en verifyAny.
        await touchLastUsed(user.id);
      }
    }

    const { rows: perms } = await db.query(
      'SELECT tool, enabled FROM user_permissions WHERE user_id = $1',
      [user.id]
    );
    const defaultPerms = Object.fromEntries(TOOLS.map(t => [t, false]));
    const permissions = { ...defaultPerms, ...Object.fromEntries(perms.map(p => [p.tool, p.enabled])) };

    res.json({
      token: makeToken(user),
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
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      'UPDATE users SET password_changed_at = NOW() WHERE id = $1',
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', requireAuth, validate(changePasswordSchema), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const { rows } = await db.query(
      'SELECT id, password_hash FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await db.query(
      'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2',
      [hash, user.id]
    );
    await audit('users', 'UPDATE', user.id, { tipo: 'cambio_password', user_id: req.user.id });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

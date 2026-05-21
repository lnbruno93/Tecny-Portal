const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const { loginSchema, changePasswordSchema } = require('../schemas/auth');
const audit = require('../lib/audit');

function makeToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

router.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    const field = username ? 'username' : 'email';
    const value = username || email;

    const { rows } = await db.query(
      `SELECT * FROM users WHERE ${field} = $1 AND deleted_at IS NULL`,
      [value]
    );
    const user = rows[0];

    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const { rows: perms } = await db.query(
      'SELECT tool, enabled FROM user_permissions WHERE user_id = $1',
      [user.id]
    );
    const permissions = Object.fromEntries(perms.map(p => [p.tool, p.enabled]));

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
    res.json({ ...rows[0], perms: Object.fromEntries(perms.map(p => [p.tool, p.enabled])) });
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', requireAuth, validate(changePasswordSchema), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const { rows } = await db.query(
      'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(newPassword, 10);
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

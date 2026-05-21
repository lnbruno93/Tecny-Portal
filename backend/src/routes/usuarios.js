const router = require('express').Router();
const bcrypt = require('bcrypt');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { createUsuarioSchema, updateUsuarioSchema } = require('../schemas/usuarios');

const TOOLS = ['cotizador','financiera','cajas','envios','usuarios'];

router.use(requireAuth, adminOnly);

router.get('/', async (_req, res, next) => {
  try {
    const { rows: users } = await db.query(
      'SELECT id, nombre, username, email, role, created_at FROM users WHERE deleted_at IS NULL ORDER BY nombre LIMIT 200'
    );
    const { rows: perms } = await db.query(
      'SELECT user_id, tool, enabled FROM user_permissions WHERE user_id = ANY($1)',
      [users.map(u => u.id)]
    );
    const permMap = {};
    perms.forEach(p => {
      if (!permMap[p.user_id]) permMap[p.user_id] = {};
      permMap[p.user_id][p.tool] = p.enabled;
    });
    res.json(users.map(u => ({ ...u, perms: permMap[u.id] || {} })));
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(createUsuarioSchema), async (req, res, next) => {
  try {
    const { nombre, username, email, password, role, perms } = req.body;
    const hash = await bcrypt.hash(password, 10);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'INSERT INTO users (nombre, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, nombre, username, email, role',
        [nombre, username, email ?? null, hash, role]
      );
      const user = rows[0];

      for (const tool of TOOLS) {
        await client.query(
          'INSERT INTO user_permissions (user_id, tool, enabled) VALUES ($1,$2,$3)',
          [user.id, tool, perms[tool] === true]
        );
      }
      await client.query('COMMIT');
      await audit('users', 'INSERT', user.id, { despues: user, user_id: req.user.id });
      res.status(201).json({ ...user, perms });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username o email ya en uso' });
    next(err);
  }
});

router.put('/:id', validate(updateUsuarioSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows: before } = await db.query(
      'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!before[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { nombre, username, email, password, role, perms } = req.body;
    const hash = password ? await bcrypt.hash(password, 10) : null;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE users SET
          nombre        = COALESCE($1, nombre),
          username      = COALESCE($2, username),
          email         = COALESCE($3, email),
          password_hash = COALESCE($4, password_hash),
          role          = COALESCE($5, role)
        WHERE id = $6 RETURNING id, nombre, username, email, role`,
        [nombre, username, email, hash, role, id]
      );

      if (perms !== undefined) {
        for (const tool of TOOLS) {
          await client.query(
            `INSERT INTO user_permissions (user_id, tool, enabled) VALUES ($1,$2,$3)
             ON CONFLICT (user_id, tool) DO UPDATE SET enabled = $3`,
            [id, tool, perms[tool] === true]
          );
        }
      }
      await client.query('COMMIT');
      await audit('users', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
      res.json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username o email ya en uso' });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    if (id === req.user.id) {
      return res.status(400).json({ error: 'No podés eliminar tu propia cuenta' });
    }
    const { rows } = await db.query(
      'UPDATE users SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    await audit('users', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

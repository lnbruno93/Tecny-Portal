const router = require('express').Router();
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const db = require('../config/database');
const adminOnly = require('../middleware/adminOnly');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { createUsuarioSchema, updateUsuarioSchema } = require('../schemas/usuarios');
const { TOOLS } = require('../lib/tools');

const BCRYPT_ROUNDS = 12;

// requireAuth aplicado en app.js al montar /api/usuarios
router.use(adminOnly);

router.get('/', async (req, res, next) => {
  try {
    const { users, perms } = await db.withTenant(req.tenantId, async (client) => {
      const { rows: users } = await client.query(
        'SELECT id, nombre, username, email, role, created_at FROM users WHERE deleted_at IS NULL ORDER BY nombre LIMIT 200'
      );
      const { rows: perms } = await client.query(
        'SELECT user_id, tool, enabled FROM user_permissions WHERE user_id = ANY($1)',
        [users.map(u => u.id)]
      );
      return { users, perms };
    });
    const permMap = {};
    perms.forEach(p => {
      if (!permMap[p.user_id]) permMap[p.user_id] = {};
      permMap[p.user_id][p.tool] = p.enabled;
    });
    // Garantizar que todos los tools aparezcan (false si falta la fila en DB)
    const defaultPerms = Object.fromEntries(TOOLS.map(t => [t, false]));
    res.json(users.map(u => ({ ...u, perms: { ...defaultPerms, ...(permMap[u.id] || {}) } })));
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(createUsuarioSchema), async (req, res, next) => {
  try {
    const { nombre, username, email, password, role, perms } = req.body;
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // 2026-06-16 TANDA 1: email es NOT NULL. Si el admin no lo provee (flow
    // legacy donde el user no tiene email todavía), generamos un placeholder
    // único `user_<id>@placeholder.local` alineado con el backfill de la
    // migration 20260616000003. Como no tenemos el id hasta después del
    // INSERT, primero usamos un placeholder UUID-based para el INSERT, y
    // después UPDATE al patrón final. Todo dentro de la misma tx — atómico.
    const adminCreatedWithoutEmail = !email;
    const insertEmail = email || `temp_${randomUUID()}@placeholder.local`;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
      const { rows } = await client.query(
        'INSERT INTO users (nombre, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, nombre, username, email, role',
        [nombre, username, insertEmail, hash, role]
      );
      const user = rows[0];

      if (adminCreatedWithoutEmail) {
        const finalEmail = `user_${user.id}@placeholder.local`;
        await client.query('UPDATE users SET email = $1 WHERE id = $2', [finalEmail, user.id]);
        user.email = finalEmail;
      }

      // Un solo INSERT multi-row en lugar de 5 queries secuenciales
      const permValues = TOOLS.map((tool, i) => `($1, $${i + 2}, $${i + 2 + TOOLS.length})`).join(', ');
      await client.query(
        `INSERT INTO user_permissions (user_id, tool, enabled) VALUES ${permValues}`,
        [user.id, ...TOOLS, ...TOOLS.map(t => perms[t] === true)]
      );
      // Audit-in-tx (auditoría 2026-06-06 Sol M2) — antes corría en pool
      // global después del COMMIT, dejando ventana para que el proceso muera
      // entre commit y audit, perdiendo la traza.
      await audit(client, 'users', 'INSERT', user.id, { despues: user, user_id: req.user.id });
      await client.query('COMMIT');
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

    const { rows: before } = await db.withTenant(req.tenantId, async (client) => {
      return await client.query(
        'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]
      );
    });
    if (!before[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { nombre, username, email, password, role, perms, twofa_code } = req.body;
    const hash = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : null;

    // 2026-06-11 SE-08: si el admin está cambiando password / role / perms de
    // OTRO user (no de sí mismo), exigir re-auth 2FA del admin. Esto cierra
    // el path de privilege escalation con token robado: aunque el atacante
    // tenga el JWT del admin, sin su TOTP no puede cambiar perms de otros.
    const isSensitiveChange = (hash !== null || role !== undefined || perms !== undefined);
    const isOtherUser = id !== req.user.id;
    if (isSensitiveChange && isOtherUser) {
      const { load2fa, verifyAndConsume } = require('./twoFa');
      const twoFa = await load2fa(req.user.id);
      if (twoFa && twoFa.enabled_at) {
        if (!twofa_code) {
          return res.status(401).json({
            error: 'Se requiere código 2FA para cambiar credenciales de otro usuario.',
            twofa_required: true,
          });
        }
        const { ok } = await verifyAndConsume(req.user.id, String(twofa_code));
        if (!ok) {
          return res.status(401).json({ error: 'Código 2FA incorrecto.' });
        }
      }
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
      // H3 auditoría 2026-06: si el admin cambia la password (`hash` no null),
      // bumpear también `password_changed_at = NOW()`. El middleware de auth
      // compara `jwt.iat_ms` con `password_changed_at` y rechaza tokens viejos
      // — así los tokens activos de la víctima quedan invalidados
      // inmediatamente. Sin este bump, un atacante con un JWT robado seguía
      // autenticado aunque el admin reseteara la password.
      //
      // 2026-06-11 P-02: también bumpeamos cuando cambian `role` o `perms` —
      // ahora ambos viajan en el JWT (perms en el payload, role siempre estuvo)
      // y el token cacheado en el cliente quedaría stale. Forzar re-login = el
      // user recibe un JWT nuevo con perms actualizadas en el siguiente login.
      const bumpPwChanged = (hash !== null) || (role !== undefined) || (perms !== undefined);
      const { rows } = await client.query(
        `UPDATE users SET
          nombre               = COALESCE($1, nombre),
          username             = COALESCE($2, username),
          email                = COALESCE($3, email),
          password_hash        = COALESCE($4, password_hash),
          role                 = COALESCE($5, role),
          password_changed_at  = CASE WHEN $6 THEN NOW() ELSE password_changed_at END
        WHERE id = $7 RETURNING id, nombre, username, email, role`,
        [nombre, username, email, hash, role, bumpPwChanged, id]
      );

      let permsAntes = null;
      if (perms !== undefined) {
        // Guardar permisos anteriores para el audit
        const { rows: permsBefore } = await client.query(
          'SELECT tool, enabled FROM user_permissions WHERE user_id = $1',
          [id]
        );
        permsAntes = Object.fromEntries(permsBefore.map(p => [p.tool, p.enabled]));

        // Un solo UPSERT multi-row en lugar de 5 queries secuenciales
        const upsertValues = TOOLS.map((tool, i) => `($1, $${i + 2}, $${i + 2 + TOOLS.length})`).join(', ');
        await client.query(
          `INSERT INTO user_permissions (user_id, tool, enabled) VALUES ${upsertValues}
           ON CONFLICT (user_id, tool) DO UPDATE SET enabled = EXCLUDED.enabled`,
          [id, ...TOOLS, ...TOOLS.map(t => perms[t] === true)]
        );
      }
      // Audit-in-tx (auditoría 2026-06-06 Sol M2) — antes corría en pool
      // global después del COMMIT.
      // Excluir password_hash del audit log — es un hash pero no debe persistirse innecesariamente
      const { password_hash: _phAntes, ...safeAntes } = before[0];
      await audit(client, 'users', 'UPDATE', id, {
        antes:   { ...safeAntes, perms: permsAntes },
        despues: { ...rows[0],  perms: perms ?? permsAntes },
        user_id: req.user.id,
      });
      await client.query('COMMIT');
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
    // 2026-06-10 S-02: bumpeamos password_changed_at al soft-delete para invalidar
    // de inmediato cualquier JWT vigente del usuario eliminado (auth middleware
    // compara con `iat_ms`). Sin esto, el token sigue válido hasta 8h (default
    // post SE-01) aunque el filtro `deleted_at IS NULL` del middleware lo bloquee.
    // Defense-in-depth: fail-closed contra DB hiccups o réplica lag.
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE users
            SET deleted_at = NOW(), password_changed_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING *`,
        [id]
      );
      if (rows[0]) {
        const { password_hash: _ph, ...safeUser } = rows[0];
        await audit(client, 'users', 'DELETE', id, { antes: safeUser, user_id: req.user.id });
      }
      return rows;
    });
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

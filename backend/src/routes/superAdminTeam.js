/**
 * Super-Admin Team routes — invitar co-super-admins al back office (#499).
 *
 * Mountado en app.js:
 *   app.use('/api/super-admin/team', require('./routes/superAdminTeam'));
 *
 * Todos los endpoints requieren `requireAuth` + `requireSuperAdmin` — el
 * caller es un super-admin actual (con 2FA activa, gate S-25) que quiere
 * gestionar el team de super-admins.
 *
 * Endpoints:
 *   GET    /                       — lista super-admins activos + invites pendientes
 *   POST   /invite                 — crea invite + envía email
 *   DELETE /invite/:id             — revoca invite pendiente
 *   POST   /invite/:id/resend      — regenera token + reenvía email
 *   POST   /revoke/:userId         — quita is_super_admin al user (con guardas)
 *
 * Diseño:
 *   - Todas las queries pasan por `db.adminQuery()` (BYPASSRLS). super_admin_invites
 *     no tiene RLS (ver comment de la migration), y necesitamos leer `users`
 *     cross-tenant para listar super-admins. Mismo pattern que routes/superAdmin.js.
 *   - Token: 32 bytes crypto.randomBytes → base64url (43 chars). Se envía en
 *     el email; en DB guardamos SHA-256 (BYTEA). Nunca hay plaintext en DB.
 *   - Audit trail: cada acción escribe a `tenant_admin_actions` con
 *     tenant_id=1 (anchor del super-admin, igual pattern que plan_price_change,
 *     tc_default_pais_updated). Actions nuevas requieren migration de CHECK
 *     extendido; usamos SAVEPOINT pattern (PR-C B4 #462) por si la migration
 *     no corrió aún en staging.
 *   - Guarda "último super-admin": el POST /revoke/:userId cuenta super-admins
 *     activos y rechaza si sería 0 — evita lock-out total del back office.
 *   - Cache invalidation: al revocar super-admin, invalidamos userAuthCache
 *     del user afectado para que el middleware requireSuperAdmin lo rechace
 *     en la próxima request (sin esperar TTL 60s).
 */

const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { z } = require('zod');

const db = require('../config/database');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const validate = require('../lib/validate');
const parseId = require('../lib/parseId');
const logger = require('../lib/logger');
const userAuthCache = require('../lib/userAuthCache');
const {
  sendSuperAdminInviteEmail,
  adminFrontendUrl,
} = require('../lib/superAdminInviteEmail');

// Todos los endpoints requieren super-admin.
router.use(requireSuperAdmin);

// ──────────────────────────────────────────────────────────────────────────
// Constantes y helpers
// ──────────────────────────────────────────────────────────────────────────

// TTL del invite. 48h da margen razonable al invitado para abrir el email
// sin presión, corto suficiente para limitar window de abuso si el email
// leakea. Mismo orden de magnitud que el reset-password (1h) pero más
// generoso porque el invite es opt-in del receptor, no urgencia del user.
const INVITE_TTL_HOURS = 48;

// Bcrypt cost — mismo que routes/auth.js. 12 rounds = resistencia razonable
// a cracking offline con costo despreciable en el accept-flow.
const BCRYPT_ROUNDS = 12;

// tenant_id del audit log. Tecny = 1. Ver rationale en migration
// 20260622153000_plan_prices_table.js.
const AUDIT_TENANT_ID = 1;

// Zod schema para POST /invite.
// email: normalizado a lowercase para hash-index consistency (users.email tiene
// UNIQUE LOWER(email); dejamos ambos lados equivalentes).
// nombre: 1-100 chars. El HTML del email usa _esc() para XSS defense-in-depth,
// pero acortamos igual a 100 para prevenir emails con nombres absurdos.
const inviteSchema = z.object({
  email:  z.string().trim().toLowerCase().email('Email inválido').max(254),
  nombre: z.string().trim().min(1, 'Nombre requerido').max(100, 'Nombre muy largo'),
}).strict();

// Zod schema para POST /:token/accept del router público (SIN auth). Vive
// acá para reusarlo desde publicSuperAdminInvite.js — mantiene la
// validación de password co-localizada con el resto de la lógica de invite.
// passwordField del portal usa min 8 + letter + number.
//
// hcaptcha_response (2026-07-12 auditoría TOTAL Externa P1-1 follow-up):
// token del widget del cliente. Opcional a nivel schema — el gate real vive
// en el handler, que corre verifyCaptcha (fail-closed en prod si el token
// falta o es inválido; bypass en dev/test). max 10_000 defensivo por si el
// widget alguna vez emite tokens largos, para no dejar entrar payloads de MB.
const { passwordField } = require('../lib/password');
const acceptSchema = z.object({
  password:          passwordField(),
  hcaptcha_response: z.string().trim().max(10_000).optional(),
}).strict();

/**
 * Escribe una fila al audit trail dentro de la tx actual. Idéntico patrón
 * que `insertAdminAction` de routes/superAdmin.js (duplicado adrede para
 * mantener este archivo standalone; extraer a lib/adminAudit.js queda como
 * follow-up si sumamos un 3er caller).
 */
async function insertAudit(client, { tenantId, superAdminUserId, action, beforeState, afterState, reason }) {
  await client.query(
    `INSERT INTO tenant_admin_actions
       (tenant_id, super_admin_user_id, action, before_state, after_state, reason)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [
      tenantId,
      superAdminUserId,
      action,
      beforeState ? JSON.stringify(beforeState) : null,
      afterState  ? JSON.stringify(afterState)  : null,
      reason || null,
    ]
  );
}

/**
 * Genera token + hash. El plaintext se manda por email; el hash se guarda
 * en DB (BYTEA). Comparación en lookup: hash(input) === row.token_hash.
 */
function generateInviteToken() {
  const plaintext = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(plaintext).digest();
  return { plaintext, hash };
}

/**
 * Genera un username único derivado del email (parte antes del @). Si hay
 * conflicto agrega sufijo _2, _3, … Mantiene el mismo patrón que
 * routes/superAdmin.js (funciones deriveUsername + uniqueUsername).
 * Deliberadamente duplicado — el file es standalone y no queríamos crear
 * un lib/deriveUsername.js con 2 funciones triviales.
 */
function deriveUsername(email) {
  const local = String(email).split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return local.length >= 2 ? local : 'user';
}
async function uniqueUsername(client, base) {
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : `${base}_${n + 1}`;
    const { rows } = await client.query(
      'SELECT 1 FROM users WHERE username = $1 AND deleted_at IS NULL', [candidate]
    );
    if (rows.length === 0) return candidate;
  }
  throw new Error('No se pudo generar un username único después de 100 intentos');
}

/**
 * Wrapper del audit con SAVEPOINT para tolerar CHECK constraint desactualizado
 * en el CI/staging (mismo patrón que routes/superAdmin.js:2295 para el
 * `tenant_pais_changed` en #473). Si la action nueva todavía no está en el
 * CHECK, logeamos warn y seguimos. En prod post-migration, el CHECK acepta
 * la action y este path nunca dispara el catch.
 */
async function tryAuditWithSavepoint(client, args, actionLabel) {
  await client.query('SAVEPOINT sp_audit');
  try {
    await insertAudit(client, args);
    await client.query('RELEASE SAVEPOINT sp_audit');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT sp_audit').catch(() => {});
    if (err.code === '23514') {
      logger.warn(
        { action: actionLabel, err: err.message },
        '[super-admin/team #499] audit action no permitida por CHECK — migration pendiente? (continuando)'
      );
    } else {
      throw err;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// GET /  — lista super-admins activos + invites pendientes
// ──────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const result = await db.adminQuery(async (client) => {
      // 1) Super-admins activos. LEFT JOIN a user_2fa para saber si tienen
      //    2FA activada (el flag enabled_at NOT NULL). Los que no la tienen
      //    NO pueden entrar al back office (guard S-25 los bloquea).
      //    `created_at` como proxy de "cuándo se activó" — la tabla `users`
      //    NO tiene `last_login_at` today. Si lo agregamos en el futuro,
      //    lo sustituimos acá para mejor UX.
      const { rows: admins } = await client.query(`
        SELECT
          u.id, u.username, u.email, u.nombre,
          (f.enabled_at IS NOT NULL) AS twofa_enabled,
          u.created_at
        FROM users u
        LEFT JOIN user_2fa f ON f.user_id = u.id
        WHERE u.is_super_admin = true AND u.deleted_at IS NULL
        ORDER BY u.id
      `);

      // 2) Invites pendientes (no aceptadas, no revocadas, no expiradas).
      //    JOIN con users para hidratar el username del invitador.
      const { rows: invites } = await client.query(`
        SELECT
          i.id, i.email, i.nombre,
          i.invited_by, u.username AS invited_by_username,
          i.invited_at, i.expires_at
        FROM super_admin_invites i
        JOIN users u ON u.id = i.invited_by
        WHERE i.accepted_at IS NULL
          AND i.revoked_at IS NULL
          AND i.expires_at > NOW()
        ORDER BY i.invited_at DESC
      `);

      return { admins, invites };
    });

    // Post-process: marcar `is_you` para el super-admin caller. El frontend
    // usa esto para deshabilitar el botón "Revocar" en la fila del propio user.
    const super_admins = result.admins.map((a) => ({
      ...a,
      is_you: a.id === req.user.id,
    }));

    res.json({
      super_admins,
      pending_invites: result.invites,
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /invite — crea invite + envía email
// ──────────────────────────────────────────────────────────────────────────
router.post('/invite', validate(inviteSchema), async (req, res, next) => {
  try {
    const { email, nombre } = req.body;

    // 1) Guardas de precondición (ANTES de la tx — barato):
    //    (a) email no puede pertenecer a un super-admin activo ya.
    //    (b) email no puede tener una invite pendiente vigente.
    const dupChecks = await db.adminQuery(async (client) => {
      const { rows: existingAdmin } = await client.query(
        `SELECT id FROM users
          WHERE LOWER(email) = LOWER($1)
            AND is_super_admin = true
            AND deleted_at IS NULL
          LIMIT 1`,
        [email]
      );
      const { rows: pendingInv } = await client.query(
        `SELECT id FROM super_admin_invites
          WHERE LOWER(email) = LOWER($1)
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > NOW()
          LIMIT 1`,
        [email]
      );
      return {
        existingAdmin: existingAdmin[0] || null,
        pendingInv:    pendingInv[0]    || null,
      };
    });

    if (dupChecks.existingAdmin) {
      return res.status(409).json({
        error: 'Ese email ya es super-admin activo.',
        code:  'already_super_admin',
      });
    }
    if (dupChecks.pendingInv) {
      return res.status(409).json({
        error: 'Ya hay una invitación pendiente para ese email. Podés reenviarla o revocarla.',
        code:  'pending_invite_exists',
      });
    }

    // 2) Crear la invite en tx + audit.
    const { plaintext, hash } = generateInviteToken();
    const invitedAt = new Date();
    const expiresAt = new Date(invitedAt.getTime() + INVITE_TTL_HOURS * 60 * 60 * 1000);

    const invite = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const { rows } = await client.query(
          `INSERT INTO super_admin_invites
             (email, nombre, token_hash, invited_by, invited_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, email, nombre, invited_by, invited_at, expires_at`,
          [email, nombre, hash, req.user.id, invitedAt, expiresAt]
        );

        await tryAuditWithSavepoint(client, {
          tenantId: AUDIT_TENANT_ID,
          superAdminUserId: req.user.id,
          action: 'super_admin_invited',
          beforeState: null,
          afterState:  { email, nombre, invite_id: rows[0].id, expires_at: expiresAt },
          reason: null,
        }, 'super_admin_invited');

        await client.query('COMMIT');
        return rows[0];
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
        throw err;
      }
    });

    // 3) Enviar email fire-and-forget-ish — awaiteamos para poder responder
    //    con `email_sent: false` si falla, pero NO abortamos el 201: la
    //    invite ya está persistida, el super-admin puede reintentar con
    //    /invite/:id/resend.
    const acceptUrl = `${adminFrontendUrl()}/aceptar-invitacion?token=${plaintext}`;
    const emailResult = await sendSuperAdminInviteEmail({
      to:        email,
      nombre,
      invitedBy: req.user.username,
      acceptUrl,
    }).catch((err) => {
      logger.error({ err, invite_id: invite.id }, '[super-admin/team] fallo envío de invite (unexpected throw)');
      return { ok: false, error: err.message };
    });

    if (!emailResult.ok) {
      logger.warn({ invite_id: invite.id, error: emailResult.error }, '[super-admin/team] email no enviado (invite persistida)');
    }

    // Response 201 SIN el token plaintext — nunca vuelve al frontend, solo
    // viaja en el email.
    res.status(201).json({
      invite: {
        id:         invite.id,
        email:      invite.email,
        nombre:     invite.nombre,
        invited_by: invite.invited_by,
        invited_at: invite.invited_at,
        expires_at: invite.expires_at,
      },
      email_sent: emailResult.ok,
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// DELETE /invite/:id — revoca invite pendiente
// ──────────────────────────────────────────────────────────────────────────
router.delete('/invite/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }

    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // Buscar invite pending (no aceptada, no revocada — expirada la
        // aceptamos para revocar "por las dudas").
        const { rows: before } = await client.query(
          `SELECT id, email, accepted_at, revoked_at
             FROM super_admin_invites
            WHERE id = $1
            FOR UPDATE`,
          [id]
        );
        if (!before[0]) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        if (before[0].accepted_at) {
          await client.query('ROLLBACK');
          return { alreadyAccepted: true };
        }
        if (before[0].revoked_at) {
          await client.query('ROLLBACK');
          return { alreadyRevoked: true, email: before[0].email };
        }

        const { rows: updated } = await client.query(
          `UPDATE super_admin_invites
              SET revoked_at = NOW()
            WHERE id = $1
            RETURNING id, email, revoked_at`,
          [id]
        );

        await tryAuditWithSavepoint(client, {
          tenantId: AUDIT_TENANT_ID,
          superAdminUserId: req.user.id,
          action: 'super_admin_invite_revoked',
          beforeState: { invite_id: id, email: before[0].email },
          afterState:  { revoked_at: updated[0].revoked_at },
          reason: null,
        }, 'super_admin_invite_revoked');

        await client.query('COMMIT');
        return { ok: true, invite: updated[0] };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
        throw err;
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'Invitación no encontrada' });
    }
    if (result.alreadyAccepted) {
      return res.status(409).json({
        error: 'La invitación ya fue aceptada. Revocá el super-admin directo desde el listado.',
        code:  'invite_already_accepted',
      });
    }
    if (result.alreadyRevoked) {
      // Idempotente: 200 con flag, no error.
      return res.json({ ok: true, alreadyRevoked: true, email: result.email });
    }

    res.json({ ok: true, invite: result.invite });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /invite/:id/resend — regenera token y reenvía email
// ──────────────────────────────────────────────────────────────────────────
router.post('/invite/:id/resend', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }

    const { plaintext, hash } = generateInviteToken();
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + INVITE_TTL_HOURS * 60 * 60 * 1000);

    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const { rows: before } = await client.query(
          `SELECT id, email, nombre, accepted_at, revoked_at, expires_at
             FROM super_admin_invites
            WHERE id = $1
            FOR UPDATE`,
          [id]
        );
        if (!before[0]) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        if (before[0].accepted_at) {
          await client.query('ROLLBACK');
          return { alreadyAccepted: true };
        }
        if (before[0].revoked_at) {
          await client.query('ROLLBACK');
          return { revoked: true };
        }

        // Regenerar token + expires_at. El token anterior queda invalidado
        // (el hash cambia, así que lookups con el plaintext viejo fallan).
        const { rows: updated } = await client.query(
          `UPDATE super_admin_invites
              SET token_hash = $1,
                  expires_at = $2,
                  invited_at = NOW()
            WHERE id = $3
            RETURNING id, email, nombre, invited_by, invited_at, expires_at`,
          [hash, newExpiresAt, id]
        );

        await tryAuditWithSavepoint(client, {
          tenantId: AUDIT_TENANT_ID,
          superAdminUserId: req.user.id,
          action: 'super_admin_invite_resent',
          beforeState: { expires_at: before[0].expires_at },
          afterState:  { expires_at: newExpiresAt, invite_id: id },
          reason: null,
        }, 'super_admin_invite_resent');

        await client.query('COMMIT');
        return { ok: true, invite: updated[0] };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
        throw err;
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'Invitación no encontrada' });
    }
    if (result.alreadyAccepted) {
      return res.status(409).json({
        error: 'Esta invitación ya fue aceptada.',
        code:  'invite_already_accepted',
      });
    }
    if (result.revoked) {
      return res.status(409).json({
        error: 'Esta invitación fue revocada. Creá una nueva.',
        code:  'invite_revoked',
      });
    }

    const acceptUrl = `${adminFrontendUrl()}/aceptar-invitacion?token=${plaintext}`;
    const emailResult = await sendSuperAdminInviteEmail({
      to:        result.invite.email,
      nombre:    result.invite.nombre,
      invitedBy: req.user.username,
      acceptUrl,
    }).catch((err) => {
      logger.error({ err, invite_id: id }, '[super-admin/team] fallo reenvío invite (unexpected throw)');
      return { ok: false, error: err.message };
    });

    res.json({
      ok:         true,
      invite:     result.invite,
      email_sent: emailResult.ok,
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /revoke/:userId — quita is_super_admin al user especificado
// ──────────────────────────────────────────────────────────────────────────
router.post('/revoke/:userId', async (req, res, next) => {
  try {
    const userId = parseId(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'userId inválido' });
    }

    // Guarda: no podés revocarte a vos mismo — obligamos a que sea otro
    // super-admin quien lo haga. Evita lock-out involuntario cuando hay
    // solo un super-admin activo.
    if (userId === req.user.id) {
      return res.status(400).json({
        error: 'No podés revocarte a vos mismo. Otro super-admin debe hacerlo.',
        code:  'self_revoke_forbidden',
      });
    }

    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // Buscar el user + verificar que es super-admin activo.
        const { rows: user } = await client.query(
          `SELECT id, username, email, is_super_admin
             FROM users
            WHERE id = $1 AND deleted_at IS NULL
            FOR UPDATE`,
          [userId]
        );
        if (!user[0]) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        if (!user[0].is_super_admin) {
          await client.query('ROLLBACK');
          return { notSuperAdmin: true };
        }

        // Guarda hard: al menos 1 super-admin activo debe quedar después
        // del revoke. Contamos ANTES de aplicar (con FOR SHARE queda el lock
        // hasta el COMMIT — otra tx que quiera revocar en paralelo espera).
        //
        // 2026-07-01 defensa multi-instance: sin este count-and-check en la
        // misma tx, dos super-admins en réplicas distintas podrían revocarse
        // "el uno al otro" simultáneamente y dejar 0 super-admins. Row lock
        // en la fila del target + count fresco dentro de la tx cierra la
        // ventana.
        const { rows: countRows } = await client.query(
          `SELECT COUNT(*)::int AS n
             FROM users
            WHERE is_super_admin = true AND deleted_at IS NULL`
        );
        if ((countRows[0]?.n ?? 0) <= 1) {
          await client.query('ROLLBACK');
          return { lastAdmin: true };
        }

        // 2026-07-12 (auditoría TOTAL Auth P1-2): bumpear password_changed_at
        // junto con is_super_admin=false. Sin esto, el JWT actual del user
        // revocado sigue teniendo `is_super_admin: true` en el payload hasta
        // que expire (default 8h). El middleware requireSuperAdmin re-valida
        // contra userAuthCache/DB, entonces el is_super_admin=false ya toma
        // efecto — PERO tenemos una ventana de 60s (TTL del cache) donde
        // decisions cliente (redirects a /admin) y logs de auditoría podrían
        // reflejar el estado stale. Bumpear password_changed_at es la señal
        // canónica para invalidar TODOS los JWT del user afectado en
        // TODAS las instancias (el chequeo password_changed_at vs iat_ms es
        // cross-instance). El user afectado hace re-login en el próximo
        // request. Costo: nada — es una columna que ya existe con este
        // propósito exacto (invalidar sesiones al cambiar password / caps /
        // is_super_admin).
        const { rows: updated } = await client.query(
          `UPDATE users
              SET is_super_admin = false,
                  password_changed_at = NOW()
            WHERE id = $1
            RETURNING id, username, email`,
          [userId]
        );

        await tryAuditWithSavepoint(client, {
          tenantId: AUDIT_TENANT_ID,
          superAdminUserId: req.user.id,
          action: 'super_admin_revoked',
          beforeState: { user_id: userId, is_super_admin: true },
          afterState:  { user_id: userId, is_super_admin: false },
          reason: null,
        }, 'super_admin_revoked');

        await client.query('COMMIT');
        return { ok: true, user: updated[0] };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
        throw err;
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    if (result.notSuperAdmin) {
      return res.status(409).json({
        error: 'Ese usuario no es super-admin activo.',
        code:  'not_super_admin',
      });
    }
    if (result.lastAdmin) {
      return res.status(400).json({
        error: 'No se puede revocar el último super-admin activo. Invitá a otro primero.',
        code:  'last_super_admin',
      });
    }

    // Cache invalidation: el userAuthCache tiene is_super_admin cacheado por
    // 60s. Sin invalidar, el user afectado podría seguir teniendo acceso a
    // /api/super-admin/* con su JWT actual hasta que expire el cache.
    // Best-effort (Redis puede fallar; el TTL 60s se hace cargo si el del
    // acá falla).
    try {
      await userAuthCache.invalidateUserAuth(userId);
    } catch (err) {
      logger.warn({ err: err.message, userId }, '[super-admin/team] invalidateUserAuth falló — TTL 60s se hará cargo');
    }

    res.json({ ok: true, user: result.user });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// Exportamos el schema de acceptación para reusarlo desde el router público
// sin duplicar la definición.
module.exports.acceptSchema = acceptSchema;

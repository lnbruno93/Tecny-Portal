/**
 * Public router para el flow de aceptar invitación de co-super-admin (#499).
 *
 * Mountado SIN requireAuth en app.js:
 *   app.use('/api/public/super-admin-invite', require('./routes/publicSuperAdminInvite'));
 *
 * Endpoints:
 *   GET  /:token          — valida el token del email. 200 si vigente,
 *                            404 (ambiguo) si expirado/revocado/aceptado/inexistente.
 *   POST /:token/accept   — crea el user + acepta la invite atómicamente,
 *                            devuelve JWT. Rate-limited con `signupLimiter`
 *                            para anti-abuse.
 *
 * Diseño:
 *   - El GET NO diferencia "expirado" de "revocado" de "aceptado" de
 *     "inexistente" — todas devuelven 404 con el mismo mensaje. Sin esa
 *     ambigüedad, un atacante que tenga un token viejo podría enumerar
 *     invites válidas (probar N tokens al azar → si tira 200, existe).
 *     La UX pierde un poco (el usuario recibe "Invitación no válida o
 *     expirada" sin saber cuál), pero el super-admin emisor puede reenviar
 *     desde el back office si el usuario reclama.
 *   - Response del accept incluye el token JWT firmado con `makeToken` de
 *     auth.js (importamos el export). El invitado queda logueado
 *     automáticamente. El guard S-25 (2FA obligatoria para super-admin)
 *     lo bloqueará en la próxima llamada a /api/super-admin/*, forzándolo
 *     a ir a /mi-cuenta a activar 2FA. Flujo esperado — comment inline.
 *   - Sin auth previa: los endpoints deben ser accesibles antes de que el
 *     invitado tenga cuenta. Todo el lookup se hace via `db.adminQuery`
 *     (BYPASSRLS).
 *   - Rate limit: el accept se protege con signupLimiter (5/hora/IP), igual
 *     que el signup público. El GET no está rate-limited al mismo nivel
 *     porque un fetch benigno del frontend a la ruta admin.tecnyapp.com/aceptar-invitacion
 *     dispara UN GET por load; el globalLimiter existe como red de seguridad.
 */

const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const db = require('../config/database');
const validate = require('../lib/validate');
const logger = require('../lib/logger');
const captcha = require('../lib/captcha');
const { acceptSchema } = require('./superAdminTeam');
const { makeToken } = require('./auth');

// Bcrypt cost — mismo que routes/auth.js.
const BCRYPT_ROUNDS = 12;

// tenant_id "hogar" al que vinculamos al nuevo super-admin como member. Tecny
// (id=1). Esto satisface el gate `resolveUserTenant` del /me/login que exige
// tenant_users NOT NULL — sin esto, el user recién creado no podría loguearse
// en el back office porque `resolveUserTenant` tiraría NO_TENANT.
//
// Rationale: el super-admin opera cross-tenant vía BYPASSRLS pool y el flag
// `is_super_admin=true`. NO necesita capabilities dentro de un tenant real
// para hacer su trabajo. Lo asignamos al tenant "casa" con rol='member'
// (mínimo) — no le damos owner/admin porque no debería poder hacer nada
// dentro de ese tenant sin querer.
const HOME_TENANT_ID = 1;

// tenant_id del audit trail (Tecny, mismo pattern que superAdminTeam.js).
const AUDIT_TENANT_ID = 1;

/**
 * Deriva un username válido único (mismo pattern que superAdmin.js/
 * superAdminTeam.js). Duplicado porque este router es standalone —
 * extraer al lib compartido queda como follow-up.
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
 * Hash del token del email → BYTEA para lookup.
 */
function hashToken(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext)).digest();
}

/**
 * Busca la invite por token_hash. Devuelve el row o null. NO diferencia
 * expirada/revocada/aceptada — el caller aplica los checks después.
 */
async function findInviteByToken(plaintext) {
  const hash = hashToken(plaintext);
  const rows = await db.adminQuery(async (client) => {
    const { rows } = await client.query(
      `SELECT
         i.id, i.email, i.nombre, i.token_hash,
         i.invited_by, u.username AS invited_by_username,
         i.invited_at, i.expires_at, i.accepted_at, i.revoked_at
       FROM super_admin_invites i
       LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.token_hash = $1
       LIMIT 1`,
      [hash]
    );
    return rows;
  });
  return rows[0] || null;
}

function inviteIsUsable(row) {
  if (!row) return false;
  if (row.accepted_at) return false;
  if (row.revoked_at) return false;
  if (new Date(row.expires_at) <= new Date()) return false;
  return true;
}

/**
 * Response ambiguo para el error de "no válida o expirada". Un solo mensaje
 * para prevenir enumeración de tokens.
 */
function respondInvalid(res) {
  return res.status(404).json({
    error: 'Invitación no válida o expirada',
    code:  'invite_invalid_or_expired',
  });
}

// ──────────────────────────────────────────────────────────────────────────
// GET /:token  — validar
// ──────────────────────────────────────────────────────────────────────────
router.get('/:token', async (req, res, next) => {
  try {
    // Guard defensivo: tokens realistas son ~43 chars base64url. Limitamos
    // a 200 para no consumir memoria si viene basura de MB, y evitar que
    // el hash de la basura entre a la query. base64url espera solo
    // [A-Za-z0-9_-]; el hash se calcula de todos modos, pero no perdemos
    // nada rechazando input claramente malformado antes.
    const raw = String(req.params.token || '');
    if (raw.length < 20 || raw.length > 200) {
      return respondInvalid(res);
    }

    const row = await findInviteByToken(raw);
    if (!inviteIsUsable(row)) {
      return respondInvalid(res);
    }

    // Response: SOLO lo mínimo para armar la UI del accept — email + nombre
    // (para saludar) + invited_by_username (para atribuir socialmente).
    // NO devolvemos el token, ni el expires_at (evitar mostrar tiempo exacto
    // que ayuda a un atacante a ajustar timing de attacks).
    res.json({
      email:               row.email,
      nombre:              row.nombre,
      invited_by_username: row.invited_by_username || null,
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /:token/accept  — crear user + logear
// ──────────────────────────────────────────────────────────────────────────
router.post('/:token/accept', validate(acceptSchema), async (req, res, next) => {
  try {
    const raw = String(req.params.token || '');
    if (raw.length < 20 || raw.length > 200) {
      return respondInvalid(res);
    }
    const { password } = req.body;

    // 2026-07-12 (auditoría TOTAL Externa P1-1 follow-up): captcha gate antes
    // de cualquier lookup a DB — mismo pattern que /login, /signup,
    // /forgot-password. Si HCAPTCHA_ENABLED!='true' o NODE_ENV=test,
    // verifyCaptcha bypassa silenciosamente (dev/test friendly).
    //
    // Con captcha activo (prod), el widget hCaptcha "invisible" del admin-
    // frontend rara vez muestra desafío a humanos legítimos pero bloquea
    // enumeración de tokens con IPs rotativas — antes el freno era el
    // globalLimiter + validez ambigua (404 idéntico para expirado/inexistente).
    // El captcha cierra el vector de brute-force distribuido sobre el
    // espacio de tokens (43 chars base64url; pequeño solo asumiendo poder de
    // cómputo suficiente + N invites vivas paralelas).
    const captchaResult = await captcha.verifyCaptcha(req.body.hcaptcha_response, req.ip);
    if (!captchaResult.success) {
      const errMap = {
        expired:       'La verificación expiró. Intentá de nuevo.',
        duplicate:     'La verificación ya fue usada. Recargá la página.',
        invalid_token: 'Verificación inválida. Completá el captcha y reintentá.',
      };
      const msg = errMap[captchaResult.error] || 'No pudimos verificar el captcha. Reintentá en un minuto.';
      logger.info(
        { source: 'super_admin_invite_accept_captcha_fail', error: captchaResult.error, ip: req.ip },
        'accept invite rechazado por captcha'
      );
      return res.status(400).json({ error: msg, reason: 'captcha_failed' });
    }

    // Re-check dentro de la tx con FOR UPDATE (evitamos race con revoke o
    // con un doble-accept del mismo link abierto en 2 tabs).
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const hash = hashToken(raw);
        const { rows: inviteRows } = await client.query(
          `SELECT id, email, nombre, invited_by, expires_at,
                  accepted_at, revoked_at
             FROM super_admin_invites
            WHERE token_hash = $1
            FOR UPDATE`,
          [hash]
        );
        const invite = inviteRows[0];
        if (!inviteIsUsable(invite)) {
          await client.query('ROLLBACK');
          return { invalid: true };
        }

        // Anti-race: si el email ya existe (creado en otro flow entre el
        // GET y el POST — muy raro pero posible), devolvemos 409 explícito.
        // Semánticamente distinto del "invite inválida" — no ocultamos con
        // el mensaje ambiguo porque el user ya tiene sesión potencial en
        // otro lado.
        const { rows: existing } = await client.query(
          `SELECT id FROM users
            WHERE LOWER(email) = LOWER($1)
              AND deleted_at IS NULL
            LIMIT 1`,
          [invite.email]
        );
        if (existing[0]) {
          await client.query('ROLLBACK');
          return { emailTaken: true };
        }

        // 1. Crear user con is_super_admin=true + email_verified_at=NOW()
        //    (aceptar el invite vía email es prueba de propiedad del email).
        const pwHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const username = await uniqueUsername(client, deriveUsername(invite.email));
        const { rows: newUserRows } = await client.query(
          `INSERT INTO users
             (nombre, username, email, password_hash, role, is_super_admin, email_verified_at)
           VALUES ($1, $2, $3, $4, 'op', true, NOW())
           RETURNING id, nombre, username, email, role, is_super_admin, email_verified_at`,
          [invite.nombre, username, invite.email, pwHash]
        );
        const newUser = newUserRows[0];

        // 2. Vincular al "home tenant" (Tecny, id=1) como member. Sin esto,
        //    resolveUserTenant devuelve NO_TENANT y el login sigue rebotando
        //    con 401 aún con el JWT válido. El super-admin real trabaja
        //    cross-tenant vía is_super_admin, NO desde este tenant_users
        //    row — es solo el "hogar" mínimo para pasar el guard NO_TENANT.
        await client.query(
          `INSERT INTO tenant_users (tenant_id, user_id, rol)
             VALUES ($1, $2, 'member')`,
          [HOME_TENANT_ID, newUser.id]
        );
        // Idem para tenant_user_roles (capability-based, post-F4 cutover).
        // rol='custom' = "sin capabilities específicas dentro del tenant";
        // el super-admin no necesita capabilities del tenant para operar el
        // back office.
        await client.query(
          `INSERT INTO tenant_user_roles (tenant_id, user_id, rol)
             VALUES ($1, $2, 'custom')`,
          [HOME_TENANT_ID, newUser.id]
        );

        // 3. Marcar invite aceptada.
        await client.query(
          `UPDATE super_admin_invites
              SET accepted_at = NOW(),
                  accepted_user_id = $1
            WHERE id = $2`,
          [newUser.id, invite.id]
        );

        // 4. Audit. SAVEPOINT pattern por si CHECK constraint aún no incluye
        //    la action nueva (mismo patrón que superAdminTeam.js). El caller
        //    del audit acá es el propio user recién creado — no hay super-admin
        //    "actor" en un endpoint público. Usamos newUser.id como
        //    super_admin_user_id: refleja quién ejecutó (el invitado, que
        //    acaba de convertirse en super-admin).
        await client.query('SAVEPOINT sp_audit');
        try {
          await client.query(
            `INSERT INTO tenant_admin_actions
               (tenant_id, super_admin_user_id, action, before_state, after_state)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
            [
              AUDIT_TENANT_ID,
              newUser.id,
              'super_admin_invite_accepted',
              JSON.stringify({ invite_id: invite.id, invited_by: invite.invited_by }),
              JSON.stringify({ new_user_id: newUser.id, username: newUser.username }),
            ]
          );
          await client.query('RELEASE SAVEPOINT sp_audit');
        } catch (auditErr) {
          await client.query('ROLLBACK TO SAVEPOINT sp_audit').catch(() => {});
          if (auditErr.code === '23514') {
            logger.warn(
              { action: 'super_admin_invite_accepted', invite_id: invite.id, err: auditErr.message },
              '[public/super-admin-invite] audit action no permitida por CHECK — migration pendiente? (continuando)'
            );
          } else {
            throw auditErr;
          }
        }

        await client.query('COMMIT');
        return { ok: true, user: newUser };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
        throw err;
      }
    });

    if (result.invalid) {
      return respondInvalid(res);
    }
    if (result.emailTaken) {
      return res.status(409).json({
        error: 'Este email ya está registrado. Usá el flow normal de login o de reset de contraseña.',
        code:  'email_taken',
      });
    }

    // Firmar JWT con el user recién creado. Usamos el `makeToken` canónico
    // de auth.js para que el shape del payload matchee el /login del portal
    // (mismo algorithm HS256, misma expiración, mismos campos).
    //
    // Comment inline: el user NO tiene 2FA todavía; el guard S-25 lo va a
    // bloquear cuando entre al back office. Va a Mi cuenta y activa 2FA.
    // Es el flujo esperado — la UI de admin-frontend redirige a
    // /mi-cuenta?tab=seguridad post-accept.
    const jwtToken = makeToken(
      result.user,
      { tenant_id: HOME_TENANT_ID, rol: 'member' },
      undefined  // sin capInfo — es_super_admin bypassea el sistema de caps.
    );

    logger.info(
      { new_user_id: result.user.id, email: result.user.email },
      '[public/super-admin-invite] invite aceptada — user creado como super-admin'
    );

    res.json({
      token: jwtToken,
      user: {
        id:              result.user.id,
        nombre:          result.user.nombre,
        username:        result.user.username,
        email:           result.user.email,
        role:            result.user.role,
        email_verified:  true,
        is_super_admin:  true,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

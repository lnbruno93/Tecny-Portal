/**
 * Signup público + verificación de email (TANDA 2.1).
 *
 * Endpoints (montados en /api/auth via app.js):
 *   - POST /signup              — público, signupLimiter, crea tenant+user+token
 *   - POST /verify-email        — público, consume token y marca user verificado
 *   - POST /resend-verification — requireAuth, genera token nuevo + envía email
 *
 * Decisiones durables (ver decisión #1-5 de TANDA 2):
 *   - Cada signup crea un tenant nuevo (no invite/join existing — eso es TANDA 3).
 *   - Plan default: 'trial'.
 *   - Seed mínimo en el tenant nuevo: 3 cajas básicas (Efectivo ARS, Efectivo USD,
 *     Banco ARS). Resto lo crea el user.
 *   - Email NO bloquea login post-signup (bloqueo blando = solo escrituras).
 *   - JWT post-signup tiene `email_verified: false` hasta consumir el link.
 *   - Username se deriva del email (prefix antes de @, slugificado, con sufijo
 *     numérico si colisiona). UX: 1 campo menos en el form.
 *   - Tenant slug se deriva del nombre del tenant, igual con sufijo numérico.
 *
 * Trade-offs:
 *   - Si el email falla (provider down), signup completa igual. Log a Sentry, user
 *     puede usar /resend-verification para reintentar.
 *   - Token UUID-hex de 32 bytes (256 bits). Espacio infactible brute-force.
 *     No agregamos rate limit a verify-email — el token es la defensa.
 *   - El token tiene TTL de 24h. Si expira, /resend-verification genera uno nuevo.
 *
 * En NODE_ENV != 'production', la response de /signup incluye `_verification_token`
 * para que E2E tests puedan verificar sin esperar el email real. En prod nunca
 * se incluye.
 */

const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const logger = require('../lib/logger');
const { sendVerificationEmail, sendWelcomeEmail } = require('../lib/email');
const { signupSchema, verifyEmailSchema } = require('../schemas/signup');
const { TOOLS } = require('../lib/tools');

const BCRYPT_ROUNDS = 12;
const TOKEN_BYTES = 32; // → 64 chars hex
const TOKEN_EXPIRY_HOURS = 24;
const JWT_ALGORITHM = 'HS256';

// 3 cajas default sembradas para cada tenant nuevo. El user las customiza
// después según su negocio (agrega tarjetas, billeteras virtuales, etc.).
const DEFAULT_CAJAS = [
  { nombre: 'Efectivo Pesos', moneda: 'ARS', orden: 1, es_financiera: true },
  { nombre: 'Efectivo USD',   moneda: 'USD', orden: 2, es_financiera: false },
  { nombre: 'Banco Pesos',    moneda: 'ARS', orden: 3, es_financiera: false },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Slugifica un texto: lowercase, sin diacríticos, [^a-z0-9-] → '-', trim. */
function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // Tenant slug constraint: ^[a-z0-9][a-z0-9-]*[a-z0-9]$ (min 2 chars).
  return slug.length >= 2 ? slug : 'tenant';
}

/** Username derivado del email: prefix, lowercase, [^a-z0-9_] → '_'. */
function deriveUsername(email) {
  const local = String(email).split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  // Username constraint: min 2 chars, [a-z0-9_]+. Fallback "user" si quedó vacío.
  return local.length >= 2 ? local : 'user';
}

/** Encuentra un slug libre (probando base, base-2, base-3...). */
async function uniqueSlug(client, base) {
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    const { rows } = await client.query('SELECT 1 FROM tenants WHERE slug = $1', [candidate]);
    if (rows.length === 0) return candidate;
  }
  throw new Error('No se pudo generar un slug único para el tenant después de 100 intentos');
}

/** Encuentra un username libre (probando base, base_2, base_3...). */
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

/** Genera un token de verificación (hex random, 64 chars). */
function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** URL base del frontend, para construir el link de verificación. */
function frontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:5173';
}

// ─── Routes ───────────────────────────────────────────────────────────────

/**
 * POST /signup — crea tenant nuevo + user dueño + verifica via email.
 *
 * Body: { nombre, email, password, tenant_nombre }
 * Response 201: { token (JWT), user, tenant, verification_required: true,
 *                _verification_token (solo en dev/test) }
 */
router.post('/signup', validate(signupSchema), async (req, res, next) => {
  const { nombre, email, password, tenant_nombre } = req.body;

  // Pre-check de email (mensaje claro). DB también lo bloquea via UNIQUE
  // case-insensitive — esto es solo para UX.
  const existing = await db.query(
    'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL',
    [email]
  );
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Este email ya está registrado' });
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const client = await db.connect();
  let result;
  try {
    await client.query('BEGIN');

    // 1. Tenant nuevo (plan trial por default). `tenants` NO está en la lista
    // RLS — se filtra indirectamente vía tenant_users.
    const slug = await uniqueSlug(client, slugify(tenant_nombre));
    const { rows: [tenant] } = await client.query(
      `INSERT INTO tenants (nombre, slug, plan) VALUES ($1, $2, 'trial') RETURNING id, nombre, slug, plan`,
      [tenant_nombre, slug]
    );

    // 1.5. SET LOCAL ANTES de cualquier INSERT en tabla RLS-protegida.
    // Tablas afectadas en este endpoint: user_permissions, metodos_pago,
    // audit_logs (vía audit() call). La WITH CHECK del RLS exige
    // `tenant_id = current_setting('app.current_tenant', true)::int` — sin
    // SET LOCAL primero, el INSERT falla con "new row violates row-level
    // security policy". También tenemos que pasar `tenant_id` explícito
    // en cada row (la columna tiene DEFAULT 1, que no matchea el tenant nuevo).
    await client.query(`SET LOCAL app.current_tenant = ${tenant.id}`);

    // 2. User — explícitamente email_verified_at = NULL para activar el bloqueo
    // blando. La columna tiene DEFAULT NOW() (ver migration 20260616000004),
    // así que el INSERT necesita el NULL explícito acá; los INSERTs de admin
    // (route /api/usuarios) NO especifican email_verified_at y quedan verificados
    // automáticamente. (users NO tiene RLS — no necesita tenant_id.)
    const username = await uniqueUsername(client, deriveUsername(email));
    // TANDA 2.4 fix BLOCKER auditoría 2026-06-17: role='op' (NO 'admin').
    // El "owner" del tenant se representa en `tenant_users.rol='owner'` (línea
    // ~190). El users.role global YA fue deprecated para autorización en
    // TANDA 0a (adminOnly.js usa req.tenantRol, no req.user.role) — pero
    // signup público con role='admin' permitía a cualquier user signupeado
    // bypassear el frontend RequirePermission y acceder a endpoints globales
    // (vía adminOnly check de tenantRol='owner'). Ahora signup crea op +
    // tenant_users.owner, lo correcto multi-tenant.
    const { rows: [user] } = await client.query(
      `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
         VALUES ($1, $2, $3, $4, 'op', NULL)
       RETURNING id, nombre, username, email, role, email_verified_at`,
      [nombre, username, email, hash]
    );

    // 3. Link al tenant como owner. tenant_users NO tiene RLS — es la bridge
    // table que da origen al filtro de RLS para otras tablas.
    await client.query(
      `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`,
      [tenant.id, user.id]
    );

    // 4. Permissions: owner tiene todos los módulos activos. user_permissions
    // SÍ tiene RLS — pasar tenant_id explícito (el último param, reutilizado
    // como $7 para todas las TOOLS rows).
    const permValues = TOOLS.map((_, i) =>
      `($1, $${i + 2}, true, $${TOOLS.length + 2})`
    ).join(', ');
    await client.query(
      `INSERT INTO user_permissions (user_id, tool, enabled, tenant_id) VALUES ${permValues}`,
      [user.id, ...TOOLS, tenant.id]
    );

    // 5. Seed cajas default — metodos_pago SÍ tiene RLS, tenant_id explícito.
    for (const caja of DEFAULT_CAJAS) {
      await client.query(
        `INSERT INTO metodos_pago (nombre, moneda, orden, es_financiera, tenant_id)
           VALUES ($1, $2, $3, $4, $5)`,
        [caja.nombre, caja.moneda, caja.orden, caja.es_financiera, tenant.id]
      );
    }

    // 6. Token de verificación con TTL 24h.
    const token = generateToken();
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [user.id, token, expiresAt]
    );

    // 7. Audit (system event — propaga tenant_id para attribution).
    await audit(client, 'users', 'INSERT', user.id, {
      despues: { id: user.id, email: user.email, username, signup: true },
      user_id: user.id,
      tenant_id: tenant.id,
    });

    await client.query('COMMIT');
    result = { tenant, user, token };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      // Race condition: alguien creó el email/username/slug en paralelo. Mensaje genérico.
      return res.status(409).json({ error: 'Email o tenant ya en uso. Reintentá.' });
    }
    return next(err);
  } finally {
    client.release();
  }

  // 8. Send verification email — POST-tx (best effort, no bloquea el response).
  try {
    const verifyUrl = `${frontendUrl()}/verify-email?token=${result.token}`;
    await sendVerificationEmail({
      to: result.user.email,
      name: result.user.nombre,
      verifyUrl,
    });
  } catch (e) {
    logger.error(
      { err: e, user_id: result.user.id },
      'No se pudo enviar verification email post-signup. User debe usar /resend-verification.'
    );
  }

  // 9. JWT login + response. email_verified=false → frontend muestra banner.
  const payload = {
    id: result.user.id,
    username: result.user.username,
    email: result.user.email,
    role: result.user.role,
    tenant_id: result.tenant.id,
    tenant_rol: 'owner',
    perms: Object.fromEntries(TOOLS.map(t => [t, true])),
    iat_ms: Date.now(),
  };
  const jwtToken = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    algorithm: JWT_ALGORITHM,
  });

  const response = {
    token: jwtToken,
    user: {
      id: result.user.id,
      nombre: result.user.nombre,
      username: result.user.username,
      email: result.user.email,
      role: result.user.role,
      email_verified: false,
      perms: payload.perms,
    },
    tenant: result.tenant,
    verification_required: true,
  };

  // En dev/test, devolvemos el token para que E2E pueda verificar inline.
  // NUNCA en producción (incluye Railway staging+prod, ambos con NODE_ENV=production).
  if (process.env.NODE_ENV !== 'production') {
    response._verification_token = result.token;
  }

  return res.status(201).json(response);
});

/**
 * POST /verify-email — consume un token de verificación.
 *
 * Body: { token }
 * Response 200: { ok: true, email_verified_at }
 * Response 400: token inválido / expirado / ya usado
 *
 * Público (no requiere auth — el token ES el credential).
 */
router.post('/verify-email', validate(verifyEmailSchema), async (req, res, next) => {
  const { token } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the token row para prevenir double-spend en requests concurrentes.
    // No filtramos used_at / expires_at en el WHERE — los chequeamos en JS para
    // poder distinguir los 3 motivos de rechazo (inválido / ya usado / expirado)
    // y darle al usuario un mensaje accionable. UX TANDA 2.2 Fase B.
    const { rows } = await client.query(
      `SELECT id, user_id, used_at, expires_at FROM email_verification_tokens
         WHERE token = $1 FOR UPDATE`,
      [token]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error:  'Token inválido. Verificá que copiaste el link completo.',
        reason: 'invalid',
      });
    }
    const tokenRow = rows[0];
    if (tokenRow.used_at !== null) {
      // Caso típico: user clickea el link 2 veces (primera vez OK, segunda vez
      // cae acá). Mensaje accionable: ya está verificado, no necesita hacer nada.
      await client.query('ROLLBACK');
      return res.status(400).json({
        error:  'Este email ya fue verificado. Podés iniciar sesión.',
        reason: 'already_used',
      });
    }
    if (new Date(tokenRow.expires_at) <= new Date()) {
      // Token nunca usado pero pasó el TTL (24h). Decirle que pida uno nuevo.
      await client.query('ROLLBACK');
      return res.status(400).json({
        error:  'El link expiró. Iniciá sesión y pedí uno nuevo desde el banner.',
        reason: 'expired',
      });
    }
    const { id: tokenId, user_id: userId } = tokenRow;

    // Resolver tenant del user para setear app.current_tenant antes del UPDATE
    // de users (que está sujeto a RLS).
    const { rows: tuRows } = await client.query(
      `SELECT tenant_id FROM tenant_users WHERE user_id = $1 ORDER BY tenant_id ASC LIMIT 1`,
      [userId]
    );
    const tenantId = tuRows[0]?.tenant_id || 1;
    await client.query(`SET LOCAL app.current_tenant = ${tenantId}`);

    // Marcar token usado.
    await client.query(
      `UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1`,
      [tokenId]
    );

    // Marcar user verificado.
    const { rows: [user] } = await client.query(
      `UPDATE users SET email_verified_at = NOW()
         WHERE id = $1
       RETURNING id, email, nombre, email_verified_at`,
      [userId]
    );

    // Audit: documentar la verificación.
    await audit(client, 'users', 'UPDATE', user.id, {
      despues: { email_verified_at: user.email_verified_at },
      tipo: 'email_verification',
      user_id: user.id,
      tenant_id: tenantId,
    });

    await client.query('COMMIT');

    // Welcome email (best effort, no bloquea el response).
    try {
      await sendWelcomeEmail({ to: user.email, name: user.nombre });
    } catch (e) {
      logger.error({ err: e, user_id: user.id }, 'Welcome email falló post-verify');
    }

    res.json({ ok: true, email_verified_at: user.email_verified_at });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

/**
 * Rate limiter para /resend-verification — 3 intentos / hora / user.id.
 * Evita que un user spammée la app para enviarse muchos emails (o que un
 * atacante con JWT robado abuse de la cuota del provider de email).
 *
 * TANDA 2.4 fix BLOCKER auditoría 2026-06-17: lazy init para aceptar un
 * PostgresRateLimitStore inyectado vía `setResendStore()`. Antes este limiter
 * usaba MemoryStore (default) — en multi-replica, un user con JWT robado
 * podía pegar 3× en réplica A y 3× en réplica B = 6 emails/hora (2× lo
 * declarado). Con store compartido, el counter es global.
 *
 * El lazy init resuelve el chicken-and-egg: app.js puede llamar a
 * `setResendStore(resendStore)` ANTES de montar el router, y la primera
 * request al endpoint crea el limiter con el store correcto. Si nadie lo
 * setea (tests), cae a MemoryStore default — comportamiento OK para tests.
 */
function _buildResendLimiter(store) {
  return rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados pedidos de reenvío. Esperá una hora.' },
    keyGenerator: (req) => req.user?.id ? String(req.user.id) : ipKeyGenerator(req),
    skipSuccessfulRequests: false,
    skip: () => process.env.NODE_ENV === 'test',
    ...(store && { store }),
  });
}

// Init temprano al load del módulo con MemoryStore default (evita warning
// ERR_ERL_CREATED_IN_REQUEST_HANDLER). app.js puede llamar setResendStore()
// con un PostgresRateLimitStore para reemplazar antes del primer request.
let _resendLimiterInstance = _buildResendLimiter(undefined);
exports.setResendStore = (store) => {
  _resendLimiterInstance = _buildResendLimiter(store);
};

const resendLimiter = (req, res, next) => _resendLimiterInstance(req, res, next);

/**
 * POST /resend-verification — genera token nuevo + envía email.
 *
 * Auth required (el user logueado pide reenvío de su propia verificación).
 * Si el user YA está verificado, devuelve 200 sin acción (idempotente).
 * Rate limit 3/hora/user.id.
 */
router.post('/resend-verification', requireAuth, resendLimiter, async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    const { rows: [user] } = await client.query(
      `SELECT id, email, nombre, email_verified_at FROM users
         WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id]
    );
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Idempotencia: si ya está verificado, no hacemos nada (no es error).
    if (user.email_verified_at) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, already_verified: true });
    }

    // Invalidar tokens previos del user (marcar usados — uno solo válido a la vez).
    await client.query(
      `UPDATE email_verification_tokens SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    );

    // Generar token nuevo.
    const token = generateToken();
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [user.id, token, expiresAt]
    );

    await client.query('COMMIT');

    // Email post-tx (best effort).
    try {
      const verifyUrl = `${frontendUrl()}/verify-email?token=${token}`;
      await sendVerificationEmail({
        to: user.email,
        name: user.nombre,
        verifyUrl,
      });
    } catch (e) {
      logger.error({ err: e, user_id: user.id }, 'Resend verification email falló');
    }

    const response = { ok: true };
    if (process.env.NODE_ENV !== 'production') {
      response._verification_token = token;
    }
    res.json(response);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
// `exports.setResendStore` ya está asignado arriba (lazy init del resendLimiter).
// El re-assignment de module.exports = router es OK — Node.js mantiene las
// props que setteamos en `exports` mientras no reasignemos `exports = ...`.
// Verificado: `router.setResendStore` queda disponible en app.js.
module.exports.setResendStore = exports.setResendStore;

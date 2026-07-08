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
// F3.a: seed de las 9 clases base + "Sin categoría" en clases_producto.
const { seedClasesProducto } = require('../lib/seedClasesProducto');
// 2026-06-23 F4: TOOLS murió. El signup ahora crea al owner con rol='owner'
// en tenant_user_roles, que en el nuevo sistema capability-based equivale
// a bypass total (igual que admin global del sistema viejo).
// Importar el módulo (no destructurar) para soportar jest.spyOn desde tests.
const userAuthCache = require('../lib/userAuthCache');
const captcha = require('../lib/captcha');

const BCRYPT_ROUNDS = 12;
const TOKEN_BYTES = 32; // → 64 chars hex
const TOKEN_EXPIRY_HOURS = 24;
const JWT_ALGORITHM = 'HS256';

// 3 cajas default sembradas para cada tenant nuevo. El user las customiza
// después según su negocio (agrega tarjetas, billeteras virtuales, etc.).
//
// 2026-06-29 Multi-país F4 (#470): el selector de país en el form de signup
// determina las cajas iniciales. Para UY usamos UYU (Efectivo Pesos = Pesos
// Uruguayos) — el operador uruguayo no tendría por qué arrancar con cajas
// en ARS. USD se mantiene en ambos países (universal). El operador puede
// agregar/borrar después según su negocio.
const DEFAULT_CAJAS_AR = [
  { nombre: 'Efectivo Pesos', moneda: 'ARS', orden: 1, es_financiera: true },
  { nombre: 'Efectivo USD',   moneda: 'USD', orden: 2, es_financiera: false },
  { nombre: 'Banco Pesos',    moneda: 'ARS', orden: 3, es_financiera: false },
];
const DEFAULT_CAJAS_UY = [
  { nombre: 'Efectivo Pesos', moneda: 'UYU', orden: 1, es_financiera: true },
  { nombre: 'Efectivo USD',   moneda: 'USD', orden: 2, es_financiera: false },
  { nombre: 'Banco Pesos',    moneda: 'UYU', orden: 3, es_financiera: false },
];

function getDefaultCajasPorPais(pais) {
  return pais === 'UY' ? DEFAULT_CAJAS_UY : DEFAULT_CAJAS_AR;
}

// Multi-país F2 (#471): defaults de alertas_config sembradas en cada tenant
// nuevo. `tc_referencia.valor` depende del país (1400 ARS/USD vs 40 UYU/USD).
//
// Por qué seedear acá en lugar de confiar en la migration 20260620000002:
//   La migration solo seedea para los tenants EXISTENTES al momento de
//   correr. Los tenants nuevos creados via signup público quedaban sin
//   ninguna fila — el tool del bot get_alertas devolvía vacío, las UI de
//   warning de TC no aparecían en el primer login del owner. Bug latente
//   tracked pero no fixeado hasta F2.
//
// Decisión (Lucas, design doc 9.2): seedear automáticamente con `valor`
// del país (UY=40, AR=1400). El operador puede cambiar el TC desde
// /api/alertas/config/tc_referencia en cualquier momento.
//
// Thresholds "25 < TC < 60" UY mencionados en design doc 9.5 se traducen
// a `valor=40` + `tolerancia_pct=50%` en el schema actual de
// `tc_referencia.parametros` (no agregamos `min`/`max` separados — sería
// schema change a la tabla, fuera del scope F2).
function defaultsAlertasParaPais(pais) {
  const tcValor = pais === 'UY' ? 40 : 1400;
  return [
    { tipo: 'tc_referencia', activa: true, parametros: { valor: tcValor, tolerancia_pct: 50, alerta_por_debajo: true } },
    { tipo: 'caja_negativa', activa: true, parametros: {} },
    { tipo: 'stock_bajo', activa: true, parametros: { umbral_unidades: 5 } },
    { tipo: 'cc_mora', activa: true, parametros: { dias_sin_pago: 30 } },
    { tipo: 'proveedor_atrasado', activa: true, parametros: { dias_sin_movimiento: 30 } },
  ];
}

// 2026-06-24 ONB-3 (audit pre-live): 4 categorías default. Sin esto, el primer
// producto que el owner intenta cargar desde el OnboardingCard rebota con
// "La categoría es obligatoria" (productos.categoria_id requerido por
// inventario.js:65). El user debía cerrar el modal, ir a "Categorías &
// Depósitos", crear una, volver al modal — fricción en el step #1 del flow.
// Estas 4 cubren el ~90% de los negocios de revendedores tech.
const DEFAULT_CATEGORIAS = ['Celulares', 'Accesorios', 'Servicios', 'Otros'];

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
  // 2026-06-29 Multi-país F4 (#470): `pais` viene del selector en Signup.jsx
  // (AR | UY). Zod aplicó default 'AR' si el campo faltaba (legacy clients).
  const { nombre, email, password, tenant_nombre, hcaptcha_response, pais } = req.body;

  // CAPTCHA gate — antes de cualquier query a DB para protegerla del costo de
  // SELECT/INSERT con tokens inválidos masivos. Si HCAPTCHA_ENABLED!='true'
  // o NODE_ENV=test, verifyCaptcha bypassa silenciosamente. Si el captcha
  // falla, retornamos 400 antes de la query → atacante no puede usar el
  // endpoint para nada salvo consumir CPU validando captchas (rate-limiteado
  // por signupLimiter más arriba en la pipeline).
  //
  // El mensaje de error mapea categoría → texto:
  //   - 'expired'       → "Verificación expirada, intentá de nuevo"
  //   - 'duplicate'     → "Verificación ya usada, recargá la página"
  //   - 'invalid_token' → "Verificación inválida, completá el captcha"
  //   - network/config/http → "No pudimos verificar. Reintentá en un minuto."
  const captchaResult = await captcha.verifyCaptcha(hcaptcha_response, req.ip);
  if (!captchaResult.success) {
    const errMap = {
      expired:       'La verificación expiró. Intentá de nuevo.',
      duplicate:     'La verificación ya fue usada. Recargá la página.',
      invalid_token: 'Verificación inválida. Completá el captcha y reintentá.',
    };
    const msg = errMap[captchaResult.error] || 'No pudimos verificar el captcha. Reintentá en un minuto.';
    logger.info({ source: 'signup_captcha_fail', error: captchaResult.error },
      'signup rechazado por captcha');
    return res.status(400).json({ error: msg, reason: 'captcha_failed' });
  }

  // TANDA 2.7 fix HIGH#1 Seguridad auditoría 2026-06-17: anti-enumeration.
  // Antes el endpoint distinguía emails registrados (409) de no-registrados
  // (201) → cualquiera podía probar emails masivamente y enumerar cuentas.
  // Ahora la response es **idéntica** para ambos casos: 200 con
  // { verification_required: true }. Cost: signup ya NO auto-loguea — el user
  // debe verificar email antes de poder iniciar sesión. Trade-off aceptado:
  // anti-enum perfecto + verify-before-use es el patrón estándar de SaaS.
  //
  // Si el email ya existe, NO creamos nada — solo respondemos genérico.
  // (Recovery email "alguien intentó usar tu email" queda para follow-up.)
  const existing = await db.query(
    'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL',
    [email]
  );
  if (existing.rows.length > 0) {
    // TANDA 0 hotfix BLOCKER B2 auditoría 2026-06-17: timing oracle anti-enum.
    // Antes el path duplicado retornaba ~10ms y el nuevo ~300-500ms (bcrypt cost-12).
    // Un atacante medía response time y enumeraba emails con ~10 samples, anulando
    // el anti-enum por shape de TANDA 2.7. Mismo patrón que el DUMMY_HASH del login
    // (auth.js:128). Ejecutamos bcrypt.hash() y descartamos el resultado — costo
    // CPU equivalente al path nuevo, garantizando timing constante.
    await bcrypt.hash(password, BCRYPT_ROUNDS);
    logger.info({ email_hash: 'redacted', source: 'signup_dup_email' },
      'signup duplicado — respondiendo genérico (anti-enum)');
    // TANDA 5 fix U3 auditoría 2026-06-17: incluir TTL en response. Antes
    // el frontend hardcodeaba "24 horas" en el copy — si el backend
    // ajustaba TOKEN_EXPIRY_HOURS la UI mostraba info incorrecta. Ahora
    // el frontend lee este field. La info también se incluye en el path
    // duplicado para preservar shape idéntica (anti-enum).
    return res.status(200).json({
      verification_required: true,
      verification_token_ttl_hours: TOKEN_EXPIRY_HOURS,
    });
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const client = await db.connect();
  let result;
  try {
    await client.query('BEGIN');

    // 1. Tenant nuevo (plan trial por default). `tenants` NO está en la lista
    // RLS — se filtra indirectamente vía tenant_users.
    //
    // 2026-06-29 Multi-país F4 (#470): persistimos `pais` en el INSERT. La
    // columna tiene DEFAULT 'AR' (migration F1), así que un legacy client que
    // no mande `pais` también queda en AR — pero acá lo pasamos siempre porque
    // Zod aplica .default('AR') y `pais` queda como string válido (AR|UY).
    const slug = await uniqueSlug(client, slugify(tenant_nombre));
    const { rows: [tenant] } = await client.query(
      `INSERT INTO tenants (nombre, slug, plan, pais) VALUES ($1, $2, 'trial', $3) RETURNING id, nombre, slug, plan, pais`,
      [tenant_nombre, slug, pais]
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

    // 4. 2026-06-23 F4 cutover capability-based: el owner del tenant recibe
    // rol='owner' en tenant_user_roles. El middleware requireCapability ve
    // ese rol y bypassa todo el gate. NO seedeamos user_capabilities — el
    // rol 'owner' es bypass implícito (no necesita overrides).
    //
    // tenant_user_roles tiene FORCE RLS, así que el SET LOCAL del paso 1.5
    // arriba ya satisface el WITH CHECK.
    await client.query(
      `INSERT INTO tenant_user_roles (tenant_id, user_id, rol)
         VALUES ($1, $2, 'owner')`,
      [tenant.id, user.id]
    );

    // 5. Seed cajas default — metodos_pago SÍ tiene RLS, tenant_id explícito.
    // 2026-06-29 Multi-país F4: las cajas iniciales dependen del país elegido
    // en signup. UY usa UYU (Pesos Uruguayos) en las dos cajas "Pesos",
    // AR usa ARS (Pesos Argentinos). USD se mantiene en ambos casos.
    for (const caja of getDefaultCajasPorPais(pais)) {
      await client.query(
        `INSERT INTO metodos_pago (nombre, moneda, orden, es_financiera, tenant_id)
           VALUES ($1, $2, $3, $4, $5)`,
        [caja.nombre, caja.moneda, caja.orden, caja.es_financiera, tenant.id]
      );
    }

    // 5b. 2026-06-24 ONB-3: seed de categorías default. Sin esto, el step #1
    // del OnboardingCard ("Agregá tu primer producto") rebota con 400 porque
    // productos.categoria_id es obligatorio. Mismo patrón que cajas — tenant_id
    // explícito porque categorias tiene RLS.
    for (const catNombre of DEFAULT_CATEGORIAS) {
      await client.query(
        `INSERT INTO categorias (nombre, tenant_id) VALUES ($1, $2)`,
        [catNombre, tenant.id]
      );
    }

    // 5c. 2026-06-25 ONB-6 (audit pre-live): seed de un vendedor con el nombre
    // del owner. Cuando el user nuevo abre el modal "Nueva venta" del Onboarding-
    // Card, el dropdown Vendedor estaba vacío con un "—" — confuso para el
    // owner solitario (caso típico early adopter). Con el seed, el dropdown
    // ya muestra su propio nombre seleccionable, sin obligar a configurar
    // antes. El user puede editarlo / agregar más cuando quiera.
    // `nombre` viene del destructure del req.body en línea 139.
    await client.query(
      `INSERT INTO vendedores (nombre, tenant_id) VALUES ($1, $2)`,
      [nombre, tenant.id]
    );

    // 5c-bis. 2026-07-08 Categorías reales F3.a: seed de las 9 clases base +
    // "Sin categoría" del sistema en `clases_producto`. Reemplaza el enum
    // hardcoded de F1 por una tabla editable por tenant. Requiere el SET LOCAL
    // del paso 1.5 (RLS enforced en clases_producto). Idempotente vía ON
    // CONFLICT — safe si se re-corre el flujo por retry.
    // Helper: backend/src/lib/seedClasesProducto.js (mirror en la migration).
    await seedClasesProducto(client, tenant.id);

    // 5cb. 2026-06-29 Multi-país F2 (#471): seed de alertas_config para el
    // tenant nuevo. Sin esto el tool get_alertas del bot devuelve vacío y
    // los warnings de TC del frontend no se muestran en el primer login.
    // `tc_referencia.valor` viene del país (UY=40 vs AR=1400).
    //
    // 2026-06-29 Multi-país F4 (#470): `pais` ya viene del body validado por
    // Zod (default 'AR' para legacy clients sin selector). Antes hacíamos un
    // SELECT post-INSERT para leerlo de la DB — innecesario ahora que el
    // form siempre lo manda explícito.
    for (const alerta of defaultsAlertasParaPais(pais)) {
      await client.query(
        `INSERT INTO alertas_config (tenant_id, tipo, activa, parametros)
           VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (tenant_id, tipo) DO NOTHING`,
        [tenant.id, alerta.tipo, alerta.activa, JSON.stringify(alerta.parametros)]
      );
    }

    // 5d. 2026-06-25 Bug #2 (primer cliente real iDeals Ar tenant=12):
    // seed de la fila de config con pct_financiera=0. Sin esto, cuando el
    // owner intenta cambiar el % de retención en la pantalla Config, el INSERT
    // en `/api/config` PUT confiaba en el DEFAULT dinámico de tenant_id (que
    // genera el valor de current_setting('app.current_tenant')) — pero por
    // alguna razón ese path no persistía la fila para tenants nuevos. Resultado:
    // el cliente ve 3% en la UI pero `syncFinancieraComprobante` lee
    // `SELECT pct_financiera FROM config LIMIT 1` y la RLS filtra a 0 filas
    // → `monto_financiera = 0` en TODOS los comprobantes financieros del tenant.
    //
    // Diagnóstico real con SQL en prod (2026-06-25 18:55 AR):
    //   SELECT * FROM config WHERE tenant_id = 12 → (0 filas)
    //
    // Con este seed garantizamos que la fila SIEMPRE existe desde el momento
    // del signup. El UPDATE de pct_financiera vía PUT /api/config ya funciona
    // si la fila existe (ON CONFLICT hace UPDATE). El INSERT del PUT también
    // está blindado en este PR con tenant_id explícito como defense-in-depth.
    await client.query(
      `INSERT INTO config (id, pct_financiera, tenant_id) VALUES (1, 0, $1)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [tenant.id]
    );

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

  // 8. Send verification email — fire-and-forget vía setImmediate.
  //
  // TANDA 0 hotfix BLOCKER B2 auditoría 2026-06-17 (parte 2): mover el await
  // fuera del response path. El Resend SaaS tarda 500ms-3s en aceptar el envío;
  // si esperamos, el path "nuevo" tarda 800ms-3.5s y el path "duplicado" (con
  // dummy bcrypt) tarda ~300ms. Esa diferencia residual es medible. Con
  // setImmediate, el response se devuelve apenas terminan los INSERTs + bcrypt
  // (~350ms), igualando dentro del jitter de red al path duplicado.
  //
  // Trade-off: si Resend devuelve error, el user no ve nada — debe usar
  // /resend-verification. Loggeamos para observabilidad.
  setImmediate(async () => {
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
  });

  // TANDA 2.7 anti-enum: response idéntica al caso "email duplicado" (línea ~135).
  // NO devolvemos token/user/tenant — eso permitía distinguir signup nuevo de
  // signup duplicado por shape de la response. Trade-off: el user debe verificar
  // email antes de iniciar sesión (no hay auto-login). El JWT antes generado
  // acá ya no se genera (era para auto-login).
  // TANDA 5 fix U3: incluir TTL en response (idéntico al path duplicado).
  const response = {
    verification_required: true,
    verification_token_ttl_hours: TOKEN_EXPIRY_HOURS,
  };

  // En dev/test, devolvemos el token para que E2E pueda verificar inline.
  // NUNCA en producción.
  //
  // TANDA 2.5 fix HIGH#2 Seguridad auditoría 2026-06-17: gate dual NODE_ENV
  // + flag explícito. El gate solo-NODE_ENV era frágil — staging/preview/demo
  // deploys mal configurados (sin NODE_ENV='production') podían exponer
  // tokens accidentalmente. Ahora:
  //   - Tests (NODE_ENV='test'): tokens expuestos siempre (necesario para suite)
  //   - Dev local: opt-in vía EXPOSE_VERIFICATION_TOKEN=1
  //   - Staging/preview/prod: tokens NUNCA expuestos (NODE_ENV !== 'test' AND
  //     el flag NO está seteado por defecto)
  // Defensa en profundidad: doble candado en lugar de uno.
  const exposeToken = process.env.NODE_ENV === 'test'
    || (process.env.NODE_ENV !== 'production' && process.env.EXPOSE_VERIFICATION_TOKEN === '1');
  if (exposeToken) {
    response._verification_token = result.token;
  }

  // TANDA 2.7: 200 (no 201) para matchear el response del caso "email duplicado".
  return res.status(200).json(response);
});

/**
 * Rate limiter dedicado para /verify-email — 30 intentos / minuto / IP.
 *
 * TANDA 2.6 fix MEDIUM Seguridad auditoría 2026-06-17: el endpoint /verify-email
 * dependía solo del global limiter (300/15min). Aunque el espacio de tokens
 * (256 bits) hace brute-force matemáticamente infactible, sin un limiter
 * dedicado un atacante con IPs rotantes puede saturar la DB con SELECT FOR
 * UPDATE + INSERT en audit_logs (un round-trip de DB por token random).
 *
 * Límite 30/min/IP es generoso para un user real (clickear el link 1-2 veces)
 * pero corta brute force / scanning agresivo. Mismo patrón lazy-init que
 * resendLimiter — el verifyStore se inyecta vía setVerifyStore() desde app.js.
 */
function _buildVerifyEmailLimiter(store) {
  return rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos de verificación. Esperá un minuto.' },
    keyGenerator: (req) => ipKeyGenerator(req),
    skip: () => process.env.NODE_ENV === 'test',
    ...(store && { store }),
  });
}
let _verifyEmailLimiterInstance = _buildVerifyEmailLimiter(undefined);
exports.setVerifyStore = (store) => {
  _verifyEmailLimiterInstance = _buildVerifyEmailLimiter(store);
};
const verifyEmailLimiter = (req, res, next) => _verifyEmailLimiterInstance(req, res, next);

/**
 * POST /verify-email — consume un token de verificación.
 *
 * Body: { token }
 * Response 200: { ok: true, email_verified_at }
 * Response 400: token inválido / expirado / ya usado
 * Response 410: tenant huérfano (user sin tenant activo)
 *
 * Público (no requiere auth — el token ES el credential).
 * Rate limit: 30/min/IP (TANDA 2.6).
 */
router.post('/verify-email', verifyEmailLimiter, validate(verifyEmailSchema), async (req, res, next) => {
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
    // TANDA 2.6 fix HIGH Solidez auditoría 2026-06-17: si el user no tiene
    // tenant activo (caso edge: tenant soft-deleted, link entre user y tenant
    // borrado), NO caer a tenant_id=1 (que es el tenant del owner del portal).
    // Antes: el SET LOCAL se ponía en 1 y los audit_logs del verify-email
    // quedaban atribuidos al tenant del owner — ruido en el historial real
    // + atribución forense incorrecta. Ahora: devolvemos 410 Gone (recurso
    // existió pero ya no tiene contexto válido).
    if (!tuRows[0]) {
      await client.query('ROLLBACK');
      return res.status(410).json({
        error:  'Tu cuenta no tiene un tenant activo. Contactá a soporte.',
        reason: 'tenant_orphan',
      });
    }
    const tenantId = tuRows[0].tenant_id;
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
    // P-04 Fase 3.6: invalidar cache de auth meta DESPUÉS del COMMIT.
    // email_verified_at cambió de null → NOW(). Sin invalidar, una réplica
    // con el row stale seguiría devolviendo email_verified=false → el
    // bloqueo blando (requireAuth) seguiría rechazando escrituras hasta TTL.
    userAuthCache.invalidateUserAuth(user.id);

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
    // TANDA 0 hotfix HIGH S2 auditoría 2026-06-17: gate dual NODE_ENV + flag
    // explícito. Mismo patrón que /signup (TANDA 2.5). El gate solo-NODE_ENV
    // de este endpoint era frágil — staging/preview/demo deploys sin
    // NODE_ENV='production' exponían el token al cliente.
    const exposeToken = process.env.NODE_ENV === 'test'
      || (process.env.NODE_ENV !== 'production' && process.env.EXPOSE_VERIFICATION_TOKEN === '1');
    if (exposeToken) {
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
module.exports.setVerifyStore = exports.setVerifyStore;

// 2026-06-30 #473: exponemos getDefaultCajasPorPais para que superAdmin.js lo
// reuse cuando un super-admin cambia el país de un tenant (crea las cajas del
// país nuevo sin borrar las viejas). Single source of truth: la misma lista
// que sembramos en signup público.
module.exports.getDefaultCajasPorPais = getDefaultCajasPorPais;

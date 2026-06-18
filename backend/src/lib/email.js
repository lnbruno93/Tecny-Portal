/**
 * Email service wrapper — Resend integration (TANDA 2.2 Fase B).
 *
 * Interfaz (estable, callers no cambian):
 *   - sendVerificationEmail({ to, name, verifyUrl })
 *   - sendWelcomeEmail({ to, name })
 *
 * Provider:
 *   - Modo Resend: si RESEND_API_KEY está seteada, manda email real con
 *     Resend SDK. Sender domain = EMAIL_FROM (debe estar verificado en
 *     Resend, salvo onboarding@resend.dev que solo emite al email del owner).
 *   - Modo stub: si NO hay RESEND_API_KEY, loguea con pino y devuelve ok.
 *     Útil en dev local sin cuenta Resend, y mantiene el flow funcionando
 *     en CI sin secrets.
 *   - Modo test: NODE_ENV=test → guarda en _testQueue (no llama a Resend
 *     aunque el key esté seteado). Los tests inspeccionan la queue.
 *
 * Decisiones durables:
 *   - El `from` viene de EMAIL_FROM env. Sin default real: si no hay,
 *     fallback a onboarding@resend.dev (sender de prueba de Resend que solo
 *     funciona si la cuenta no tiene dominio verificado). Para prod hay que
 *     setear EMAIL_FROM=noreply@<dominio-verificado>.
 *   - Errores del provider NO bloquean el response del endpoint que llama.
 *     El user recibe success en signup aunque el email haya fallado. Log el
 *     error a logger (Sentry lo captura via integration) pero no propagamos
 *     al user. Trade-off explícito: priorizamos UX (signup completa) sobre
 *     visibilidad inmediata del error (que aparece como retry desde el banner
 *     UnverifiedBanner / endpoint /resend-verification).
 *   - HTML templates inline en este archivo. No usamos template engine — son
 *     2 templates simples. Si crece a 5+ templates, mover a `templates/` y
 *     usar Handlebars o similar.
 *
 * Test inspection (NODE_ENV=test):
 *   - _getTestQueue() → array de payloads.
 *   - _resetTestQueue() → vacía entre tests.
 */

const logger = require('./logger');

// Resend lazy-required dentro de la primera llamada para que tests que no
// usan Resend no carguen el módulo (más rápido en CI). El cliente se cachea
// en módulo-scope (singleton).
let _resendClient = null;
function _getResend() {
  if (_resendClient) return _resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  // require sync — está en package.json
  const { Resend } = require('resend');
  _resendClient = new Resend(apiKey);
  return _resendClient;
}

const _testQueue = [];

function isTest() {
  return process.env.NODE_ENV === 'test';
}

function _emailFrom() {
  // Si no hay EMAIL_FROM, usamos onboarding@resend.dev — Resend permite enviar
  // desde ese sender solo al email del owner de la cuenta (limitado pero
  // útil para staging temprano sin dominio verificado).
  return process.env.EMAIL_FROM || 'iPro Portal <onboarding@resend.dev>';
}

// ── HTML templates ───────────────────────────────────────────────────────
// Diseño: simple, mobile-friendly, sin imágenes externas (clients de email
// suelen bloquearlas). Inline styles porque CSS class-based no funciona en
// muchos clients (Gmail, Outlook desktop). Paleta consistente con el portal
// (#0a0e18 fondo, #38bdf8 accent).

function _verificationHtml({ name, verifyUrl }) {
  const greeting = name ? `Hola ${_esc(name)},` : 'Hola,';
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verificá tu email — iPro Portal</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1a14;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.05);">
        <tr><td style="padding:32px 36px 24px;border-bottom:1px solid #f0ead6;">
          <div style="display:inline-block;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#fff;line-height:36px;text-align:center;font-weight:800;font-size:14px;letter-spacing:-0.04em;">iP</div>
          <span style="display:inline-block;vertical-align:middle;margin-left:12px;font-weight:700;font-size:17px;color:#0d1220;">iPro Portal</span>
        </td></tr>
        <tr><td style="padding:36px 36px 12px;">
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0d1220;">Verificá tu email</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#3f3a2c;">Te diste de alta en iPro Portal. Para empezar a operar (crear ventas, comprobantes, etc.), confirmanos que el email es tuyo:</p>
          <p style="margin:0 0 24px;text-align:center;">
            <a href="${_esc(verifyUrl)}" style="display:inline-block;padding:13px 28px;background:#0ea5e9;color:#ffffff;text-decoration:none;border-radius:9px;font-weight:700;font-size:15px;letter-spacing:-0.005em;">Verificar email →</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#76705c;">Si el botón no abre, copiá este link en tu navegador:</p>
          <p style="margin:0 0 24px;font-size:12.5px;line-height:1.45;color:#0ea5e9;word-break:break-all;">${_esc(verifyUrl)}</p>
          <p style="margin:0;font-size:13px;line-height:1.55;color:#76705c;">El link vence en 24 horas. Si no creaste vos esta cuenta, podés ignorar este email.</p>
        </td></tr>
        <tr><td style="padding:20px 36px 32px;border-top:1px solid #f0ead6;font-size:12px;color:#9c957f;text-align:center;">
          iPro Portal · Tech Reseller · Celnyx
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function _verificationText({ name, verifyUrl }) {
  // Fallback plain-text. Algunos clients lo prefieren (deliverability).
  const greeting = name ? `Hola ${name},` : 'Hola,';
  return `${greeting}

Te diste de alta en iPro Portal. Para empezar a operar (crear ventas, comprobantes, etc.), confirmanos tu email abriendo este link:

${verifyUrl}

El link vence en 24 horas. Si no creaste vos esta cuenta, ignorá este email.

— iPro Portal`;
}

function _welcomeHtml({ name }) {
  const greeting = name ? `Hola ${_esc(name)},` : 'Hola,';
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Bienvenido a iPro Portal</title></head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1a14;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:32px 36px 24px;border-bottom:1px solid #f0ead6;">
          <div style="display:inline-block;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#fff;line-height:36px;text-align:center;font-weight:800;font-size:14px;letter-spacing:-0.04em;">iP</div>
          <span style="display:inline-block;vertical-align:middle;margin-left:12px;font-weight:700;font-size:17px;color:#0d1220;">iPro Portal</span>
        </td></tr>
        <tr><td style="padding:36px 36px 24px;">
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0d1220;">¡Listo! Cuenta verificada ✓</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">Ya podés usar el portal sin restricciones — crear ventas, registrar pagos, gestionar inventario y todo lo demás.</p>
          <p style="margin:0;font-size:13px;line-height:1.55;color:#76705c;">¿Algún problema? Respondé a este email y te ayudamos.</p>
        </td></tr>
        <tr><td style="padding:20px 36px 32px;border-top:1px solid #f0ead6;font-size:12px;color:#9c957f;text-align:center;">
          iPro Portal · Tech Reseller · Celnyx
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function _welcomeText({ name }) {
  const greeting = name ? `Hola ${name},` : 'Hola,';
  return `${greeting}

¡Listo! Tu cuenta de iPro Portal está verificada. Ya podés operar sin restricciones — crear ventas, registrar pagos, gestionar inventario y todo lo demás.

¿Algún problema? Respondé a este email.

— iPro Portal`;
}

// Mini-escape HTML — evitamos inyectar nombres / URLs sin escape en el HTML.
// No es full-XSS safe (no escapamos comillas), pero el HTML se renderiza en
// clients de email, no en browser, así que el riesgo es bajo. Y los inputs
// vienen del backend (nombre del user, verifyUrl construido por nosotros).
function _esc(s) {
  return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Envía email con link de verificación post-signup.
 * Errores se logean pero no se propagan (el caller no debe bloquear signup).
 */
async function sendVerificationEmail({ to, name, verifyUrl }) {
  if (!to || !verifyUrl) {
    throw new Error('sendVerificationEmail: `to` y `verifyUrl` son requeridos');
  }
  const payload = {
    type:    'verification',
    from:    _emailFrom(),
    to,
    name:    name || null,
    verifyUrl,
    sentAt:  new Date().toISOString(),
  };

  if (isTest()) {
    _testQueue.push(payload);
    return { ok: true, deliveryId: 'test-' + Date.now() };
  }

  const resend = _getResend();
  if (!resend) {
    // Sin API key — modo stub (dev local, CI sin secrets). Logueamos para
    // visibilidad en Railway logs si alguien lo dispara sin querer.
    logger.warn({ to, verifyUrl }, '[email] RESEND_API_KEY no seteada — email de verificación no se envió (modo stub)');
    return { ok: true, deliveryId: 'stub-' + Date.now() };
  }

  try {
    const result = await resend.emails.send({
      from:    _emailFrom(),
      to,
      subject: 'Verificá tu email — iPro Portal',
      html:    _verificationHtml({ name, verifyUrl }),
      text:    _verificationText({ name, verifyUrl }),
    });
    if (result.error) {
      // Resend devuelve errores estructurados en result.error (no throw).
      logger.error({ err: result.error, to }, '[email] Resend error en verification email');
      return { ok: false, deliveryId: null, error: result.error.message || 'Resend error' };
    }
    logger.info({ to, deliveryId: result.data?.id }, '[email] verification email enviado');
    return { ok: true, deliveryId: result.data?.id };
  } catch (err) {
    // Errores de red, timeouts, etc.
    logger.error({ err, to }, '[email] excepción al enviar verification email');
    return { ok: false, deliveryId: null, error: err.message };
  }
}

/**
 * Envía email de bienvenida post-verificación.
 */
async function sendWelcomeEmail({ to, name }) {
  if (!to) {
    throw new Error('sendWelcomeEmail: `to` es requerido');
  }
  const payload = {
    type:    'welcome',
    from:    _emailFrom(),
    to,
    name:    name || null,
    sentAt:  new Date().toISOString(),
  };

  if (isTest()) {
    _testQueue.push(payload);
    return { ok: true, deliveryId: 'test-' + Date.now() };
  }

  const resend = _getResend();
  if (!resend) {
    logger.warn({ to }, '[email] RESEND_API_KEY no seteada — welcome email no se envió (modo stub)');
    return { ok: true, deliveryId: 'stub-' + Date.now() };
  }

  try {
    const result = await resend.emails.send({
      from:    _emailFrom(),
      to,
      subject: '¡Bienvenido a iPro Portal!',
      html:    _welcomeHtml({ name }),
      text:    _welcomeText({ name }),
    });
    if (result.error) {
      logger.error({ err: result.error, to }, '[email] Resend error en welcome email');
      return { ok: false, deliveryId: null, error: result.error.message || 'Resend error' };
    }
    logger.info({ to, deliveryId: result.data?.id }, '[email] welcome email enviado');
    return { ok: true, deliveryId: result.data?.id };
  } catch (err) {
    logger.error({ err, to }, '[email] excepción al enviar welcome email');
    return { ok: false, deliveryId: null, error: err.message };
  }
}

// ── Password reset (TANDA 0 #321) ─────────────────────────────────────────

function _passwordResetHtml({ name, resetUrl, ttlHours }) {
  const greeting = name ? `Hola ${_esc(name)},` : 'Hola,';
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Resetear contraseña — iPro Portal</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1a14;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.05);">
        <tr><td style="padding:32px 36px 24px;border-bottom:1px solid #f0ead6;">
          <div style="display:inline-block;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#fff;line-height:36px;text-align:center;font-weight:800;font-size:14px;letter-spacing:-0.04em;">iP</div>
          <span style="display:inline-block;vertical-align:middle;margin-left:12px;font-weight:700;font-size:17px;color:#0d1220;">iPro Portal</span>
        </td></tr>
        <tr><td style="padding:36px 36px 12px;">
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0d1220;">Resetear tu contraseña</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#3f3a2c;">Recibimos una solicitud para resetear la contraseña de tu cuenta en iPro Portal. Si fuiste vos, hacé click para elegir una nueva:</p>
          <p style="margin:0 0 24px;text-align:center;">
            <a href="${_esc(resetUrl)}" style="display:inline-block;padding:13px 28px;background:#0ea5e9;color:#ffffff;text-decoration:none;border-radius:9px;font-weight:700;font-size:15px;letter-spacing:-0.005em;">Elegir nueva contraseña →</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#76705c;">Si el botón no abre, copiá este link en tu navegador:</p>
          <p style="margin:0 0 24px;font-size:12.5px;line-height:1.45;color:#0ea5e9;word-break:break-all;">${_esc(resetUrl)}</p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#76705c;">El link vence en ${ttlHours} ${ttlHours === 1 ? 'hora' : 'horas'}.</p>
          <p style="margin:0;font-size:13px;line-height:1.55;color:#76705c;"><strong>Si no pediste vos este reset, ignorá este email.</strong> Tu contraseña actual sigue funcionando.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function _passwordResetText({ name, resetUrl, ttlHours }) {
  const greeting = name ? `Hola ${name},` : 'Hola,';
  return `${greeting}

Recibimos una solicitud para resetear la contraseña de tu cuenta en iPro Portal.

Si fuiste vos, abrí este link para elegir una nueva:
${resetUrl}

El link vence en ${ttlHours} ${ttlHours === 1 ? 'hora' : 'horas'}.

Si no pediste vos este reset, ignorá este email. Tu contraseña actual sigue funcionando.

— iPro Portal`;
}

/**
 * Envía email con link para resetear password.
 *
 * 2026-06-18 #321: parte del flow forgot-password auto-servicio. El backend
 * llama fire-and-forget (no bloquea response). Si el send falla, el user
 * no recibe el email — puede reintentar via /forgot-password (rate-limit
 * aplica). Mismo trade-off que sendVerificationEmail.
 *
 * @param {object} args
 * @param {string} args.to         — destinatario
 * @param {string} [args.name]     — para personalizar el saludo
 * @param {string} args.resetUrl   — link al frontend con el token
 * @param {number} args.ttlHours   — TTL del token en horas, para mostrar al user
 */
async function sendPasswordResetEmail({ to, name, resetUrl, ttlHours }) {
  if (!to || !resetUrl || !ttlHours) {
    throw new Error('sendPasswordResetEmail: `to`, `resetUrl` y `ttlHours` son requeridos');
  }
  const payload = {
    type:    'password_reset',
    from:    _emailFrom(),
    to,
    name:    name || null,
    resetUrl,
    ttlHours,
    sentAt:  new Date().toISOString(),
  };

  if (isTest()) {
    _testQueue.push(payload);
    return { ok: true, deliveryId: 'test-' + Date.now() };
  }

  const resend = _getResend();
  if (!resend) {
    logger.warn({ to, resetUrl }, '[email] RESEND_API_KEY no seteada — password reset email no se envió (modo stub)');
    return { ok: true, deliveryId: 'stub-' + Date.now() };
  }

  try {
    const result = await resend.emails.send({
      from:    _emailFrom(),
      to,
      subject: 'Resetear contraseña — iPro Portal',
      html:    _passwordResetHtml({ name, resetUrl, ttlHours }),
      text:    _passwordResetText({ name, resetUrl, ttlHours }),
    });
    if (result.error) {
      logger.error({ err: result.error, to }, '[email] Resend error en password reset email');
      return { ok: false, deliveryId: null, error: result.error.message || 'Resend error' };
    }
    logger.info({ to, deliveryId: result.data?.id }, '[email] password reset email enviado');
    return { ok: true, deliveryId: result.data?.id };
  } catch (err) {
    logger.error({ err, to }, '[email] excepción al enviar password reset email');
    return { ok: false, deliveryId: null, error: err.message };
  }
}

/** Para tests: snapshot read-only de los emails enviados en la suite. */
function _getTestQueue() { return _testQueue.slice(); }

/** Para tests: vaciar la queue entre tests (idempotente). */
function _resetTestQueue() { _testQueue.length = 0; }

module.exports = {
  sendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  _getTestQueue,
  _resetTestQueue,
};

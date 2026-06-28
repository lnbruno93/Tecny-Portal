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
  return process.env.EMAIL_FROM || 'Tecny <onboarding@resend.dev>';
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
<title>Verificá tu email — Tecny</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1a14;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.05);">
        <tr><td style="padding:32px 36px 24px;border-bottom:1px solid #f0ead6;">
          <div style="display:inline-block;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#fff;line-height:36px;text-align:center;font-weight:800;font-size:18px;letter-spacing:-0.04em;">T</div>
          <span style="display:inline-block;vertical-align:middle;margin-left:12px;font-weight:700;font-size:17px;color:#0d1220;">Tecny</span>
        </td></tr>
        <tr><td style="padding:36px 36px 12px;">
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0d1220;">Verificá tu email</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#3f3a2c;">Te diste de alta en Tecny. Para empezar a operar (crear ventas, comprobantes, etc.), confirmanos que el email es tuyo:</p>
          <p style="margin:0 0 24px;text-align:center;">
            <a href="${_esc(verifyUrl)}" style="display:inline-block;padding:13px 28px;background:#0ea5e9;color:#ffffff;text-decoration:none;border-radius:9px;font-weight:700;font-size:15px;letter-spacing:-0.005em;">Verificar email →</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#76705c;">Si el botón no abre, copiá este link en tu navegador:</p>
          <p style="margin:0 0 24px;font-size:12.5px;line-height:1.45;color:#0ea5e9;word-break:break-all;">${_esc(verifyUrl)}</p>
          <p style="margin:0;font-size:13px;line-height:1.55;color:#76705c;">El link vence en 24 horas. Si no creaste vos esta cuenta, podés ignorar este email.</p>
        </td></tr>
        <tr><td style="padding:20px 36px 32px;border-top:1px solid #f0ead6;font-size:12px;color:#9c957f;text-align:center;">
          Tecny
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

Te diste de alta en Tecny. Para empezar a operar (crear ventas, comprobantes, etc.), confirmanos tu email abriendo este link:

${verifyUrl}

El link vence en 24 horas. Si no creaste vos esta cuenta, ignorá este email.

— Tecny`;
}

function _welcomeHtml({ name }) {
  const greeting = name ? `Hola ${_esc(name)},` : 'Hola,';
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Bienvenido a Tecny</title></head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1a14;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:32px 36px 24px;border-bottom:1px solid #f0ead6;">
          <div style="display:inline-block;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#fff;line-height:36px;text-align:center;font-weight:800;font-size:18px;letter-spacing:-0.04em;">T</div>
          <span style="display:inline-block;vertical-align:middle;margin-left:12px;font-weight:700;font-size:17px;color:#0d1220;">Tecny</span>
        </td></tr>
        <tr><td style="padding:36px 36px 24px;">
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0d1220;">¡Listo! Cuenta verificada ✓</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">Ya podés usar el portal sin restricciones — crear ventas, registrar pagos, gestionar inventario y todo lo demás.</p>
          <p style="margin:0;font-size:13px;line-height:1.55;color:#76705c;">¿Algún problema? Respondé a este email y te ayudamos.</p>
        </td></tr>
        <tr><td style="padding:20px 36px 32px;border-top:1px solid #f0ead6;font-size:12px;color:#9c957f;text-align:center;">
          Tecny
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

¡Listo! Tu cuenta de Tecny está verificada. Ya podés operar sin restricciones — crear ventas, registrar pagos, gestionar inventario y todo lo demás.

¿Algún problema? Respondé a este email.

— Tecny`;
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
      subject: 'Verificá tu email — Tecny',
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
      subject: '¡Bienvenido a Tecny!',
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
<title>Resetear contraseña — Tecny</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1a14;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.05);">
        <tr><td style="padding:32px 36px 24px;border-bottom:1px solid #f0ead6;">
          <div style="display:inline-block;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#fff;line-height:36px;text-align:center;font-weight:800;font-size:18px;letter-spacing:-0.04em;">T</div>
          <span style="display:inline-block;vertical-align:middle;margin-left:12px;font-weight:700;font-size:17px;color:#0d1220;">Tecny</span>
        </td></tr>
        <tr><td style="padding:36px 36px 12px;">
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0d1220;">Resetear tu contraseña</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#3f3a2c;">Recibimos una solicitud para resetear la contraseña de tu cuenta en Tecny. Si fuiste vos, hacé click para elegir una nueva:</p>
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

Recibimos una solicitud para resetear la contraseña de tu cuenta en Tecny.

Si fuiste vos, abrí este link para elegir una nueva:
${resetUrl}

El link vence en ${ttlHours} ${ttlHours === 1 ? 'hora' : 'horas'}.

Si no pediste vos este reset, ignorá este email. Tu contraseña actual sigue funcionando.

— Tecny`;
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
      subject: 'Resetear contraseña — Tecny',
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

// ── Paid-until warning (TANDA 4.D billing pre-live 2026-06-25) ──────────

function _paidUntilWarningHtml({ name, daysLeft, paidUntilDate, tenantName }) {
  const greeting = name ? `Hola ${_esc(name)},` : 'Hola,';
  const venceTxt = daysLeft === 0 ? 'vence <strong>hoy</strong>'
                 : daysLeft === 1 ? 'vence <strong>mañana</strong>'
                 : `vence en <strong>${daysLeft} días</strong>`;
  const tenantBlock = tenantName
    ? `<p style="margin: 8px 0; color: #6b7280; font-size: 14px;">Cuenta: <strong>${_esc(tenantName)}</strong></p>`
    : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
  <h2 style="color: #b45309; margin-top: 0;">Tu cuenta de Tecny Portal ${venceTxt}</h2>
  <p>${greeting}</p>
  ${tenantBlock}
  <p>Te avisamos que tu período pagado ${venceTxt}, el <strong>${_esc(paidUntilDate)}</strong>.</p>
  <p>Para seguir operando sin interrupciones, escribinos a <a href="mailto:hola@tecnyapp.com?subject=Renovaci%C3%B3n%20Tecny%20Portal">hola@tecnyapp.com</a> y coordinamos la renovación.</p>
  <p style="margin-top: 24px; color: #6b7280; font-size: 13px;">Si ya pagaste y no procesamos el cobro todavía, ignorá este mensaje — te avisamos cuando lo veamos.</p>
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 28px 0 16px;">
  <p style="color: #6b7280; font-size: 12px;">Tecny — Portal de gestión para revendedores de tecnología.</p>
</body></html>`;
}

function _paidUntilWarningText({ name, daysLeft, paidUntilDate, tenantName }) {
  const greeting = name ? `Hola ${name},` : 'Hola,';
  const venceTxt = daysLeft === 0 ? 'vence HOY'
                 : daysLeft === 1 ? 'vence MAÑANA'
                 : `vence en ${daysLeft} días`;
  const tenantLine = tenantName ? `\nCuenta: ${tenantName}\n` : '\n';
  return `${greeting}
${tenantLine}
Te avisamos que tu período pagado de Tecny Portal ${venceTxt}, el ${paidUntilDate}.

Para seguir operando sin interrupciones, escribinos a hola@tecnyapp.com
y coordinamos la renovación.

Si ya pagaste y no procesamos el cobro todavía, ignorá este mensaje —
te avisamos cuando lo veamos.

—
Tecny — Portal de gestión para revendedores de tecnología.`;
}

/**
 * Email de warning "tu cuenta vence en N días".
 *
 * @param {object} opts
 * @param {string} opts.to            — email destinatario.
 * @param {string} [opts.name]        — nombre del user (opcional, para personalizar).
 * @param {number} opts.daysLeft      — días restantes hasta paid_until (0=hoy, 1=mañana, ...).
 * @param {string} opts.paidUntilDate — fecha formateada DD/MM/YYYY para el cuerpo.
 * @param {string} [opts.tenantName]  — nombre del tenant (opcional, para clarificar cuando el user tiene acceso a varios).
 * @returns {Promise<{ok, deliveryId, error?}>}
 */
async function sendPaidUntilWarningEmail({ to, name, daysLeft, paidUntilDate, tenantName }) {
  if (!to || daysLeft == null || !paidUntilDate) {
    throw new Error('sendPaidUntilWarningEmail: `to`, `daysLeft`, `paidUntilDate` requeridos');
  }
  const payload = {
    type:           'paid_until_warning',
    from:           _emailFrom(),
    to,
    name:           name || null,
    daysLeft,
    paidUntilDate,
    tenantName:     tenantName || null,
    sentAt:         new Date().toISOString(),
  };

  if (isTest()) {
    _testQueue.push(payload);
    return { ok: true, deliveryId: 'test-' + Date.now() };
  }

  const resend = _getResend();
  if (!resend) {
    logger.warn({ to, daysLeft }, '[email] RESEND_API_KEY no seteada — paid_until warning no se envió (modo stub)');
    return { ok: true, deliveryId: 'stub-' + Date.now() };
  }

  const subject = daysLeft === 0
    ? 'Tu cuenta de Tecny vence hoy'
    : daysLeft === 1
      ? 'Tu cuenta de Tecny vence mañana'
      : `Tu cuenta de Tecny vence en ${daysLeft} días`;

  try {
    const result = await resend.emails.send({
      from:    _emailFrom(),
      to,
      subject,
      html:    _paidUntilWarningHtml({ name, daysLeft, paidUntilDate, tenantName }),
      text:    _paidUntilWarningText({ name, daysLeft, paidUntilDate, tenantName }),
    });
    if (result.error) {
      logger.error({ err: result.error, to }, '[email] Resend error en paid_until warning');
      return { ok: false, deliveryId: null, error: result.error.message || 'Resend error' };
    }
    logger.info({ to, daysLeft, deliveryId: result.data?.id }, '[email] paid_until warning enviado');
    return { ok: true, deliveryId: result.data?.id };
  } catch (err) {
    logger.error({ err, to }, '[email] excepción al enviar paid_until warning');
    return { ok: false, deliveryId: null, error: err.message };
  }
}

// ── Red B2B F5 (TANDA F5 #458 2026-06-29) ───────────────────────────────
//
// 5 templates de email para los events críticos de Red B2B cross-tenant
// (decisión #13 del doc):
//   - invitation_received  → "Te invitaron a Red B2B"
//   - invitation_accepted  → "Aceptaron tu invitación"
//   - operation_received   → "Recibiste una venta de USD X"
//   - operation_cancelled  → "Cancelaron la venta"
//   - payment_received     → "Te pagaron / Pagaste"
//
// Patrón idéntico a las funciones existentes:
//   - test mode → push a _testQueue
//   - sin RESEND_API_KEY → stub mode (log + retorna ok stub-...)
//   - resend errors → log + retorna { ok: false, error }
//   - HTML + text con _esc() en variables (sin XSS en clients de email)
//
// Branding consistente: misma estructura HTML que verification/welcome
// (header con logo Tecny, body con CTA al portal, footer plain).
//
// Caller pattern (en partnerships.js / operations.js / pagos.js): fire-and-
// forget desde setImmediate AFTER el COMMIT de la tx. Si el email falla, la
// notification in-app ya quedó persistida — el operador la ve igual.

function _redB2bShellHtml({ title, bodyHtml, ctaUrl, ctaLabel }) {
  // Shell común a los 5 templates Red B2B. Cambia solo title + bodyHtml + cta.
  const ctaBlock = ctaUrl
    ? `<p style="margin:0 0 24px;text-align:center;">
         <a href="${_esc(ctaUrl)}" style="display:inline-block;padding:13px 28px;background:#0ea5e9;color:#ffffff;text-decoration:none;border-radius:9px;font-weight:700;font-size:15px;letter-spacing:-0.005em;">${_esc(ctaLabel || 'Abrir Red B2B')} →</a>
       </p>`
    : '';
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${_esc(title)} — Tecny</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1a14;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.05);">
        <tr><td style="padding:32px 36px 24px;border-bottom:1px solid #f0ead6;">
          <div style="display:inline-block;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#fff;line-height:36px;text-align:center;font-weight:800;font-size:18px;letter-spacing:-0.04em;">T</div>
          <span style="display:inline-block;vertical-align:middle;margin-left:12px;font-weight:700;font-size:17px;color:#0d1220;">Tecny <span style="font-weight:500;color:#76705c;font-size:14px;">· Red B2B</span></span>
        </td></tr>
        <tr><td style="padding:36px 36px 12px;">
          <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0d1220;">${_esc(title)}</h1>
          ${bodyHtml}
          ${ctaBlock}
          <p style="margin:0;font-size:12px;line-height:1.55;color:#9c957f;">Recibís este email porque tenés Red B2B activado en tu cuenta de Tecny. Podés desactivar estos avisos desde Red B2B → Config.</p>
        </td></tr>
        <tr><td style="padding:20px 36px 32px;border-top:1px solid #f0ead6;font-size:12px;color:#9c957f;text-align:center;">
          Tecny
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function _portalBaseUrl() {
  // Frontend URL para deep-links. Default seguro: el dominio prod tecnyapp.com.
  // En staging/dev override via FRONTEND_URL env.
  return (process.env.FRONTEND_URL || 'https://app.tecnyapp.com').replace(/\/+$/, '');
}

function _fmtUsd(n) {
  if (n == null || isNaN(n)) return 'USD —';
  return 'USD ' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _fmtArs(n) {
  if (n == null || isNaN(n)) return '';
  return '$ ' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Wrapper común para los 5 senders: maneja test mode, stub mode, Resend send
// y errores con el mismo pattern que las funciones existentes (DRY).
async function _sendRedB2bEmail({ type, to, subject, html, text, payload }) {
  if (isTest()) {
    _testQueue.push({ type, from: _emailFrom(), to, ...payload, sentAt: new Date().toISOString() });
    return { ok: true, deliveryId: 'test-' + Date.now() };
  }
  const resend = _getResend();
  if (!resend) {
    logger.warn({ to, type }, `[email] RESEND_API_KEY no seteada — ${type} no se envió (modo stub)`);
    return { ok: true, deliveryId: 'stub-' + Date.now() };
  }
  try {
    const result = await resend.emails.send({
      from: _emailFrom(),
      to,
      subject,
      html,
      text,
    });
    if (result.error) {
      logger.error({ err: result.error, to, type }, `[email] Resend error en ${type}`);
      return { ok: false, deliveryId: null, error: result.error.message || 'Resend error' };
    }
    logger.info({ to, type, deliveryId: result.data?.id }, `[email] ${type} enviado`);
    return { ok: true, deliveryId: result.data?.id };
  } catch (err) {
    logger.error({ err, to, type }, `[email] excepción al enviar ${type}`);
    return { ok: false, deliveryId: null, error: err.message };
  }
}

/**
 * Email: "X te invitó a Red B2B" — al lado receptor de la invitación.
 *
 * @param {object} args
 * @param {string} args.to            — email del owner del tenant invitado
 * @param {string} [args.name]        — nombre del receptor (saludo)
 * @param {string} args.partnerNombre — nombre del tenant que invitó
 * @param {string} [args.invitationMessage] — mensaje opcional del invitador
 * @param {number} [args.partnershipId]    — para deep-link al inbox
 */
async function sendRedB2BInvitationReceivedEmail({ to, name, partnerNombre, invitationMessage, partnershipId }) {
  if (!to || !partnerNombre) {
    throw new Error('sendRedB2BInvitationReceivedEmail: `to` y `partnerNombre` son requeridos');
  }
  const greeting = name ? `Hola ${_esc(name)},` : 'Hola,';
  const msgBlock = invitationMessage
    ? `<blockquote style="margin:0 0 20px;padding:12px 16px;border-left:3px solid #0ea5e9;background:#f0f9ff;color:#0d1220;font-size:14px;line-height:1.55;font-style:italic;">${_esc(invitationMessage)}</blockquote>`
    : '';
  const ctaUrl = `${_portalBaseUrl()}/red-b2b${partnershipId ? `?partnership=${Number(partnershipId)}` : ''}`;
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;"><strong>${_esc(partnerNombre)}</strong> te invitó a una partnership de Red B2B en Tecny — operar ventas cross-tenant entre ambos negocios con CC sincronizada.</p>
    ${msgBlock}
    <p style="margin:0 0 24px;font-size:14px;line-height:1.55;color:#76705c;">Al aceptar, las ventas que ${_esc(partnerNombre)} te haga se replicarán automáticamente como compras en tu inventario y CC. Podés revocar cuando quieras.</p>`;
  const html = _redB2bShellHtml({
    title: `${partnerNombre} te invitó a Red B2B`,
    bodyHtml,
    ctaUrl,
    ctaLabel: 'Ver invitación',
  });
  const text = `${name ? `Hola ${name},` : 'Hola,'}

${partnerNombre} te invitó a una partnership de Red B2B en Tecny — operar ventas cross-tenant entre ambos negocios con CC sincronizada.

${invitationMessage ? `Mensaje: "${invitationMessage}"\n\n` : ''}Al aceptar, las ventas que ${partnerNombre} te haga se replicarán automáticamente como compras en tu inventario y CC. Podés revocar cuando quieras.

Ver invitación: ${ctaUrl}

— Tecny
Podés desactivar estos avisos desde Red B2B → Config.`;
  return _sendRedB2bEmail({
    type:    'red_b2b_invitation_received',
    to,
    subject: `${partnerNombre} te invitó a Red B2B`,
    html,
    text,
    payload: { name: name || null, partnerNombre, invitationMessage: invitationMessage || null, partnershipId: partnershipId || null },
  });
}

/**
 * Email: "Y aceptó tu invitación a Red B2B" — al invitador.
 */
async function sendRedB2BInvitationAcceptedEmail({ to, name, partnerNombre, partnershipId }) {
  if (!to || !partnerNombre) {
    throw new Error('sendRedB2BInvitationAcceptedEmail: `to` y `partnerNombre` son requeridos');
  }
  const greeting = name ? `Hola ${_esc(name)},` : 'Hola,';
  const ctaUrl = `${_portalBaseUrl()}/red-b2b${partnershipId ? `?partnership=${Number(partnershipId)}` : ''}`;
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;"><strong>${_esc(partnerNombre)}</strong> aceptó tu invitación a Red B2B. Ya podés cargar ventas cross-tenant y se replicarán automáticamente del otro lado.</p>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.55;color:#76705c;">Te recomendamos confirmar la primera venta de prueba con un monto chico para que ambos verifiquen que los movimientos se replican OK.</p>`;
  const html = _redB2bShellHtml({
    title: `${partnerNombre} aceptó tu invitación`,
    bodyHtml,
    ctaUrl,
    ctaLabel: 'Cargar primera venta',
  });
  const text = `${name ? `Hola ${name},` : 'Hola,'}

${partnerNombre} aceptó tu invitación a Red B2B. Ya podés cargar ventas cross-tenant y se replicarán automáticamente del otro lado.

Te recomendamos confirmar la primera venta de prueba con un monto chico para que ambos verifiquen que los movimientos se replican OK.

Abrir Red B2B: ${ctaUrl}

— Tecny
Podés desactivar estos avisos desde Red B2B → Config.`;
  return _sendRedB2bEmail({
    type:    'red_b2b_invitation_accepted',
    to,
    subject: `${partnerNombre} aceptó tu invitación a Red B2B`,
    html,
    text,
    payload: { name: name || null, partnerNombre, partnershipId: partnershipId || null },
  });
}

/**
 * Email: "Recibiste una venta cross-tenant de USD X" — al buyer.
 *
 * @param {object} args
 * @param {string} args.to            — email del owner del buyer
 * @param {string} [args.name]
 * @param {string} args.partnerNombre — nombre del seller
 * @param {number} args.totalUsd      — total de la operación en USD
 * @param {number} [args.totalArs]    — total al TC de la venta (informativo)
 * @param {number} args.itemsCount    — cantidad de items
 * @param {number} args.operationId   — para deep-link
 */
async function sendRedB2BOperationReceivedEmail({ to, name, partnerNombre, totalUsd, totalArs, itemsCount, operationId }) {
  if (!to || !partnerNombre || totalUsd == null || !operationId) {
    throw new Error('sendRedB2BOperationReceivedEmail: `to`, `partnerNombre`, `totalUsd`, `operationId` son requeridos');
  }
  const greeting = name ? `Hola ${_esc(name)},` : 'Hola,';
  const ctaUrl = `${_portalBaseUrl()}/red-b2b/operaciones/${Number(operationId)}`;
  const itemsTxt = itemsCount === 1 ? '1 producto' : `${Number(itemsCount)} productos`;
  const arsBlock = totalArs
    ? `<p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#76705c;">Equivalente: ${_esc(_fmtArs(totalArs))} al TC informado.</p>`
    : '';
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;"><strong>${_esc(partnerNombre)}</strong> te envió una venta cross-tenant. Se registró como una compra en tu Red B2B + Proveedores.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;width:100%;background:#f8fafc;border-radius:8px;">
      <tr><td style="padding:14px 18px;font-size:15px;color:#0d1220;">
        <div style="font-weight:700;font-size:18px;letter-spacing:-0.01em;">${_esc(_fmtUsd(totalUsd))}</div>
        <div style="margin-top:4px;font-size:13px;color:#76705c;">${itemsTxt} · Operación #${Number(operationId)}</div>
      </td></tr>
    </table>
    ${arsBlock}
    <p style="margin:0 0 24px;font-size:14px;line-height:1.55;color:#76705c;">Los productos quedan marcados como "pendientes de revisión" en tu inventario hasta que los mergees con tu catálogo o los confirmes como nuevos.</p>`;
  const html = _redB2bShellHtml({
    title: `Recibiste una venta de ${_fmtUsd(totalUsd)}`,
    bodyHtml,
    ctaUrl,
    ctaLabel: 'Ver operación',
  });
  const text = `${name ? `Hola ${name},` : 'Hola,'}

${partnerNombre} te envió una venta cross-tenant por ${_fmtUsd(totalUsd)} (${itemsTxt}).
${totalArs ? `Equivalente: ${_fmtArs(totalArs)} al TC informado.\n` : ''}
Se registró como compra en tu Red B2B + Proveedores. Los productos quedan marcados como "pendientes de revisión" hasta que los mergees con tu catálogo o los confirmes como nuevos.

Ver operación: ${ctaUrl}

— Tecny
Podés desactivar estos avisos desde Red B2B → Config.`;
  return _sendRedB2bEmail({
    type:    'red_b2b_operation_received',
    to,
    subject: `${partnerNombre} te envió una venta de ${_fmtUsd(totalUsd)}`,
    html,
    text,
    payload: {
      name:   name || null,
      partnerNombre,
      totalUsd,
      totalArs: totalArs || null,
      itemsCount,
      operationId,
    },
  });
}

/**
 * Email: "Cancelaron la venta cross-tenant" — al buyer.
 */
async function sendRedB2BOperationCancelledEmail({ to, name, partnerNombre, totalUsd, operationId, reason }) {
  if (!to || !partnerNombre || !operationId) {
    throw new Error('sendRedB2BOperationCancelledEmail: `to`, `partnerNombre`, `operationId` son requeridos');
  }
  const greeting = name ? `Hola ${_esc(name)},` : 'Hola,';
  const ctaUrl = `${_portalBaseUrl()}/red-b2b/operaciones/${Number(operationId)}`;
  const reasonBlock = reason
    ? `<blockquote style="margin:0 0 20px;padding:12px 16px;border-left:3px solid #f59e0b;background:#fffbeb;color:#92400e;font-size:14px;line-height:1.55;">Motivo: ${_esc(reason)}</blockquote>`
    : '';
  const usdBlock = totalUsd != null
    ? ` por <strong>${_esc(_fmtUsd(totalUsd))}</strong>`
    : '';
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;"><strong>${_esc(partnerNombre)}</strong> canceló la operación cross-tenant #${Number(operationId)}${usdBlock}.</p>
    ${reasonBlock}
    <p style="margin:0 0 24px;font-size:14px;line-height:1.55;color:#76705c;">Tu compra + CC del proveedor se revirtieron automáticamente. Si tu stock de los productos quedó en negativo (porque ya los vendiste), aparece un warning en la operación.</p>`;
  const html = _redB2bShellHtml({
    title: `${partnerNombre} canceló una operación`,
    bodyHtml,
    ctaUrl,
    ctaLabel: 'Ver detalles',
  });
  const text = `${name ? `Hola ${name},` : 'Hola,'}

${partnerNombre} canceló la operación cross-tenant #${operationId}${totalUsd != null ? ` por ${_fmtUsd(totalUsd)}` : ''}.
${reason ? `Motivo: ${reason}\n` : ''}
Tu compra + CC del proveedor se revirtieron automáticamente. Si tu stock de los productos quedó en negativo (porque ya los vendiste), aparece un warning en la operación.

Ver detalles: ${ctaUrl}

— Tecny
Podés desactivar estos avisos desde Red B2B → Config.`;
  return _sendRedB2bEmail({
    type:    'red_b2b_operation_cancelled',
    to,
    subject: `${partnerNombre} canceló una operación Red B2B`,
    html,
    text,
    payload: {
      name:   name || null,
      partnerNombre,
      totalUsd: totalUsd != null ? totalUsd : null,
      operationId,
      reason:  reason || null,
    },
  });
}

/**
 * Email: "Te pagaron / Pagaste" — al lado opuesto del que registró el pago.
 *
 * Si side='seller' (el seller registró un cobro): el buyer recibe "Te pagamos".
 * Si side='buyer' (el buyer registró un pago): el seller recibe "Te pagaron".
 * En ambos casos la función es la misma — el caller decide el "to" y el
 * "partnerNombre" (el otro lado de la operación). El subject usa
 * "Te pagaron / Pagaste" según `iWasPaid` (true = soy el receptor del dinero).
 */
async function sendRedB2BPaymentReceivedEmail({ to, name, partnerNombre, montoUsd, monedaPago, operationId, iWasPaid }) {
  if (!to || !partnerNombre || montoUsd == null || !operationId) {
    throw new Error('sendRedB2BPaymentReceivedEmail: `to`, `partnerNombre`, `montoUsd`, `operationId` son requeridos');
  }
  const greeting = name ? `Hola ${_esc(name)},` : 'Hola,';
  const ctaUrl = `${_portalBaseUrl()}/red-b2b/operaciones/${Number(operationId)}`;
  const monedaBlock = monedaPago && monedaPago !== 'USD'
    ? ` <span style="color:#76705c;font-size:13px;">(pago en ${_esc(monedaPago)})</span>`
    : '';
  const verb = iWasPaid ? 'te pagó' : 'registraste un pago a';
  const subjVerb = iWasPaid ? 'Te pagaron' : 'Registraste un pago';
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;"><strong>${_esc(partnerNombre)}</strong> ${verb} <strong>${_esc(_fmtUsd(montoUsd))}</strong>${monedaBlock} sobre la operación #${Number(operationId)}.</p>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.55;color:#76705c;">El movimiento se replicó del lado opuesto: ${iWasPaid ? 'tu CC del cliente bajó por ese monto' : 'tu CC del proveedor bajó por ese monto'}.</p>`;
  const html = _redB2bShellHtml({
    title: `${subjVerb}: ${_fmtUsd(montoUsd)}`,
    bodyHtml,
    ctaUrl,
    ctaLabel: 'Ver operación',
  });
  const text = `${name ? `Hola ${name},` : 'Hola,'}

${partnerNombre} ${verb} ${_fmtUsd(montoUsd)}${monedaPago && monedaPago !== 'USD' ? ` (pago en ${monedaPago})` : ''} sobre la operación #${operationId}.

El movimiento se replicó del lado opuesto: ${iWasPaid ? 'tu CC del cliente bajó por ese monto' : 'tu CC del proveedor bajó por ese monto'}.

Ver operación: ${ctaUrl}

— Tecny
Podés desactivar estos avisos desde Red B2B → Config.`;
  return _sendRedB2bEmail({
    type:    'red_b2b_payment_received',
    to,
    subject: `${subjVerb}: ${_fmtUsd(montoUsd)} — ${partnerNombre}`,
    html,
    text,
    payload: {
      name:    name || null,
      partnerNombre,
      montoUsd,
      monedaPago: monedaPago || 'USD',
      operationId,
      iWasPaid: !!iWasPaid,
    },
  });
}

/** Para tests: snapshot read-only de los emails enviados en la suite. */
function _getTestQueue() { return _testQueue.slice(); }

/** Para tests: vaciar la queue entre tests (idempotente). */
function _resetTestQueue() { _testQueue.length = 0; }

module.exports = {
  sendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendPaidUntilWarningEmail,
  // Red B2B F5 (#458)
  sendRedB2BInvitationReceivedEmail,
  sendRedB2BInvitationAcceptedEmail,
  sendRedB2BOperationReceivedEmail,
  sendRedB2BOperationCancelledEmail,
  sendRedB2BPaymentReceivedEmail,
  _getTestQueue,
  _resetTestQueue,
  // Helpers exportados solo para que los tests puedan snapshotear el HTML
  // (ONB-1 audit pre-live 2026-06-24: verificamos que el logo refleja Tecny,
  // no "iP" residual del rebrand). No usar fuera de tests.
  _verificationHtml,
  _welcomeHtml,
  _passwordResetHtml,
  _paidUntilWarningHtml,
};

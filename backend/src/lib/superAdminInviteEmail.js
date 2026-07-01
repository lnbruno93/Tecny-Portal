/**
 * Email de invitación a co-super-admin (#499).
 *
 * Interfaz:
 *   sendSuperAdminInviteEmail({ to, nombre, invitedBy, acceptUrl }) → { ok, deliveryId, error? }
 *
 * Mismo patrón que `lib/email.js` (verification/welcome/password-reset):
 *   - Modo test (NODE_ENV=test) → push a _testQueue. Los tests lo inspeccionan.
 *   - Modo stub (sin RESEND_API_KEY) → log warn + return ok stub-*. Útil en dev
 *     local sin cuenta Resend.
 *   - Modo Resend (con API key) → send real. Errores del provider NO throw:
 *     devolvemos { ok:false, error } y el caller (POST /invite) responde 201
 *     igual — la invite queda persistida, el super-admin ve el email pending
 *     y puede reenviar desde la UI.
 *
 * Sender: EMAIL_FROM env (fallback onboarding@resend.dev). Mismo del portal —
 * el super-admin del back office no distingue "invite" vs "signup" del portal.
 *
 * Env vars usadas:
 *   - RESEND_API_KEY      → ver lib/email.js
 *   - EMAIL_FROM          → ver lib/email.js
 *   - ADMIN_FRONTEND_URL  → base para el link de aceptación. Default
 *                            'https://admin.tecnyapp.com'. En staging/dev
 *                            se puede override para apuntar a
 *                            admin-staging.tecnyapp.com o localhost:5173.
 *
 * Diseño defensivo:
 *   - _esc() de todo lo interpolado en HTML (nombre, invitedBy, acceptUrl) —
 *     mismo escape que `lib/email.js` (5 chars). El nombre y el usuario del
 *     invitador vienen de DB donde el operador humano los tipeó, así que
 *     un atacante con acceso a modificar users.username (raro) podría meter
 *     `<script>`. El escape es defense-in-depth: los clients de email
 *     bloquean JS igual, pero rendering roto en Gmail es peor UX que
 *     escapar preventivamente.
 */

const logger = require('./logger');

// Resend lazy-required (mismo patrón que lib/email.js). Cache singleton.
let _resendClient = null;
function _getResend() {
  if (_resendClient) return _resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  const { Resend } = require('resend');
  _resendClient = new Resend(apiKey);
  return _resendClient;
}

const _testQueue = [];

function isTest() {
  return process.env.NODE_ENV === 'test';
}

function _emailFrom() {
  return process.env.EMAIL_FROM || 'Tecny <onboarding@resend.dev>';
}

/**
 * Base URL del admin frontend para armar el acceptUrl.
 *
 * Sin trailing slash — el caller concatena `/aceptar-invitacion?token=…`
 * directo. Fallback a admin.tecnyapp.com (prod). En staging se pone
 * ADMIN_FRONTEND_URL=https://admin-staging.tecnyapp.com en Railway;
 * en dev local, http://localhost:5174 (o el puerto de vite del
 * admin-frontend).
 *
 * Exportado para que los routes puedan armar el acceptUrl sin duplicar
 * lógica de trim.
 */
function adminFrontendUrl() {
  return (process.env.ADMIN_FRONTEND_URL || 'https://admin.tecnyapp.com').replace(/\/+$/, '');
}

// Escape defensivo — evita break-out de atributos HTML (href="…", title="…")
// via inyección de `"` o `'`. Idéntico al _esc de lib/email.js. Duplicado en
// vez de importar porque el módulo email.js es grande y no queríamos que
// este archivo dependa de exports internos.
function _esc(s) {
  if (s == null) return '';
  return String(s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;',
    '"': '&quot;', "'": '&#39;'
  }[c]));
}

function _inviteHtml({ nombre, invitedBy, acceptUrl }) {
  const greeting = nombre ? `Hola ${_esc(nombre)},` : 'Hola,';
  const invitedByEsc = _esc(invitedBy || 'Un super-admin de Tecny');
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invitación a Tecny Admin</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1a14;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.05);">
        <tr><td style="padding:32px 36px 24px;border-bottom:1px solid #f0ead6;">
          <div style="display:inline-block;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#fff;line-height:36px;text-align:center;font-weight:800;font-size:18px;letter-spacing:-0.04em;">T</div>
          <span style="display:inline-block;vertical-align:middle;margin-left:12px;font-weight:700;font-size:17px;color:#0d1220;">Tecny <span style="font-weight:500;color:#76705c;font-size:14px;">· Admin</span></span>
        </td></tr>
        <tr><td style="padding:36px 36px 12px;">
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0d1220;">Fuiste invitado como admin de Tecny</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;">${greeting}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3f3a2c;"><strong>${invitedByEsc}</strong> te invitó a ser admin de Tecny.</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#3f3a2c;">Como admin vas a poder ver el estado de los clientes, gestionar planes y ayudar en soporte desde el back office.</p>
          <p style="margin:0 0 24px;text-align:center;">
            <a href="${_esc(acceptUrl)}" style="display:inline-block;padding:13px 28px;background:#0ea5e9;color:#ffffff;text-decoration:none;border-radius:9px;font-weight:700;font-size:15px;letter-spacing:-0.005em;">Aceptar invitación →</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#76705c;">Si el botón no abre, copiá este link en tu navegador:</p>
          <p style="margin:0 0 24px;font-size:12.5px;line-height:1.45;color:#0ea5e9;word-break:break-all;">${_esc(acceptUrl)}</p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#76705c;">El link expira en 48 horas.</p>
          <p style="margin:0;font-size:13px;line-height:1.55;color:#76705c;">Si no esperabas esto, ignorá este email.</p>
        </td></tr>
        <tr><td style="padding:20px 36px 32px;border-top:1px solid #f0ead6;font-size:12px;color:#9c957f;text-align:center;">
          — Tecny
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function _inviteText({ nombre, invitedBy, acceptUrl }) {
  const greeting = nombre ? `Hola ${nombre},` : 'Hola,';
  const inv = invitedBy || 'Un super-admin de Tecny';
  return `${greeting}

${inv} te invitó a ser admin de Tecny.

Como admin vas a poder ver el estado de los clientes, gestionar planes y ayudar en soporte desde el back office.

Aceptá la invitación abriendo este link:
${acceptUrl}

El link expira en 48 horas.

Si no esperabas esto, ignorá este email.

— Tecny`;
}

/**
 * @param {object} args
 * @param {string} args.to         — email del invitado
 * @param {string} [args.nombre]   — nombre del invitado (para saludar)
 * @param {string} [args.invitedBy] — username o nombre del super-admin emisor
 * @param {string} args.acceptUrl  — link completo con ?token=…
 * @returns {Promise<{ok:boolean, deliveryId:string|null, error?:string}>}
 */
async function sendSuperAdminInviteEmail({ to, nombre, invitedBy, acceptUrl }) {
  if (!to || !acceptUrl) {
    throw new Error('sendSuperAdminInviteEmail: `to` y `acceptUrl` son requeridos');
  }

  const payload = {
    type:      'super_admin_invite',
    from:      _emailFrom(),
    to,
    nombre:    nombre || null,
    invitedBy: invitedBy || null,
    acceptUrl,
    sentAt:    new Date().toISOString(),
  };

  if (isTest()) {
    _testQueue.push(payload);
    return { ok: true, deliveryId: 'test-' + Date.now() };
  }

  const resend = _getResend();
  if (!resend) {
    logger.warn({ to }, '[email] RESEND_API_KEY no seteada — super admin invite no se envió (modo stub)');
    return { ok: true, deliveryId: 'stub-' + Date.now() };
  }

  try {
    const result = await resend.emails.send({
      from:    _emailFrom(),
      to,
      subject: 'Fuiste invitado como admin de Tecny',
      html:    _inviteHtml({ nombre, invitedBy, acceptUrl }),
      text:    _inviteText({ nombre, invitedBy, acceptUrl }),
    });
    if (result.error) {
      logger.error({ err: result.error, to }, '[email] Resend error en super admin invite');
      return { ok: false, deliveryId: null, error: result.error.message || 'Resend error' };
    }
    logger.info({ to, deliveryId: result.data?.id }, '[email] super admin invite enviado');
    return { ok: true, deliveryId: result.data?.id };
  } catch (err) {
    logger.error({ err, to }, '[email] excepción al enviar super admin invite');
    return { ok: false, deliveryId: null, error: err.message };
  }
}

/** Tests only: snapshot read-only de los emails enviados. */
function _getTestQueue() { return _testQueue.slice(); }
/** Tests only: reset entre tests. */
function _resetTestQueue() { _testQueue.length = 0; }

module.exports = {
  sendSuperAdminInviteEmail,
  adminFrontendUrl,
  _getTestQueue,
  _resetTestQueue,
  // Export para tests que snapshotean el HTML (opcional).
  _inviteHtml,
  _esc,
};

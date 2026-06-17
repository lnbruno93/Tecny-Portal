/**
 * Email service wrapper (TANDA 2.1 stub).
 *
 * Interfaz:
 *   - sendVerificationEmail({ to, name, verifyUrl })
 *   - sendWelcomeEmail({ to, name })
 *
 * Provider:
 *   - PR 2.1 (este archivo): stub. Loguea con pino + en NODE_ENV=test guarda
 *     en una in-memory queue inspeccionable por tests.
 *   - PR 2.2: reemplaza el body de cada función con Resend API call. La
 *     interfaz se mantiene — el route que llama (signup.js) no cambia.
 *
 * Por qué stub en PR 2.1:
 *   - Permite testear la lógica de signup + verification sin depender de un
 *     provider de email real (DKIM, SPF, sender domain, etc. son setup de PR 2.2).
 *   - El stub NO bloquea el flujo: signup completa, devuelve el token de
 *     verificación al cliente para que el frontend lo use directamente en
 *     development / E2E (sin esperar email real).
 *
 * Test inspection:
 *   - `_getTestQueue()` → array de payloads enviados (NODE_ENV=test).
 *   - `_resetTestQueue()` → vacía entre tests.
 *
 * Decisiones durables:
 *   - El `from` viene de EMAIL_FROM env. Default `noreply@ipro-portal.local`
 *     hasta que tengamos un dominio real con DKIM.
 *   - Errores del provider NO bloquean el response del endpoint que llama.
 *     El user recibe success en signup aunque el email haya fallado — puede
 *     reenviar con /resend-verification. Trade-off: log el error a Sentry
 *     pero no propagamos al user.
 */

const logger = require('./logger');

const _testQueue = [];

function isTest() {
  return process.env.NODE_ENV === 'test';
}

function _emailFrom() {
  return process.env.EMAIL_FROM || 'noreply@ipro-portal.local';
}

/**
 * Envía email con link de verificación post-signup.
 *
 * @param {object} opts
 * @param {string} opts.to        Email destino (post normalización a minúsculas).
 * @param {string} opts.name      Nombre del user — usado en el saludo del email.
 * @param {string} opts.verifyUrl URL completa que el user debe abrir para verificar.
 * @returns {Promise<{ok: boolean, deliveryId: string}>}
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

  // PR 2.1 stub — log con pino para visibilidad en Railway logs.
  // PR 2.2 reemplaza esto con `await resend.emails.send(...)`.
  logger.info(payload, '[email stub] verification email — implementar Resend en PR 2.2');
  return { ok: true, deliveryId: 'stub-' + Date.now() };
}

/**
 * Envía email de bienvenida post-verificación.
 *
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.name
 * @returns {Promise<{ok: boolean, deliveryId: string}>}
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

  logger.info(payload, '[email stub] welcome email — implementar Resend en PR 2.2');
  return { ok: true, deliveryId: 'stub-' + Date.now() };
}

/** Para tests: snapshot read-only de los emails enviados en la suite. */
function _getTestQueue() { return _testQueue.slice(); }

/** Para tests: vaciar la queue entre tests (idempotente). */
function _resetTestQueue() { _testQueue.length = 0; }

module.exports = {
  sendVerificationEmail,
  sendWelcomeEmail,
  _getTestQueue,
  _resetTestQueue,
};

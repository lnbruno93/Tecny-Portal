/**
 * Helper común para Red B2B F5: gating + dispatch fire-and-forget de los
 * 5 emails cross-tenant.
 *
 * Resolución del destinatario:
 *   El email va a UN solo user por tenant — el "owner email" del tenant.
 *   Lookup query: el user más reciente del tenant con role bypass
 *   ('owner' o 'admin' en tenant_users.rol) que tenga `email_verified_at`
 *   no nulo. Si no hay verified, intentamos el primer owner/admin disponible
 *   (mejor mandar a un email no verificado que perder el aviso). Si no hay
 *   ningún owner/admin, skip silencioso (no debería pasar — tenants tienen
 *   owner desde signup).
 *
 *   Decisión durable (justificación):
 *     - Un solo destinatario: el operador del tenant es típicamente 1
 *       persona; mandar a N users genera spam interno y costo Resend lineal.
 *     - Owner/admin only: vendedores con cap operativa no necesitan ser
 *       notificados de partnership flow (es decisión del owner).
 *     - Más reciente verified preferred: si la cuenta cambió de dueño, el
 *       último verified es el más probable de recibir y actuar.
 *
 * Gating per-tenant:
 *   Lookup `tenants.red_b2b_email_prefs[type]`. Si false → skip.
 *   Si la columna no existe (defensive: pre-F5 staging snapshots) → manda
 *   igual (default ON).
 *
 * Fire-and-forget pattern:
 *   El caller usa `setImmediate(() => sendIfEnabled(...))` DESPUÉS del COMMIT
 *   de la tx que insertó la notification in-app. Si el email falla, la
 *   notif in-app ya quedó persistida y el operador lo ve igual.
 *
 *   No bloquea la response del endpoint — el HTTP termina ya con success.
 *   Promesa unhandled rejection: capturada con .catch() en el wrapper
 *   `dispatch` — siempre resuelve, nunca rechaza.
 */

const db = require('../config/database');
const logger = require('./logger');
const email = require('./email');

// Map de type → función de email. Cada función espera args ya armados.
const SENDERS = {
  invitation_received:  email.sendRedB2BInvitationReceivedEmail,
  invitation_accepted:  email.sendRedB2BInvitationAcceptedEmail,
  operation_received:   email.sendRedB2BOperationReceivedEmail,
  operation_cancelled:  email.sendRedB2BOperationCancelledEmail,
  payment_received:     email.sendRedB2BPaymentReceivedEmail,
};

/**
 * Resuelve el email del owner del tenant + nombre + prefs.
 *
 * @param {number} tenantId
 * @returns {Promise<{ email: string|null, name: string|null, prefs: object }>}
 */
async function resolveOwnerEmail(tenantId) {
  return db.adminQuery(async (client) => {
    // tenants table — sin RLS row-level (es tabla raíz). Lookup prefs.
    const tQ = await client.query(
      `SELECT id, red_b2b_email_prefs FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const t = tQ.rows[0];
    if (!t) return { email: null, name: null, prefs: {} };
    const prefs = t.red_b2b_email_prefs || {
      invitation_received:  true,
      invitation_accepted:  true,
      operation_received:   true,
      operation_cancelled:  true,
      payment_received:     true,
    };

    // tenant_users tiene FORCE RLS — necesitamos SET LOCAL.
    await client.query(`SET LOCAL app.current_tenant = ${Number(tenantId)}`);

    // Lookup user owner/admin del tenant. Orden:
    //   1. Verificado + rol=owner (más reciente created_at — tie break)
    //   2. Verificado + rol=admin
    //   3. Cualquier owner (no verificado)
    //   4. Cualquier admin (no verificado)
    // Sin email NOT NULL en users (legacy users podrían tener NULL — la
    // migration #295 dropea NULL pero defensive: ignoramos rows sin email).
    //
    // PR-C P0-4 (issue #462): filtrar u.deleted_at IS NULL — un owner
    // soft-deleted podría seguir teniendo tenant_users.rol='owner' (esa
    // tabla NO tiene deleted_at propio; el cascade real ocurre via FK ON
    // DELETE CASCADE cuando se hace HARD delete de users, no en soft).
    // Sin el filtro, mandábamos emails a ex-dueños tras un cambio de mando.
    const uQ = await client.query(
      `SELECT u.id, u.nombre, u.email, u.email_verified_at, tu.rol
         FROM users u
         JOIN tenant_users tu ON tu.user_id = u.id
        WHERE tu.tenant_id = $1
          AND tu.rol IN ('owner', 'admin')
          AND u.email IS NOT NULL
          AND u.deleted_at IS NULL
        ORDER BY
          CASE tu.rol WHEN 'owner' THEN 0 ELSE 1 END,
          CASE WHEN u.email_verified_at IS NOT NULL THEN 0 ELSE 1 END,
          u.created_at DESC NULLS LAST
        LIMIT 1`,
      [tenantId]
    );
    const u = uQ.rows[0];
    if (!u) return { email: null, name: null, prefs };
    return { email: u.email, name: u.nombre || null, prefs };
  });
}

/**
 * Dispatch fire-and-forget de un email Red B2B con gating.
 *
 * No throws — captura todo error y lo loguea. Ideal para llamar desde
 * setImmediate post-commit:
 *
 *   setImmediate(() => redB2bEmail.dispatch({
 *     tenantId: buyerTenantId,
 *     type:     'operation_received',
 *     args:     { partnerNombre, totalUsd, ..., operationId },
 *   }));
 *
 * @param {object} opts
 * @param {number} opts.tenantId — destinatario tenant
 * @param {keyof SENDERS} opts.type — uno de los 5 events
 * @param {object} opts.args — kwargs específicos del template (sin to/name)
 */
async function dispatch({ tenantId, type, args }) {
  try {
    const sender = SENDERS[type];
    if (!sender) {
      logger.warn({ tenantId, type }, '[red-b2b/email] dispatch type desconocido — skip');
      return { ok: false, skipped: true, reason: 'unknown_type' };
    }
    const { email: to, name, prefs } = await resolveOwnerEmail(tenantId);
    if (!to) {
      logger.info({ tenantId, type }, '[red-b2b/email] sin owner/admin con email — skip');
      return { ok: false, skipped: true, reason: 'no_recipient' };
    }
    if (prefs && prefs[type] === false) {
      logger.info({ tenantId, type }, '[red-b2b/email] gating off — skip');
      return { ok: false, skipped: true, reason: 'prefs_off' };
    }
    return await sender({ to, name, ...args });
  } catch (err) {
    logger.error({ err, tenantId, type }, '[red-b2b/email] dispatch error (silenciado)');
    return { ok: false, skipped: false, error: err.message };
  }
}

module.exports = {
  dispatch,
  resolveOwnerEmail,
  // exportado solo para tests
  _SENDERS: SENDERS,
};

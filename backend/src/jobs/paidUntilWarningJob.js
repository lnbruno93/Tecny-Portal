// paidUntilWarningJob — manda email "tu cuenta vence en N días" a tenants
// próximos a vencer (TANDA 4.D billing pre-live 2026-06-25).
//
// Trigger: corre 1x/24h, idealmente cerca de las 9:00 AM local (ver
// startPaidUntilWarningJob). Cada pasada:
//
//   1. SELECT tenants WHERE paid_until ∈ [today, today+3]
//      AND (paid_until_warning_sent_at IS NULL OR < paid_until - 7d)
//      AND suspended_at IS NULL
//      AND deleted_at IS NULL
//
//   2. Para cada tenant: buscamos owner email vía tenant_users + users
//      (rol='owner' del tenant). Si no hay owner (raro), skip + warn log.
//
//   3. Enviamos email best-effort vía sendPaidUntilWarningEmail. Si Resend
//      falla, log + Sentry + continue — no rompemos el job para los siguientes
//      tenants. El UPDATE de paid_until_warning_sent_at SOLO ocurre si el
//      envío fue ok (sino retry next run).
//
// Multi-instance:
//   - Advisory lock `paid_until_warning` impide doble envío cross-replica.
//   - Idempotencia por columna paid_until_warning_sent_at — si dos réplicas
//     se saltean el lock (extremadamente raro), el SECOND UPDATE no manda
//     el email (el SELECT inicial ya filtra por warning_sent_at).
//
// No fatal: errores se logean + Sentry. El job vuelve a intentar al día
// siguiente.

const logger = require('../lib/logger');
const db = require('../config/database');
const withAdvisoryLock = require('../lib/withAdvisoryLock');
const { sendPaidUntilWarningEmail } = require('../lib/email');

let Sentry = null;
try { Sentry = require('@sentry/node'); } catch { /* no Sentry */ }

/**
 * Formatea YYYY-MM-DD a DD/MM/YYYY (es-AR).
 */
function fmtDateAR(isoDate) {
  if (!isoDate) return '';
  const s = typeof isoDate === 'string' ? isoDate : isoDate.toISOString();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Días entre paid_until (date) y hoy (UTC). 0=hoy, 1=mañana, etc.
 */
function daysUntil(paidUntilDate) {
  if (!paidUntilDate) return null;
  const target = new Date(paidUntilDate);
  if (isNaN(target.getTime())) return null;
  target.setUTCHours(0, 0, 0, 0);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.floor((target - today) / 86400000);
}

/**
 * Ejecuta UNA pasada del job. Devuelve count de emails enviados.
 * No tira excepción (todos los errores se logean + Sentry).
 */
async function runPaidUntilWarning() {
  const startedAt = Date.now();
  let sentCount = 0;
  let candidateCount = 0;

  try {
    // 1. Candidatos: tenants con paid_until en ventana [hoy, hoy+3] que NO
    //    recibieron warning para este período (sent_at NULL o muy viejo).
    //    Excluimos suspended (esos tienen su propio flow) y deleted.
    const { rows: candidates } = await db.adminQuery(async (client) => {
      return client.query(`
        SELECT t.id, t.nombre, t.paid_until, t.paid_until_warning_sent_at,
               u.id AS owner_user_id, u.email AS owner_email, u.nombre AS owner_nombre
          FROM tenants t
          LEFT JOIN tenant_users tu ON tu.tenant_id = t.id AND tu.rol = 'owner'
          LEFT JOIN users u ON u.id = tu.user_id AND u.deleted_at IS NULL
         WHERE t.deleted_at IS NULL
           AND t.suspended_at IS NULL
           AND t.paid_until IS NOT NULL
           AND t.paid_until BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
           AND (
             t.paid_until_warning_sent_at IS NULL
             OR t.paid_until_warning_sent_at < t.paid_until - INTERVAL '7 days'
           )
         ORDER BY t.paid_until ASC
      `);
    });

    candidateCount = candidates.length;

    if (candidateCount === 0) {
      logger.debug({ source: 'paid_until_warning' }, 'paid_until_warning: 0 candidatos');
      return 0;
    }

    // 2. Para cada candidato: enviar mail (best-effort) + UPDATE solo si OK.
    for (const row of candidates) {
      if (!row.owner_email) {
        logger.warn({
          source: 'paid_until_warning',
          tenant_id: row.id,
          tenant_nombre: row.nombre,
        }, 'paid_until_warning: tenant sin owner email — skip');
        continue;
      }

      const daysLeft = daysUntil(row.paid_until);
      if (daysLeft == null || daysLeft < 0 || daysLeft > 3) {
        // El SELECT debería garantizar [0,3] pero defensive contra TZ edge.
        logger.warn({
          source: 'paid_until_warning',
          tenant_id: row.id,
          paid_until: row.paid_until,
          daysLeft,
        }, 'paid_until_warning: daysLeft fuera de ventana esperada — skip');
        continue;
      }

      try {
        const result = await sendPaidUntilWarningEmail({
          to:             row.owner_email,
          name:           row.owner_nombre,
          daysLeft,
          paidUntilDate:  fmtDateAR(row.paid_until),
          tenantName:     row.nombre,
        });

        if (result.ok) {
          // 3. UPDATE atómico — solo si el send fue exitoso. Sino retry tomorrow.
          await db.adminQuery(async (client) => {
            await client.query(
              `UPDATE tenants SET paid_until_warning_sent_at = NOW() WHERE id = $1`,
              [row.id]
            );
          });
          sentCount++;
          logger.info({
            source: 'paid_until_warning',
            tenant_id: row.id,
            tenant_nombre: row.nombre,
            owner_email: row.owner_email,
            daysLeft,
            deliveryId: result.deliveryId,
          }, `paid_until_warning enviado: ${row.nombre} (${daysLeft}d)`);
        } else {
          // sendPaidUntilWarningEmail loggea el error internamente; acá solo
          // tracking — NO marcamos sent_at, el próximo run reintenta.
          logger.warn({
            source: 'paid_until_warning',
            tenant_id: row.id,
            error: result.error,
          }, 'paid_until_warning: send falló — reintenta next run');
        }
      } catch (err) {
        // Error individual: logueamos + seguimos con el siguiente tenant.
        // No abortamos el job entero por uno que falle.
        logger.error({
          err,
          tenant_id: row.id,
          source: 'paid_until_warning',
        }, 'paid_until_warning: excepción al enviar — sigue con próximo');
        if (Sentry) {
          try {
            Sentry.captureException(err, {
              tags: { source: 'paid_until_warning' },
              extra: { tenant_id: row.id, daysLeft },
            });
          } catch { /* no Sentry */ }
        }
      }
    }

    const ms = Date.now() - startedAt;
    logger.info({
      source:     'paid_until_warning',
      sent:       sentCount,
      candidates: candidateCount,
      durationMs: ms,
    }, `paid_until_warning: ${sentCount}/${candidateCount} mails enviados (${ms}ms)`);

    return sentCount;
  } catch (err) {
    logger.error({ err, source: 'paid_until_warning' }, 'paid_until_warning job falló');
    if (Sentry) {
      try {
        Sentry.captureException(err, {
          tags: { source: 'paid_until_warning' },
          level: 'error',
        });
      } catch { /* no Sentry */ }
    }
    return sentCount;
  }
}

/**
 * Programa el job. Default: cada 24h. En NODE_ENV=test no arranca.
 *
 * @param {object} opts
 * @param {number} [opts.intervalHours=24]
 * @param {boolean} [opts.runOnStartup=false]
 */
function startPaidUntilWarningJob({ intervalHours = 24, runOnStartup = false } = {}) {
  if (process.env.NODE_ENV === 'test') return null;

  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

  const runWithLock = () => withAdvisoryLock('paid_until_warning', runPaidUntilWarning)
    .catch(err => logger.error({ err }, 'paid_until_warning con lock falló'));

  if (runOnStartup) runWithLock();

  const handle = setInterval(runWithLock, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  logger.info({ intervalHours }, 'paid_until_warning job programado (con advisory lock)');
  return handle;
}

module.exports = { runPaidUntilWarning, startPaidUntilWarningJob };

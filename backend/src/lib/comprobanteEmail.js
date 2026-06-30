/**
 * Orchestrador para enviar el comprobante PDF de una venta retail por email
 * al cliente final (#475).
 *
 * Responsabilidades (single function `enviarComprobanteVenta`):
 *   1. Lookup de la venta + tenant + items + pagos. Lectura tenant-scoped via
 *      `db.withTenant` (RLS aplica — el caller pasa tenantId del request).
 *   2. Validar que es una venta retail VIVA (no soft-deleted, no cancelada).
 *      Las B2B (movimientos_cc tipo='compra') NO entran a este flow — tienen
 *      su propio sync de CC + cross-tenant.
 *   3. Generar el PDF con `comprobantePdf.generarComprobantePdf`.
 *   4. Enviar el email con `email.sendComprobanteVentaEmail`.
 *   5. Persistir una row en `venta_emails_enviados` con el resultado
 *      (status='sent' o 'failed' + msg_id + error_msg).
 *   6. Side-effect: UPSERT contactos.email si el cliente_id está set y el
 *      contacto no tenía email previo. Best-effort — un fallo acá NO falla
 *      el envío entero (loguea warning).
 *
 * Fire-and-forget contract:
 *   La función NO throws — todo error se captura y se loguea + se persiste
 *   como fila status='failed'. Idea: el caller la puede invocar inline
 *   (devolver el resultado al user en POST /enviar-comprobante) o via
 *   setImmediate (post-commit de POST /api/ventas) sin necesidad de un
 *   try/catch defensivo.
 *
 *   Excepción: si la venta no existe (validación), devolvemos
 *   `{ ok: false, error, skipped: true }` SIN persistir row. La row no
 *   pertenecería a ninguna venta (sería un orphan FK).
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   sentId?: number,      // id de la row en venta_emails_enviados
 *   msgId?: string,       // resend message id (para tracking en su dashboard)
 *   error?: string,       // detalle del error si ok=false
 *   skipped?: boolean,    // true si no se intentó (venta inválida)
 * }>}
 */

const db = require('../config/database');
const logger = require('./logger');
const { generarComprobantePdf } = require('./comprobantePdf');
const email = require('./email');

/**
 * @param {object} args
 * @param {number} args.tenantId       — del request (caller authenticated)
 * @param {number} args.ventaId        — venta retail a enviar
 * @param {string} args.emailTo        — destinatario (validado por caller via Zod)
 * @param {number} args.sentByUserId   — quién dispara el envío (audit)
 * @param {number} [args.reenvioDeId]  — si es reenvío, id del envío original
 */
async function enviarComprobanteVenta({
  tenantId, ventaId, emailTo, sentByUserId, reenvioDeId = null,
}) {
  if (!tenantId || !ventaId || !emailTo) {
    return { ok: false, skipped: true, error: 'tenantId, ventaId y emailTo son requeridos' };
  }

  let venta, tenant;
  try {
    // ── Step 1+2: lookup venta + tenant + validaciones de existencia ─────
    const lookup = await db.withTenant(tenantId, async (client) => {
      // Venta + items + pagos. RLS asegura que solo vemos ventas del tenant.
      const vRes = await client.query(
        `SELECT v.id, v.order_id, v.fecha, v.total_usd, v.tc_venta, v.estado,
                v.cliente_id, v.cliente_nombre, v.notas
           FROM ventas v
          WHERE v.id = $1 AND v.deleted_at IS NULL`,
        [ventaId]
      );
      if (!vRes.rows[0]) return { notFound: true };
      const v = vRes.rows[0];

      // Items.
      const iRes = await client.query(
        `SELECT id, descripcion, imei, cantidad, precio_vendido, costo, moneda
           FROM venta_items
          WHERE venta_id = $1
          ORDER BY id`,
        [ventaId]
      );
      v.items = iRes.rows;

      // Pagos.
      const pRes = await client.query(
        `SELECT id, metodo_nombre, monto, moneda
           FROM venta_pagos
          WHERE venta_id = $1
          ORDER BY id`,
        [ventaId]
      );
      v.pagos = pRes.rows;

      // Tenant (nombre + footer custom + pais). `tenants` no tiene RLS por
      // tenant_id (es la tabla raíz) — se filtra por id directo.
      const tRes = await client.query(
        `SELECT id, nombre, comprobante_email_footer, pais
           FROM tenants
          WHERE id = $1 AND deleted_at IS NULL`,
        [tenantId]
      );
      if (!tRes.rows[0]) return { tenantMissing: true };

      return { venta: v, tenant: tRes.rows[0] };
    });

    if (lookup.notFound) {
      return { ok: false, skipped: true, error: 'venta no encontrada' };
    }
    if (lookup.tenantMissing) {
      return { ok: false, skipped: true, error: 'tenant no encontrado' };
    }

    venta  = lookup.venta;
    tenant = lookup.tenant;

    // Venta retail viva: no cancelada. (Las soft-deleted ya filtran arriba.)
    if (venta.estado === 'cancelado') {
      return { ok: false, skipped: true, error: 'la venta está cancelada' };
    }
  } catch (err) {
    logger.error({ err, tenantId, ventaId }, '[comprobante-email] lookup falló');
    return { ok: false, skipped: true, error: err.message };
  }

  // ── Step 3: generar PDF ────────────────────────────────────────────────
  let pdfBuffer;
  try {
    pdfBuffer = await generarComprobantePdf({ venta, tenant });
  } catch (err) {
    logger.error({ err, tenantId, ventaId }, '[comprobante-email] generación PDF falló');
    // No persistimos fila de fail acá — el fallo es pre-envío (no llegamos a
    // intentar Resend). Devolvemos error al caller.
    return { ok: false, error: 'falló la generación del PDF: ' + err.message };
  }

  // ── Step 4: enviar email con PDF attached ──────────────────────────────
  const pdfFilename = `comprobante-${venta.order_id || venta.id}.pdf`;
  // Total formateado para el HTML body (el PDF lo formatea por su cuenta).
  const totalFmt = `USD ${Number(venta.total_usd || 0).toFixed(2)}`;
  const fechaFmt = venta.fecha ? new Date(venta.fecha).toISOString().slice(0, 10).split('-').reverse().join('/') : '';

  const sendResult = await email.sendComprobanteVentaEmail({
    to:           emailTo,
    tenantNombre: tenant.nombre,
    ventaOrderId: venta.order_id || `#${venta.id}`,
    ventaFecha:   fechaFmt,
    ventaTotal:   totalFmt,
    pdfBuffer,
    pdfFilename,
    footerCustom: tenant.comprobante_email_footer || null,
  });

  // ── Step 5: persistir row en venta_emails_enviados ──────────────────
  let sentId = null;
  try {
    const persistRes = await db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO venta_emails_enviados
           (tenant_id, venta_id, email_to, status, resend_msg_id, error_msg, sent_by_user_id, reenvio_de_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          tenantId, ventaId, emailTo,
          sendResult.ok ? 'sent' : 'failed',
          sendResult.deliveryId || null,
          sendResult.ok ? null : (sendResult.error || 'unknown error'),
          sentByUserId || null,
          reenvioDeId || null,
        ]
      );
      return rows[0];
    });
    sentId = persistRes?.id || null;
  } catch (err) {
    // Persist falló — el email puede haber salido OK pero no tenemos audit
    // trail. Loguear pero no fallar el flow (el user ve igual el send result).
    logger.error({ err, tenantId, ventaId }, '[comprobante-email] persist row venta_emails_enviados falló');
  }

  // ── Step 6: UPSERT contactos.email (best-effort) ───────────────────────
  // Si el envío fue exitoso, la venta tiene cliente_id, y ese contacto no
  // tenía email previo: setearlo. Patron: ON CONFLICT no aplica acá porque
  // estamos UPDATE por PK; usamos WHERE email IS NULL para no pisar valores.
  if (sendResult.ok && venta.cliente_id) {
    try {
      await db.withTenant(tenantId, async (client) => {
        await client.query(
          `UPDATE contactos SET email = $1
             WHERE id = $2
               AND deleted_at IS NULL
               AND (email IS NULL OR email = '')`,
          [emailTo, venta.cliente_id]
        );
      });
    } catch (err) {
      logger.warn({ err, tenantId, ventaId, cliente_id: venta.cliente_id },
        '[comprobante-email] UPSERT contactos.email falló (no crítico, email igual fue enviado)');
    }
  }

  if (sendResult.ok) {
    return { ok: true, sentId, msgId: sendResult.deliveryId };
  }
  return { ok: false, sentId, error: sendResult.error || 'envío falló' };
}

/**
 * Auditoría 2026-06-30 E-03 — perf: helpers para el flujo pending → sent/failed.
 *
 * Patrón:
 *   1. Endpoint (route handler) abre tx, llama `insertarPendingRow(client, ...)`
 *      que INSERTea con status='pending', commitea, responde 202 al cliente
 *      con `{ status:'pending', id }`.
 *   2. Después del COMMIT, el endpoint llama `setImmediate(() => sendAndMark
 *      Pending(...))`. La función hace PDF + Resend + UPDATE del row a 'sent'
 *      o 'failed' según el resultado.
 *   3. El frontend (que ya hace polling de GET /emails-enviados) ve el status
 *      cambiar de pending → sent/failed.
 *
 * Diferencia vs `enviarComprobanteVenta`:
 *   - `enviarComprobanteVenta` INSERTea la row recién al final con el status
 *     final. Era el patrón pre-E-03 — la row solo aparece después del envío.
 *   - El nuevo patrón inserta la row PRIMERO en pending (visible al cliente
 *     en el listado de inmediato) y UPDATEa al terminar. El cliente ve
 *     "enviando…" sin tener que esperar la respuesta HTTP.
 */

/**
 * Inserta una row 'pending' en venta_emails_enviados. Para llamar DENTRO de
 * una tx existente (el caller ya tiene el client y va a hacer COMMIT).
 *
 * @param {pg.PoolClient} client — client con tx abierta + tenant seteado.
 * @returns {Promise<{ id: number }>}  id de la row insertada.
 */
async function insertarPendingRow(client, {
  tenantId, ventaId, emailTo, sentByUserId, reenvioDeId = null,
}) {
  const { rows } = await client.query(
    `INSERT INTO venta_emails_enviados
       (tenant_id, venta_id, email_to, status, sent_by_user_id, reenvio_de_id)
     VALUES ($1, $2, $3, 'pending', $4, $5)
     RETURNING id`,
    [tenantId, ventaId, emailTo, sentByUserId || null, reenvioDeId || null]
  );
  return { id: rows[0].id };
}

/**
 * Envía el comprobante y UPDATEa la row pre-existente (insertada por
 * `insertarPendingRow`) a 'sent' o 'failed' según el resultado. Idempotente:
 * si la row ya está en estado terminal, la UPDATE WHERE status='pending' es
 * no-op.
 *
 * NO throws — todo error queda persistido como UPDATE a status='failed'.
 * Pensado para correr dentro de `setImmediate` post-COMMIT — el caller no
 * necesita try/catch.
 *
 * @param {object} args
 * @param {number} args.tenantId
 * @param {number} args.ventaId
 * @param {string} args.emailTo
 * @param {number} args.sentId    — id de la row 'pending' devuelto por
 *                                   insertarPendingRow.
 */
async function sendAndMarkPending({ tenantId, ventaId, emailTo, sentId }) {
  // ── Step 1+2: lookup venta + tenant ────────────────────────────────────
  let venta, tenant;
  try {
    const lookup = await db.withTenant(tenantId, async (client) => {
      const vRes = await client.query(
        `SELECT v.id, v.order_id, v.fecha, v.total_usd, v.tc_venta, v.estado,
                v.cliente_id, v.cliente_nombre, v.notas
           FROM ventas v
          WHERE v.id = $1 AND v.deleted_at IS NULL`,
        [ventaId]
      );
      if (!vRes.rows[0]) return { notFound: true };
      const v = vRes.rows[0];

      const iRes = await client.query(
        `SELECT id, descripcion, imei, cantidad, precio_vendido, costo, moneda
           FROM venta_items
          WHERE venta_id = $1
          ORDER BY id`,
        [ventaId]
      );
      v.items = iRes.rows;

      const pRes = await client.query(
        `SELECT id, metodo_nombre, monto, moneda
           FROM venta_pagos
          WHERE venta_id = $1
          ORDER BY id`,
        [ventaId]
      );
      v.pagos = pRes.rows;

      const tRes = await client.query(
        `SELECT id, nombre, comprobante_email_footer, pais
           FROM tenants
          WHERE id = $1 AND deleted_at IS NULL`,
        [tenantId]
      );
      if (!tRes.rows[0]) return { tenantMissing: true };
      return { venta: v, tenant: tRes.rows[0] };
    });

    if (lookup.notFound || lookup.tenantMissing) {
      await marcarFailed(tenantId, sentId, lookup.notFound
        ? 'venta no encontrada al procesar pending'
        : 'tenant no encontrado al procesar pending');
      return { ok: false };
    }
    venta = lookup.venta;
    tenant = lookup.tenant;
    if (venta.estado === 'cancelado') {
      await marcarFailed(tenantId, sentId, 'la venta fue cancelada antes del envío');
      return { ok: false };
    }
  } catch (err) {
    logger.error({ err, tenantId, ventaId, sentId }, '[comprobante-email] lookup async falló');
    await marcarFailed(tenantId, sentId, 'lookup falló: ' + err.message);
    return { ok: false };
  }

  // ── Step 3: PDF ────────────────────────────────────────────────────────
  let pdfBuffer;
  try {
    pdfBuffer = await generarComprobantePdf({ venta, tenant });
  } catch (err) {
    logger.error({ err, tenantId, ventaId, sentId }, '[comprobante-email] PDF async falló');
    await marcarFailed(tenantId, sentId, 'falló la generación del PDF: ' + err.message);
    return { ok: false };
  }

  // ── Step 4: Resend ─────────────────────────────────────────────────────
  const pdfFilename = `comprobante-${venta.order_id || venta.id}.pdf`;
  const totalFmt = `USD ${Number(venta.total_usd || 0).toFixed(2)}`;
  const fechaFmt = venta.fecha
    ? new Date(venta.fecha).toISOString().slice(0, 10).split('-').reverse().join('/')
    : '';

  const sendResult = await email.sendComprobanteVentaEmail({
    to:           emailTo,
    tenantNombre: tenant.nombre,
    ventaOrderId: venta.order_id || `#${venta.id}`,
    ventaFecha:   fechaFmt,
    ventaTotal:   totalFmt,
    pdfBuffer,
    pdfFilename,
    footerCustom: tenant.comprobante_email_footer || null,
  });

  // ── Step 5: UPDATE de la row pending → sent/failed ─────────────────────
  try {
    await db.withTenant(tenantId, async (client) => {
      if (sendResult.ok) {
        await client.query(
          `UPDATE venta_emails_enviados
              SET status = 'sent', resend_msg_id = $1, error_msg = NULL
            WHERE id = $2 AND status = 'pending'`,
          [sendResult.deliveryId || null, sentId]
        );
      } else {
        await client.query(
          `UPDATE venta_emails_enviados
              SET status = 'failed', error_msg = $1
            WHERE id = $2 AND status = 'pending'`,
          [sendResult.error || 'unknown error', sentId]
        );
      }
    });
  } catch (err) {
    logger.error({ err, tenantId, ventaId, sentId },
      '[comprobante-email] UPDATE status pending → terminal falló');
    // No re-throw — el email puede haber salido, pero perdemos el audit.
  }

  // ── Step 6: UPSERT contactos.email (best-effort, solo si OK) ───────────
  if (sendResult.ok && venta.cliente_id) {
    try {
      await db.withTenant(tenantId, async (client) => {
        await client.query(
          `UPDATE contactos SET email = $1
             WHERE id = $2 AND deleted_at IS NULL AND (email IS NULL OR email = '')`,
          [emailTo, venta.cliente_id]
        );
      });
    } catch (err) {
      logger.warn({ err, tenantId, ventaId }, '[comprobante-email] UPSERT contactos.email async falló');
    }
  }

  return { ok: sendResult.ok };
}

/** Helper interno: marca la row pending como failed con error_msg. */
async function marcarFailed(tenantId, sentId, errorMsg) {
  try {
    await db.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE venta_emails_enviados
            SET status = 'failed', error_msg = $1
          WHERE id = $2 AND status = 'pending'`,
        [errorMsg, sentId]
      );
    });
  } catch (err) {
    logger.error({ err, tenantId, sentId, errorMsg },
      '[comprobante-email] marcarFailed UPDATE falló');
  }
}

module.exports = {
  enviarComprobanteVenta,
  insertarPendingRow,
  sendAndMarkPending,
};

/**
 * Red B2B — pagos cross-tenant + devoluciones (F4 #457).
 *
 * Endpoints bajo /api/red-b2b/operations/:id (montado sobre el router de
 * operations, pero declarado en archivo separado por claridad). Se monta
 * en app.js como router hermano con paramedio el :id.
 *
 * Endpoints:
 *   POST  /:id/pagos       → registra un pago (multi-divisa, propagado al otro lado)
 *   GET   /:id/pagos       → lista los pagos de la operación + saldo
 *   POST  /:id/devolucion  → devolución cross-tenant (solo buyer — decisión #11)
 *
 * Multi-tenant + RLS:
 *   POST /pagos y POST /devolucion usan adminQuery (BYPASSRLS / tecny_admin)
 *   porque escriben en ambos tenants en la misma tx. SET LOCAL switching
 *   garantiza que los FORCE RLS WITH CHECK validen el tenant_id correcto.
 *   GET /pagos usa adminQuery también para leer la op + pagos (la op tiene
 *   RLS dual, pagos no tiene RLS propio — filtramos inline por op_id).
 *
 * Audit (con SAVEPOINT obligatorio post-F3):
 *   POST /pagos:       action='cross_tenant_pago_registered' del lado que registra.
 *   POST /devolucion:  action='cross_tenant_devolucion' del lado buyer (originador).
 *
 * Decisión #16 (multi-divisa): si moneda_pago !== USD, el helper
 * registerSellerCobro asienta la diferencia cambiaria como movimiento en
 * el módulo Cambios de Divisa del SELLER. El buyer no ve la diferencia
 * (su pago ya está al TC del día, sin re-cálculo).
 */

const router = require('express').Router({ mergeParams: true });
const db = require('../../config/database');
const logger = require('../../lib/logger');
const validate = require('../../lib/validate');
const parseId = require('../../lib/parseId');
const {
  registrarPagoSchema,
  devolucionSchema,
} = require('../../schemas/redB2b');
const {
  calcularDiferenciaCambiaria,
  resolveCajaParaTenant,
  registerSellerCobro,
  registerBuyerPago,
  calcularSaldoOperacion,
  ensureSellerClienteCc,
  ensureBuyerProveedor,
} = require('../../lib/crossTenantPagos');
const { round2 } = require('../../lib/money');
const { invalidateMetricas } = require('../../lib/inventarioCache');
const { invalidateConciliationCache } = require('./conciliation');

// ──────────────────────────────────────────────────────────────────────────
// Helpers: notify + audit (replicados del pattern operations.js — SAVEPOINT
// obligatorio en audit por bug histórico F3).
// ──────────────────────────────────────────────────────────────────────────
async function notify(client, tenantId, type, payload, opts = {}) {
  await client.query(`SET LOCAL app.current_tenant = ${Number(tenantId)}`);
  await client.query(
    `INSERT INTO cross_tenant_notifications
       (tenant_id, partnership_id, cross_tenant_operation_id, type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      tenantId,
      opts.partnershipId || null,
      opts.operationId || null,
      type,
      JSON.stringify(payload),
    ]
  );
}

async function audit(client, { tenantId, userId, action, payload }) {
  await client.query('SAVEPOINT sp_audit');
  try {
    await client.query(
      `INSERT INTO tenant_admin_actions
         (tenant_id, super_admin_user_id, action, before_state, after_state, reason)
       VALUES ($1, $2, $3, NULL, $4::jsonb, NULL)`,
      [tenantId, userId, action, JSON.stringify(payload || {})]
    );
    await client.query('RELEASE SAVEPOINT sp_audit');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT sp_audit').catch(() => {});
    if (err.code === '23514') {
      logger.warn({ action, err: err.message }, '[red-b2b/F4] audit action no permitida — migration pendiente?');
      return;
    }
    throw err;
  }
}

function tenantSnapshot(row) {
  if (!row) return null;
  return { id: row.id, nombre: row.nombre, slug: row.slug, plan: row.plan };
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/operations/:id/pagos
//
// EL CORE de F4. Flow:
//   A. Lookup op + verificar status='active' (no cancelled/frozen)
//   B. Verificar caller participa (seller o buyer) — si side body !== inferido → 403
//   C. Validar saldo: monto_usd <= saldo restante (sobre-pago rechazado)
//   D. Calcular diferencia cambiaria (helper puro)
//   E. SET LOCAL al lado QUE REGISTRA → INSERT mov tipo='pago' + (si seller
//      y moneda_pago=ARS) INSERT cambio_movimientos con diff cambiaria
//   F. SET LOCAL al OTRO lado → INSERT mov tipo='pago' propagado, en caja
//      default cross-tenant del otro lado
//   G. INSERT cross_tenant_pagos con snapshots completos
//   H. Notif al otro lado: type='payment_received' o 'payment_registered'
//   I. Audit del lado que registra (con SAVEPOINT)
//   J. COMMIT + invalidar caches
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/pagos', validate(registrarPagoSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const opId = parseId(req.params.id);
  if (!opId) return res.status(400).json({ error: 'id inválido' });

  const body = req.body;
  const fecha = body.fecha || new Date().toISOString().slice(0, 10);

  try {
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // A. Lookup operación (con BYPASSRLS — necesitamos ver ambos lados).
        const opQ = await client.query(
          `SELECT * FROM cross_tenant_operations
             WHERE id = $1
               AND (seller_tenant_id = $2 OR buyer_tenant_id = $2)
             FOR UPDATE`,
          [opId, myTenantId]
        );
        const op = opQ.rows[0];
        if (!op) {
          await client.query('ROLLBACK');
          return { error: 'not_found', status: 404 };
        }
        if (op.status === 'cancelled') {
          await client.query('ROLLBACK');
          return { error: 'op_cancelled', status: 409 };
        }
        if (op.status === 'frozen') {
          await client.query('ROLLBACK');
          return { error: 'op_frozen', status: 409 };
        }

        // B. Verificar partnership activa (defense in depth — si la
        // partnership se revocó después de crear la op, F1 dejó las ops
        // existentes vivas para que el pago se pueda completar — sec 6.6).
        // Acá NO bloqueamos por partnership_not_active porque permitimos
        // pagar ops pre-revoke (decisión doc 6.6.D). Solo bloqueamos op
        // cancelled/frozen arriba.

        // C. Determinar quién es el seller y el buyer.
        const callerIsSeller = op.seller_tenant_id === myTenantId;
        const sellerTenantId = op.seller_tenant_id;
        const buyerTenantId  = op.buyer_tenant_id;

        // El side del body debe coincidir con lo inferido del caller.
        const callerSide = callerIsSeller ? 'seller' : 'buyer';
        if (body.side !== callerSide) {
          await client.query('ROLLBACK');
          return { error: 'side_mismatch', status: 403,
            details: { caller_side: callerSide, body_side: body.side } };
        }

        // D. Lookup ambos tenants (para nombres + caja default).
        const tenantsQ = await client.query(
          `SELECT id, nombre, slug, plan, red_b2b_caja_default_id
             FROM tenants WHERE id = ANY($1::int[])`,
          [[sellerTenantId, buyerTenantId]]
        );
        const tenantsById = new Map(tenantsQ.rows.map((r) => [r.id, r]));
        const sellerTenant = tenantsById.get(sellerTenantId);
        const buyerTenant  = tenantsById.get(buyerTenantId);

        // E. Calcular saldo restante de la op.
        const saldo = await calcularSaldoOperacion(client, opId);
        const monto_usd = round2(Number(body.monto_usd));
        // Tolerancia 1 centavo para floating point.
        if (monto_usd > saldo.restante_usd + 0.01) {
          await client.query('ROLLBACK');
          return {
            error: 'overpayment', status: 400,
            details: {
              restante_usd: saldo.restante_usd,
              pagado_acumulado_usd: saldo.pagado_usd,
              total_usd: saldo.total_usd,
              intento_usd: monto_usd,
            },
          };
        }

        // F. Calcular diferencia cambiaria (snapshot tc_venta = op.tc_used).
        const tc_venta = Number(op.tc_used);
        const tc_pago = Number(body.tc_pago);
        const { diferencia_ars } = calcularDiferenciaCambiaria(
          monto_usd, tc_venta, tc_pago, body.moneda_pago
        );

        // G. Lookup caja del propio tenant (validar que existe + moneda
        // compatible con el moneda_pago).
        const callerCajaQ = await client.query(
          `SELECT id, moneda, nombre FROM metodos_pago
             WHERE id = $1 AND activo = true AND deleted_at IS NULL`,
          [body.caja_id]
        );
        const callerCaja = callerCajaQ.rows[0];
        if (!callerCaja) {
          await client.query('ROLLBACK');
          return { error: 'caja_not_found', status: 404, details: { caja_id: body.caja_id } };
        }
        // Compat moneda: ARS↔ARS, USD↔USD/USDT.
        const cajaCompat = body.moneda_pago === 'ARS'
          ? callerCaja.moneda === 'ARS'
          : (callerCaja.moneda === 'USD' || callerCaja.moneda === 'USDT');
        if (!cajaCompat) {
          await client.query('ROLLBACK');
          return {
            error: 'caja_moneda_incompatible', status: 400,
            details: { caja_moneda: callerCaja.moneda, moneda_pago: body.moneda_pago },
          };
        }

        // ── REGISTRAR LADO QUE LLAMA ─────────────────────────────────────
        let sellerResult, buyerResult;
        if (callerIsSeller) {
          // El caller es el seller — registra cobro propio + diferencia cambiaria.
          await client.query(`SET LOCAL app.current_tenant = ${Number(sellerTenantId)}`);
          sellerResult = await registerSellerCobro(client, sellerTenantId, {
            opId,
            buyerTenant,
            monto_usd,
            moneda_pago: body.moneda_pago,
            monto_pago: body.monto_pago,
            tc_pago,
            tc_venta,
            caja_id: body.caja_id,
            fecha,
            callerUserId: userId,
            diferencia_cambiaria_ars: diferencia_ars,
            notas: body.notas,
          });
        } else {
          // El caller es el buyer — registra pago propio (sin diff cambiaria).
          await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
          buyerResult = await registerBuyerPago(client, buyerTenantId, {
            opId,
            sellerTenant,
            monto_usd,
            moneda_pago: body.moneda_pago,
            monto_pago: body.monto_pago,
            tc_pago,
            caja_id: body.caja_id,
            fecha,
            callerUserId: userId,
            notas: body.notas,
          });
        }

        // ── PROPAGAR AL OTRO LADO ─────────────────────────────────────────
        // El monto_pago del otro lado puede ser distinto si las monedas son
        // distintas — el otro lado siempre recibe en USD (moneda canónica),
        // re-convertido si la caja del otro lado es ARS. Estrategia simple:
        // - Si la caja default del otro lado es ARS, el monto_pago propagado
        //   es monto_usd * tc_pago (el TC usado, que ya conocemos).
        // - Si es USD, monto_pago propagado = monto_usd, sin TC.
        if (callerIsSeller) {
          // Propagar al BUYER: necesitamos su caja default.
          await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
          const buyerCajaId = await resolveCajaParaTenant(
            client, buyerTenantId, body.moneda_pago, buyerTenant.red_b2b_caja_default_id
          );
          if (!buyerCajaId) {
            await client.query('ROLLBACK');
            return {
              error: 'buyer_no_caja_compatible', status: 409,
              details: { buyer_tenant_id: buyerTenantId, moneda_pago: body.moneda_pago },
            };
          }
          buyerResult = await registerBuyerPago(client, buyerTenantId, {
            opId,
            sellerTenant,
            monto_usd,
            moneda_pago: body.moneda_pago,
            monto_pago: body.monto_pago,
            tc_pago,
            caja_id: buyerCajaId,
            fecha,
            callerUserId: userId,
          });
        } else {
          // Propagar al SELLER: necesita caja default + diferencia cambiaria.
          await client.query(`SET LOCAL app.current_tenant = ${Number(sellerTenantId)}`);
          const sellerCajaId = await resolveCajaParaTenant(
            client, sellerTenantId, body.moneda_pago, sellerTenant.red_b2b_caja_default_id
          );
          if (!sellerCajaId) {
            await client.query('ROLLBACK');
            return {
              error: 'seller_no_caja_compatible', status: 409,
              details: { seller_tenant_id: sellerTenantId, moneda_pago: body.moneda_pago },
            };
          }
          sellerResult = await registerSellerCobro(client, sellerTenantId, {
            opId,
            buyerTenant,
            monto_usd,
            moneda_pago: body.moneda_pago,
            monto_pago: body.monto_pago,
            tc_pago,
            tc_venta,
            caja_id: sellerCajaId,
            fecha,
            callerUserId: userId,
            diferencia_cambiaria_ars: diferencia_ars,
          });
        }

        // ── INSERT cross_tenant_pagos maestro ─────────────────────────────
        // No tiene RLS propio. Llenar TODOS los snapshots.
        const cpQ = await client.query(
          `INSERT INTO cross_tenant_pagos
             (cross_tenant_operation_id,
              seller_cobro_id, buyer_pago_id,
              monto_usd, monto_ars, tc_used,
              caja_seller_id, caja_buyer_id,
              registered_by_side, registered_by_user_id, registered_at,
              moneda_pago, tc_venta, tc_pago,
              diferencia_cambiaria_ars, cambio_divisa_id,
              propagated_at)
           VALUES ($1,
                   $2, $3,
                   $4, $5, $6,
                   $7, $8,
                   $9, $10, NOW(),
                   $11, $12, $13,
                   $14, $15,
                   NOW())
           RETURNING id, registered_at`,
          [
            opId,
            sellerResult.movimiento_id,
            buyerResult.movimiento_id,
            monto_usd,
            // monto_ars: el monto del pago en ARS (sea que sea moneda_pago)
            round2(monto_usd * tc_pago),
            // tc_used: F1 legacy column — guardamos tc_pago para retrocompat
            tc_pago,
            callerIsSeller ? body.caja_id : (await resolveCajaParaTenant(client, sellerTenantId, body.moneda_pago, sellerTenant.red_b2b_caja_default_id)),
            callerIsSeller ? (await resolveCajaParaTenant(client, buyerTenantId, body.moneda_pago, buyerTenant.red_b2b_caja_default_id)) : body.caja_id,
            callerSide,
            userId,
            body.moneda_pago,
            tc_venta,
            tc_pago,
            round2(diferencia_ars),
            sellerResult.cambio_divisa_id || null,
          ]
        );
        const crossPago = cpQ.rows[0];

        // ── NOTIF al otro lado ────────────────────────────────────────────
        // Tipo según quien registró:
        // - seller registró → buyer recibe 'payment_received'
        // - buyer registró → seller recibe 'payment_registered'
        const otherTenantId = callerIsSeller ? buyerTenantId : sellerTenantId;
        const fromTenant = callerIsSeller ? sellerTenant : buyerTenant;
        const notifType = callerIsSeller ? 'payment_received' : 'payment_registered';
        await notify(client, otherTenantId, notifType, {
          partner: tenantSnapshot(fromTenant),
          operation_id: opId,
          pago_id: crossPago.id,
          monto_usd,
          moneda_pago: body.moneda_pago,
          monto_pago: round2(body.monto_pago),
          tc_pago,
          from_user_id: userId,
          from_username: req.user.username,
        }, { partnershipId: op.partnership_id, operationId: opId });

        // ── (Opcional) UPDATE op.status='completed' si pago completa saldo ─
        // DECISIÓN F4: NO cambiamos status — quedamos en 'active' con saldo 0.
        // Razones:
        //  1. El CHECK constraint actual de status no incluye 'completed'.
        //  2. Cambiar a status diferente complica el flow de cancel/devolución.
        //  3. La conciliación se calcula via saldo_restante, no por status.
        // Si en el futuro Lucas quiere distinguir "completed" visual, se
        // puede agregar un campo derivado `is_fully_paid` o vista compuesta.

        // ── AUDIT del lado que registra ───────────────────────────────────
        await client.query(`SET LOCAL app.current_tenant = ${Number(myTenantId)}`);
        await audit(client, {
          tenantId: myTenantId,
          userId,
          action: 'cross_tenant_pago_registered',
          payload: {
            operation_id: opId,
            pago_id: crossPago.id,
            monto_usd,
            moneda_pago: body.moneda_pago,
            tc_pago,
            diferencia_cambiaria_ars: round2(diferencia_ars),
            side: callerSide,
          },
        });

        await client.query('COMMIT');
        return {
          ok: true,
          pagoId: crossPago.id,
          opId,
          callerSide,
          sellerTenantId,
          buyerTenantId,
          partnershipId: op.partnership_id,
          monto_usd,
          diferencia_ars,
          cambio_divisa_id: sellerResult?.cambio_divisa_id || null,
        };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });

    if (result.error) {
      return res.status(result.status).json({
        error: errorMessage(result.error),
        reason: result.error,
        ...(result.details ? { details: result.details } : {}),
      });
    }

    // Invalidar caches.
    invalidateConciliationCache(result.partnershipId);

    logger.info({
      operation_id: result.opId,
      pago_id: result.pagoId,
      side: result.callerSide,
      tenant_id: myTenantId,
      user_id: userId,
      monto_usd: result.monto_usd,
      diferencia_ars: result.diferencia_ars,
    }, '[red-b2b/F4] pago cross-tenant registrado');

    return res.status(201).json({
      pago: {
        id: result.pagoId,
        operation_id: result.opId,
        monto_usd: result.monto_usd,
        diferencia_cambiaria_ars: round2(result.diferencia_ars),
        cambio_divisa_id: result.cambio_divisa_id,
        side: result.callerSide,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/operations/:id/pagos
//
// Lista los pagos de una operación + saldo restante.
// ──────────────────────────────────────────────────────────────────────────
router.get('/:id/pagos', async (req, res, next) => {
  const myTenantId = req.tenantId;
  const opId = parseId(req.params.id);
  if (!opId) return res.status(400).json({ error: 'id inválido' });

  try {
    const data = await db.adminQuery(async (client) => {
      // Lookup op para validar que el caller participa (RLS dual + filtro inline).
      const opQ = await client.query(
        `SELECT id, seller_tenant_id, buyer_tenant_id, total_usd, status
           FROM cross_tenant_operations
           WHERE id = $1
             AND (seller_tenant_id = $2 OR buyer_tenant_id = $2)`,
        [opId, myTenantId]
      );
      const op = opQ.rows[0];
      if (!op) return { notFound: true };

      // Lookup pagos + usernames (ordenados ascendente para tracking secuencial).
      const pagosQ = await client.query(
        `SELECT p.id, p.monto_usd, p.monto_ars, p.tc_used,
                p.moneda_pago, p.tc_venta, p.tc_pago,
                p.diferencia_cambiaria_ars, p.cambio_divisa_id,
                p.caja_seller_id, p.caja_buyer_id,
                p.registered_by_side, p.registered_by_user_id,
                p.registered_at, p.propagated_at,
                p.seller_cobro_id, p.buyer_pago_id,
                u.username AS registered_by_username
           FROM cross_tenant_pagos p
           LEFT JOIN users u ON u.id = p.registered_by_user_id
           WHERE p.cross_tenant_operation_id = $1
           ORDER BY p.registered_at ASC, p.id ASC`,
        [opId]
      );

      const saldo = await calcularSaldoOperacion(client, opId);
      return { op, pagos: pagosQ.rows, saldo };
    });

    if (data.notFound) {
      return res.status(404).json({ error: 'Operación no encontrada', reason: 'not_found' });
    }

    // Acumular pagado para mostrar pagado_acumulado_usd row-by-row.
    let acumulado = 0;
    const pagos = data.pagos.map((p) => {
      acumulado = round2(acumulado + Number(p.monto_usd));
      return {
        id: p.id,
        monto_usd: Number(p.monto_usd),
        moneda_pago: p.moneda_pago || 'USD',
        monto_pago: p.moneda_pago === 'ARS' ? Number(p.monto_ars) : Number(p.monto_usd),
        tc_pago: p.tc_pago != null ? Number(p.tc_pago) : Number(p.tc_used),
        tc_venta: p.tc_venta != null ? Number(p.tc_venta) : null,
        diferencia_cambiaria_ars: Number(p.diferencia_cambiaria_ars || 0),
        cambio_divisa_id: p.cambio_divisa_id || null,
        caja_seller_id: p.caja_seller_id,
        caja_buyer_id: p.caja_buyer_id,
        seller_movimiento_id: p.seller_cobro_id,
        buyer_movimiento_id: p.buyer_pago_id,
        side: p.registered_by_side,
        registered_by_user_id: p.registered_by_user_id,
        registered_by_username: p.registered_by_username,
        fecha: p.registered_at,
        propagated_at: p.propagated_at,
        pagado_acumulado_usd: acumulado,
        restante_usd: round2(Number(data.op.total_usd) - acumulado),
      };
    });

    return res.json({
      operation: {
        id: data.op.id,
        my_side: data.op.seller_tenant_id === myTenantId ? 'seller' : 'buyer',
        total_usd: Number(data.op.total_usd),
        status: data.op.status,
      },
      saldo: {
        pagado_usd: data.saldo.pagado_usd,
        restante_usd: data.saldo.restante_usd,
        total_usd: data.saldo.total_usd,
        completo: data.saldo.completo,
      },
      pagos,
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/operations/:id/devolucion
//
// Devolución cross-tenant (decisión #11). Solo el buyer puede iniciar.
//
// Flow:
//   A. Lookup op + verificar status='active' + caller es buyer
//   B. Verificar parent_op_id NULL (no se devuelve una devolución)
//   C. Para cada item: validar cantidad <= disponible (cantidad_original − ya devuelto)
//   D. SET LOCAL seller: stock += cantidad + INSERT mov_cc devolución (monto negativo)
//   E. SET LOCAL buyer: stock -= cantidad + INSERT proveedor_mov devolución (monto negativo)
//   F. INSERT cross_tenant_operations NEW con parent_op_id apuntando a la original,
//      total negativo, status='active', items
//   G. Notif a ambos lados (operation_modified con flag is_devolucion=true)
//   H. Audit del buyer (originador)
//   I. COMMIT
//
// DECISIÓN F4: si la devolución supera lo pagado, queda SALDO A FAVOR del
// buyer (no revierte pagos automáticamente). El seller le devuelve la plata
// por afuera o descuenta del próximo pedido.
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/devolucion', validate(devolucionSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const opId = parseId(req.params.id);
  if (!opId) return res.status(400).json({ error: 'id inválido' });
  const { items: devItems, motivo } = req.body;

  try {
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // A. Lookup op.
        const opQ = await client.query(
          `SELECT * FROM cross_tenant_operations
             WHERE id = $1
               AND (seller_tenant_id = $2 OR buyer_tenant_id = $2)
             FOR UPDATE`,
          [opId, myTenantId]
        );
        const op = opQ.rows[0];
        if (!op) {
          await client.query('ROLLBACK');
          return { error: 'not_found', status: 404 };
        }
        if (op.status !== 'active') {
          await client.query('ROLLBACK');
          return { error: 'op_not_active', status: 409 };
        }
        if (op.parent_op_id != null) {
          // No se devuelve una devolución.
          await client.query('ROLLBACK');
          return { error: 'cannot_return_a_return', status: 400 };
        }
        if (op.buyer_tenant_id !== myTenantId) {
          await client.query('ROLLBACK');
          return { error: 'only_buyer_can_devolucion', status: 403 };
        }

        const sellerTenantId = op.seller_tenant_id;
        const buyerTenantId  = op.buyer_tenant_id;

        // B. Cargar items originales + items ya devueltos (sumando todas las
        // devoluciones previas con parent_op_id=opId).
        const origItemsQ = await client.query(
          `SELECT id, seller_producto_id, buyer_producto_id, cantidad,
                  precio_unitario_usd, precio_unitario_ars
             FROM cross_tenant_operation_items
             WHERE cross_tenant_operation_id = $1
             ORDER BY id`,
          [opId]
        );
        const origItemsMap = new Map(origItemsQ.rows.map((r) => [Number(r.id), r]));

        // Suma de devoluciones previas por item original (para validar cantidad).
        // Las devoluciones son ops con parent_op_id IS NOT NULL. Sus items
        // tienen cantidad POSITIVA (el CHECK > 0 lo enforza). La identidad
        // de devolución viene del parent_op_id + total_usd negativo de la op.
        const prevDevQ = await client.query(
          `SELECT items.seller_producto_id, items.buyer_producto_id,
                  SUM(items.cantidad) AS cant_devuelta
             FROM cross_tenant_operation_items items
             JOIN cross_tenant_operations devops
               ON devops.id = items.cross_tenant_operation_id
             WHERE devops.parent_op_id = $1
             GROUP BY items.seller_producto_id, items.buyer_producto_id`,
          [opId]
        );
        const devueltoMap = new Map();
        for (const r of prevDevQ.rows) {
          const key = `${r.seller_producto_id}_${r.buyer_producto_id}`;
          devueltoMap.set(key, Number(r.cant_devuelta) || 0);
        }

        // Validar cada item solicitado + armar lista de devolución.
        const itemsDevolucion = [];
        let totalUsdDev = 0;
        let totalArsDev = 0;
        for (const di of devItems) {
          const orig = origItemsMap.get(Number(di.cross_tenant_operation_item_id));
          if (!orig) {
            await client.query('ROLLBACK');
            return { error: 'item_not_in_op', status: 400,
              details: { cross_tenant_operation_item_id: di.cross_tenant_operation_item_id } };
          }
          const key = `${orig.seller_producto_id}_${orig.buyer_producto_id}`;
          const yaDevuelto = devueltoMap.get(key) || 0;
          const disponible = Number(orig.cantidad) - yaDevuelto;
          const pedido = Number(di.cantidad);
          if (pedido > disponible) {
            await client.query('ROLLBACK');
            return { error: 'devolucion_excede_cantidad', status: 400,
              details: { item_id: orig.id, cantidad_original: Number(orig.cantidad),
                         ya_devuelto: yaDevuelto, disponible, pedido } };
          }
          const precio_usd = Number(orig.precio_unitario_usd);
          const precio_ars = Number(orig.precio_unitario_ars);
          itemsDevolucion.push({
            seller_producto_id: orig.seller_producto_id,
            buyer_producto_id:  orig.buyer_producto_id,
            cantidad: pedido,
            precio_unitario_usd: precio_usd,
            precio_unitario_ars: precio_ars,
          });
          totalUsdDev += precio_usd * pedido;
          totalArsDev += precio_ars * pedido;
        }
        totalUsdDev = round2(totalUsdDev);
        totalArsDev = round2(totalArsDev);

        // Lookup tenants para descripciones.
        const tenantsQ = await client.query(
          `SELECT id, nombre, slug, plan FROM tenants WHERE id = ANY($1::int[])`,
          [[sellerTenantId, buyerTenantId]]
        );
        const tenantsById = new Map(tenantsQ.rows.map((r) => [r.id, r]));
        const sellerTenant = tenantsById.get(sellerTenantId);
        const buyerTenant  = tenantsById.get(buyerTenantId);

        // C. SET LOCAL seller: stock += cantidad + INSERT mov_cc devolución.
        await client.query(`SET LOCAL app.current_tenant = ${Number(sellerTenantId)}`);
        await client.query(
          `UPDATE productos p SET
              cantidad = p.cantidad + u.cant,
              estado = CASE
                WHEN p.cantidad + u.cant > 0 AND p.estado = 'vendido' THEN 'disponible'
                ELSE p.estado
              END
            FROM UNNEST($1::int[], $2::int[]) AS u(pid, cant)
            WHERE p.id = u.pid AND p.tenant_id = $3 AND p.deleted_at IS NULL`,
          [
            itemsDevolucion.map((x) => x.seller_producto_id),
            itemsDevolucion.map((x) => x.cantidad),
            sellerTenantId,
          ]
        );
        // Resolver cliente_cc del seller (mismo nombre del buyer).
        const sellerClienteCcId = await ensureSellerClienteCc(client, sellerTenantId, buyerTenant);
        // INSERT mov_cc tipo='devolucion' con monto USD ABSOLUTO + cross_tenant
        // FIELD. La devolucion en el módulo CC se trackea con tipo='devolucion'
        // (que ya existe en el CHECK desde la migration B2B saldo-inicial).
        const sellerDevMovQ = await client.query(
          `INSERT INTO movimientos_cc
             (tenant_id, cliente_cc_id, fecha, tipo, descripcion, monto_total,
              notas, caja_id, created_by_user_id, estado,
              cross_tenant_operation_id)
           VALUES ($1, $2, CURRENT_DATE, 'devolucion', $3, $4,
                   $5, NULL, $6, 'acreditado',
                   NULL)
           RETURNING id`,
          [
            sellerTenantId,
            sellerClienteCcId,
            `Red B2B devolución de op #${opId} ← ${buyerTenant.nombre}`,
            totalUsdDev,
            motivo || null,
            userId,
          ]
        );
        const sellerDevMovId = sellerDevMovQ.rows[0].id;

        // D. SET LOCAL buyer: stock -= cantidad (sin guard — puede quedar
        // negativo si ya vendió) + INSERT proveedor_mov tipo='devolucion'
        // (NOTA: el CHECK de proveedor_movimientos.tipo NO incluye 'devolucion'
        // — usamos 'pago' con monto negativo NO ES POSIBLE porque monto >= 0
        // CHECK. Estrategia: insertamos como soft entry con descripción
        // "devolución" pero usando tipo='pago' (porque es plata que
        // efectivamente sale de la deuda al proveedor)... pero monto >= 0
        // hace esto imposible. ALTERNATIVA: hacemos UPDATE del mov original
        // restando del monto_total, pero no queremos tocar el mov original
        // por trazabilidad. SOLUCIÓN F4: usamos tipo='pago' con monto >= 0
        // representando el monto devuelto — describe lo que pasó pero
        // semánticamente NO ES un pago).
        //
        // Mejor decisión: INSERT con tipo='pago' (= deuda baja para el buyer)
        // monto = totalUsdDev (positivo) descripción explícita de devolución.
        await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
        await client.query(
          `UPDATE productos p SET
              cantidad = p.cantidad - u.cant,
              estado = CASE
                WHEN p.cantidad - u.cant <= 0 THEN 'vendido'
                ELSE p.estado
              END
            FROM UNNEST($1::int[], $2::int[]) AS u(pid, cant)
            WHERE p.id = u.pid AND p.tenant_id = $3 AND p.deleted_at IS NULL`,
          [
            itemsDevolucion.map((x) => x.buyer_producto_id),
            itemsDevolucion.map((x) => x.cantidad),
            buyerTenantId,
          ]
        );
        const buyerProveedorId = await ensureBuyerProveedor(client, buyerTenantId, sellerTenant);
        const buyerDevMovQ = await client.query(
          `INSERT INTO proveedor_movimientos
             (tenant_id, proveedor_id, fecha, tipo, descripcion, monto, moneda, tc,
              monto_usd, caja_id, notas, created_by_user_id,
              cross_tenant_operation_id)
           VALUES ($1, $2, CURRENT_DATE, 'pago', $3, $4, 'USD', NULL,
                   $4, NULL, $5, $6,
                   NULL)
           RETURNING id`,
          [
            buyerTenantId,
            buyerProveedorId,
            `Red B2B devolución de op #${opId} → ${sellerTenant.nombre}`,
            totalUsdDev,
            motivo || null,
            userId,
          ]
        );
        const buyerDevMovId = buyerDevMovQ.rows[0].id;

        // E. INSERT cross_tenant_operations NEW (devolución).
        // Total y precios negativos para diferenciar. parent_op_id apunta a la
        // op original.
        const newOpQ = await client.query(
          `INSERT INTO cross_tenant_operations
             (partnership_id, seller_tenant_id, buyer_tenant_id,
              seller_venta_id, buyer_compra_id, status,
              total_usd, total_ars, tc_used, created_by_user_id,
              parent_op_id)
           VALUES ($1, $2, $3, $4, $5, 'active',
                   $6, $7, $8, $9,
                   $10)
           RETURNING id, created_at`,
          [
            op.partnership_id,
            sellerTenantId,
            buyerTenantId,
            sellerDevMovId,
            buyerDevMovId,
            -totalUsdDev,                        // total negativo
            -totalArsDev,
            Number(op.tc_used),
            userId,
            opId,                                 // parent
          ]
        );
        const devOpId = newOpQ.rows[0].id;

        // Items: cantidad POSITIVA (CHECK cantidad > 0 en la tabla). El
        // signo negativo de la op (total_usd) + parent_op_id IS NOT NULL
        // identifican que es una devolución. La suma de cantidades en
        // devoluciones se obtiene del agregado WHERE parent_op_id IS NOT NULL.
        // Precios POSITIVOS también — el total negativo aplica a nivel op.
        await client.query(
          `INSERT INTO cross_tenant_operation_items
             (cross_tenant_operation_id, seller_producto_id, buyer_producto_id,
              cantidad, precio_unitario_usd, precio_unitario_ars)
           SELECT $1, spid, bpid, cant, pu_usd, pu_ars
             FROM UNNEST(
               $2::int[], $3::int[], $4::int[],
               $5::numeric[], $6::numeric[]
             ) AS u(spid, bpid, cant, pu_usd, pu_ars)`,
          [
            devOpId,
            itemsDevolucion.map((x) => x.seller_producto_id),
            itemsDevolucion.map((x) => x.buyer_producto_id),
            itemsDevolucion.map((x) => x.cantidad),
            itemsDevolucion.map((x) => x.precio_unitario_usd),
            itemsDevolucion.map((x) => x.precio_unitario_ars),
          ]
        );

        // Link mov_cc + proveedor_mov a la nueva op.
        await client.query(`SET LOCAL app.current_tenant = ${Number(sellerTenantId)}`);
        await client.query(
          `UPDATE movimientos_cc SET cross_tenant_operation_id = $1
             WHERE id = $2 AND tenant_id = $3`,
          [devOpId, sellerDevMovId, sellerTenantId]
        );
        await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
        await client.query(
          `UPDATE proveedor_movimientos SET cross_tenant_operation_id = $1
             WHERE id = $2 AND tenant_id = $3`,
          [devOpId, buyerDevMovId, buyerTenantId]
        );

        // F. Notificar a AMBOS lados (el seller necesita saber que llega
        // mercadería, el buyer queda con confirmación). Para el seller es
        // 'operation_modified' con payload flag de devolución (no creamos
        // nuevo type para evitar otra migration al CHECK del notification type).
        await notify(client, sellerTenantId, 'operation_modified', {
          partner: tenantSnapshot(buyerTenant),
          operation_id: opId,
          devolucion_op_id: devOpId,
          is_devolucion: true,
          total_usd_devuelto: totalUsdDev,
          items_count: itemsDevolucion.length,
          motivo: motivo || null,
          from_user_id: userId,
          from_username: req.user.username,
        }, { partnershipId: op.partnership_id, operationId: opId });

        // G. Audit del buyer (originador de la devolución).
        await client.query(`SET LOCAL app.current_tenant = ${Number(myTenantId)}`);
        await audit(client, {
          tenantId: myTenantId,
          userId,
          action: 'cross_tenant_devolucion',
          payload: {
            parent_operation_id: opId,
            devolucion_op_id: devOpId,
            total_usd_devuelto: totalUsdDev,
            items_count: itemsDevolucion.length,
            motivo: motivo || null,
          },
        });

        await client.query('COMMIT');
        return {
          ok: true,
          devOpId,
          opId,
          sellerTenantId,
          buyerTenantId,
          partnershipId: op.partnership_id,
          totalUsdDev,
        };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });

    if (result.error) {
      return res.status(result.status).json({
        error: errorMessage(result.error),
        reason: result.error,
        ...(result.details ? { details: result.details } : {}),
      });
    }

    // Invalidar caches.
    invalidateConciliationCache(result.partnershipId);
    invalidateMetricas(result.sellerTenantId).catch(() => {});
    invalidateMetricas(result.buyerTenantId).catch(() => {});

    logger.info({
      parent_operation_id: result.opId,
      devolucion_op_id: result.devOpId,
      tenant_id: myTenantId,
      user_id: userId,
      total_usd_devuelto: result.totalUsdDev,
    }, '[red-b2b/F4] devolución cross-tenant registrada');

    return res.status(201).json({
      devolucion: {
        id: result.devOpId,
        parent_op_id: result.opId,
        total_usd_devuelto: result.totalUsdDev,
      },
    });
  } catch (err) {
    return next(err);
  }
});

function errorMessage(reason) {
  const map = {
    not_found:                   'Operación no encontrada.',
    op_cancelled:                'La operación fue cancelada — no se pueden registrar pagos.',
    op_frozen:                   'La operación está congelada (alguno de los tenants vencido).',
    op_not_active:                'La operación no está activa.',
    side_mismatch:               'El side declarado no coincide con tu rol en la operación.',
    overpayment:                 'El monto excede el saldo restante de la operación.',
    caja_not_found:              'La caja indicada no existe o está inactiva.',
    caja_moneda_incompatible:    'La caja no es compatible con la moneda del pago.',
    buyer_no_caja_compatible:    'El partner no tiene caja default compatible con la moneda del pago.',
    seller_no_caja_compatible:   'El partner no tiene caja default compatible con la moneda del pago.',
    only_buyer_can_devolucion:   'Solo el comprador puede iniciar una devolución cross-tenant.',
    cannot_return_a_return:      'No se puede devolver una devolución — devolvé sobre la operación original.',
    item_not_in_op:              'Alguno de los items no pertenece a la operación.',
    devolucion_excede_cantidad:  'La cantidad a devolver excede lo disponible (cantidad original menos lo ya devuelto).',
  };
  return map[reason] || 'Acción inválida.';
}

module.exports = router;

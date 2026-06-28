/**
 * Red B2B — operations CORE (F3 #456).
 *
 * Endpoints bajo /api/red-b2b/operations. Diseño completo en
 * docs/design/red-b2b-cross-tenant.md sección 5.2 + 6.2.
 *
 * Endpoints:
 *   POST   /              → crear operación (el CORE — venta + compra
 *                            espejada + auto-create productos + cross_tenant
 *                            row + notif + audit, TODO en UNA tx atómica)
 *   GET    /              → lista operaciones donde mi tenant participa
 *   GET    /:id           → detalle (items + status + my_side + partner)
 *   POST   /:id/cancel    → cancelar (solo el seller — decisión #10)
 *   PATCH  /:id           → editar (solo notes en F3 — decisión doc 5.2)
 *
 * Multi-tenant y RLS:
 *   POST CORE usa `db.adminQuery()` (BYPASSRLS / role tecny_admin) porque
 *   escribe en AMBOS tenants en la misma tx (movimientos_cc del seller +
 *   proveedor_movimientos del buyer + productos auto-creados del buyer +
 *   cross_tenant_operations + notifications). El SET LOCAL cambia entre
 *   bloques para que los WITH CHECK del FORCE RLS validen el tenant_id
 *   correcto.
 *
 *   GET / y GET /:id usan `db.withTenant()` (NOSUPERUSER, RLS estándar).
 *   cross_tenant_operations tiene RLS DUAL (visible al seller O al buyer),
 *   y agregamos un WHERE inline `(seller_tenant_id = X OR buyer_tenant_id =
 *   X)` belt-and-suspenders.
 *
 *   POST /:id/cancel usa adminQuery por la misma razón que POST CORE
 *   (toca ambos lados de la operación). Sólo el SELLER puede cancelar
 *   (decisión #10 del doc) — eso lo enforzamos verificando
 *   seller_tenant_id === caller.tenantId.
 *
 *   PATCH /:id F3 solo modifica notes en cross_tenant_operations + las
 *   descripciones de movimientos_cc + proveedor_movimientos. Usa adminQuery
 *   pero no toca stock ni CC.
 *
 * Audit:
 *   POST: tenant_admin_actions del seller con action='cross_tenant_op_created'
 *         y payload {op_id, partner_tenant_id, total_usd, items_count}.
 *   POST /:id/cancel: action='cross_tenant_op_cancelled'.
 *   PATCH: action='cross_tenant_op_modified' (solo si cambió algo).
 *   Las 3 actions ya están en el CHECK constraint (migration de F3 los agrega
 *   si no estaban — ver tenant_admin_actions migrations).
 *
 *   Si la migration que extiende el CHECK no fue aplicada aún (caso
 *   transición), el audit falla silenciosamente — preferimos perder el audit
 *   log antes que romper el flow core. Mismo patrón que F1 partnerships.
 *
 * Decisiones críticas tomadas fuera del doc (ver tests F3 + readme F3):
 *   1. Tablas: movimientos_cc (no ventas) + proveedor_movimientos (no compras).
 *      Razón: el flow B2B vive en CC, no en retail.
 *   2. Auto-create productos buyer SIEMPRE (sin dedup por nombre). Razón:
 *      simplicidad + atomicidad; merge-into ya resuelve duplicados con 1 click.
 *   3. cliente_cc del seller + proveedor del buyer se crean on-the-fly por
 *      nombre del partner. Idempotente. F4 podría agregar linked_tenant_id.
 *   4. Estado venta = 'pendiente' (no 'acreditado'). Razón: la op es CC pura;
 *      el cobro/pago real cae en F4 → recién ahí pasa a acreditada.
 *   5. CC: NO se inserta cobro al crear la op. La venta queda como deuda
 *      del buyer en CC seller, y como deuda al proveedor en CC del buyer.
 *      F4 implementa el cobro/pago cross-tenant que cancela ambas CCs.
 *   6. Cancel reverso de stock: SIEMPRE reincorpora al seller (UPDATE +cant)
 *      y resta del buyer (UPDATE -cant SIN guard — puede quedar negativo
 *      si el buyer ya mergeo y vendió). El buyer recibe notif si su stock
 *      queda en negativo (warning, no error).
 */

const router = require('express').Router();
const db = require('../../config/database');
const logger = require('../../lib/logger');
const validate = require('../../lib/validate');
const parseId = require('../../lib/parseId');
const {
  getActivePartnershipById,
} = require('../../lib/partnership');
const {
  validateOperationPrecondition,
  findOrCreateBuyerProducto,
  createSellerVenta,
  createBuyerCompra,
} = require('../../lib/crossTenantOps');
const {
  createOperationSchema,
  cancelOperationSchema,
  patchOperationSchema,
} = require('../../schemas/redB2b');
const { round2 } = require('../../lib/money');
const { invalidateMetricas } = require('../../lib/inventarioCache');
// 2026-06-29 #458 F5: dispatch fire-and-forget de emails Red B2B.
const redB2bEmail = require('../../lib/redB2bEmail');

// ──────────────────────────────────────────────────────────────────────────
// Helper: notify (mismo patrón que partnerships.js — copiado por simplicidad)
//
// Inserta una fila en cross_tenant_notifications. El receptor (tenantId)
// determina el RLS context que necesitamos setear ANTES del INSERT (incluso
// con BYPASSRLS, los WITH CHECK del FORCE RLS validan).
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

// ──────────────────────────────────────────────────────────────────────────
// Helper: audit (best-effort — si la action no está en el CHECK constraint
// porque la migration de extensión de actions no corrió, swallowed silently
// para no romper el flow core).
// ──────────────────────────────────────────────────────────────────────────
async function audit(client, { tenantId, userId, action, payload }) {
  // Envolvemos en SAVEPOINT — si la action no está en el CHECK constraint
  // (migration que extiende los valores aún no aplicada) preferimos perder
  // el audit log antes que romper el flow core. SIN savepoint, un error
  // 23514 deja la tx en estado abortado y todo el flow se pierde — ese era
  // el bug original de F3 que descubrimos en tests.
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
      logger.warn({ action, err: err.message }, '[red-b2b] audit action no permitida — migration pendiente?');
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
// POST /api/red-b2b/operations  ←──── EL CORE
//
// Body: { partnership_id, items: [{producto_id, cantidad, precio_usd}],
//         tc, total_usd, total_ars, notes? }
//
// Flow (TODO en una sola transacción atómica con BYPASSRLS):
//   A. Sanity check: sum(items.precio_usd * cantidad) ≈ total_usd (±0.01)
//   B. Lookup partnership active + caller participa
//   C. Resolver buyerTenantId
//   D. Verificar ambos tenants activos (no suspended, paid_until vigente)
//   E. SET LOCAL seller → validar productos + decrement stock atómico
//   F. INSERT movimientos_cc (venta B2B) + items_movimiento_cc del seller
//   G. SET LOCAL buyer → auto-create productos (1 por item, pending=true)
//   H. INSERT proveedor_movimientos (compra B2B) + items del buyer
//   I. (Sin tenant scope) INSERT cross_tenant_operations + items + UPDATEs
//      de links + UPDATE productos auto-creados con la op_id real
//   J. Notif al buyer + audit del seller
//   K. COMMIT
//
// Cualquier paso falla → ROLLBACK completo. La atomicidad es la única
// defensa contra saldos divergentes (mitigación riesgo 9.2 del doc).
// ──────────────────────────────────────────────────────────────────────────
router.post('/', validate(createOperationSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const body = req.body;

  // A. Sanity check del total. ±0.01 por floating point rounding.
  const sumUsd = body.items.reduce(
    (acc, it) => acc + Number(it.precio_usd) * Number(it.cantidad),
    0
  );
  if (Math.abs(round2(sumUsd) - round2(body.total_usd)) > 0.01) {
    return res.status(400).json({
      error: 'El total USD no coincide con la suma de los items.',
      reason: 'total_usd_mismatch',
      details: { sum_items: round2(sumUsd), declared: round2(body.total_usd) },
    });
  }

  try {
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // B. Partnership active + caller participa (sin SET LOCAL — usamos
        // BYPASSRLS para leer la fila aunque el RLS dual ya la filtraría).
        const partnership = await getActivePartnershipById(client, body.partnership_id, myTenantId);

        // D. Validaciones pre-condición (partnership active + tenants OK).
        const precheck = await validateOperationPrecondition(client, partnership, myTenantId);
        if (!precheck.ok) {
          await client.query('ROLLBACK');
          // Map de reasons → status code.
          const statusMap = {
            partnership_not_active: partnership ? 409 : 404,
            caller_not_in_partnership: 403,
            seller_suspended: 409,
            buyer_suspended: 409,
            seller_expired: 409,
            buyer_expired: 409,
          };
          return {
            error: precheck.error,
            status: statusMap[precheck.error] || 409,
          };
        }
        const { sellerTenant, buyerTenant } = precheck;
        const buyerTenantId = buyerTenant.id;

        // E + F. SET LOCAL seller → createSellerVenta (valida productos +
        // decrement stock + INSERT movimientos_cc + items_movimiento_cc).
        await client.query(`SET LOCAL app.current_tenant = ${Number(myTenantId)}`);
        let sellerResult;
        try {
          sellerResult = await createSellerVenta(client, myTenantId, {
            items: body.items,
            tc: body.tc,
            total_usd: body.total_usd,
            total_ars: body.total_ars,
            notes: body.notes,
            callerUserId: userId,
            buyerTenant,
          });
        } catch (e) {
          // stock_insufficient / producto_not_found → 409/404 con detalle.
          await client.query('ROLLBACK');
          if (e.reason === 'stock_insufficient') {
            return { error: 'stock_insufficient', status: 409, details: e.detail };
          }
          if (e.reason === 'producto_not_found') {
            return { error: 'producto_not_found', status: 404, details: e.detail };
          }
          throw e;
        }

        // Lookup nombres de los productos del seller (para auto-create del buyer).
        // Lo hago acá porque ya tengo SET LOCAL seller — leemos la info que
        // necesitamos para crear los productos del buyer con datos coherentes.
        const sellerProdIds = body.items.map((it) => Number(it.producto_id));
        const sellerProdsQ = await client.query(
          `SELECT id, nombre, observaciones FROM productos
             WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
          [sellerProdIds]
        );
        const sellerProdMap = new Map(sellerProdsQ.rows.map((p) => [Number(p.id), p]));

        // G. SET LOCAL buyer → auto-create productos (uno por item, sin dedup).
        await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
        const mappedItems = [];
        for (const it of body.items) {
          const sellerProd = sellerProdMap.get(Number(it.producto_id));
          const buyerProdId = await findOrCreateBuyerProducto(client, buyerTenantId, {
            nombre: sellerProd.nombre,
            descripcion: sellerProd.observaciones,
            costo_usd: it.precio_usd,
            cantidad: it.cantidad,
          });
          mappedItems.push({
            seller_producto_id: Number(it.producto_id),
            buyer_producto_id: buyerProdId,
            cantidad: Number(it.cantidad),
            precio_usd: Number(it.precio_usd),
            nombre: sellerProd.nombre,
          });
        }

        // H. createBuyerCompra (proveedor_movimientos + items del buyer).
        // Stock NO se incrementa acá: findOrCreateBuyerProducto ya creó los
        // productos con la cantidad correcta (es la primer vez que el buyer
        // los ve). El helper deja una nota explicando.
        const buyerResult = await createBuyerCompra(client, buyerTenantId, {
          mappedItems,
          total_usd: body.total_usd,
          notes: body.notes,
          callerUserId: userId,
          sellerTenant,
        });

        // I. INSERT cross_tenant_operations + items maestros. Esta tabla no
        // es tenant-scoped por sí sola (RLS dual visible a ambos), así que
        // no necesita SET LOCAL específico.
        const crossOpQ = await client.query(
          `INSERT INTO cross_tenant_operations
             (partnership_id, seller_tenant_id, buyer_tenant_id,
              seller_venta_id, buyer_compra_id, status,
              total_usd, total_ars, tc_used, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9)
           RETURNING id, created_at`,
          [
            partnership.id,
            myTenantId,
            buyerTenantId,
            sellerResult.movimientoCcId,
            buyerResult.proveedorMovimientoId,
            round2(body.total_usd),
            round2(body.total_ars),
            Number(body.tc),
            userId,
          ]
        );
        const crossOp = crossOpQ.rows[0];

        // Items maestros (sin scope tenant).
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
            crossOp.id,
            mappedItems.map((x) => x.seller_producto_id),
            mappedItems.map((x) => x.buyer_producto_id),
            mappedItems.map((x) => x.cantidad),
            mappedItems.map((x) => round2(x.precio_usd)),
            mappedItems.map((x) => round2(x.precio_usd * Number(body.tc))),
          ]
        );

        // UPDATE de links: movimientos_cc.cross_tenant_operation_id + idem
        // en proveedor_movimientos. Cada UPDATE necesita SET LOCAL del lado
        // correspondiente para que el RLS estricto permita el write.
        await client.query(`SET LOCAL app.current_tenant = ${Number(myTenantId)}`);
        await client.query(
          `UPDATE movimientos_cc SET cross_tenant_operation_id = $1
             WHERE id = $2 AND tenant_id = $3`,
          [crossOp.id, sellerResult.movimientoCcId, myTenantId]
        );

        await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
        await client.query(
          `UPDATE proveedor_movimientos SET cross_tenant_operation_id = $1
             WHERE id = $2 AND tenant_id = $3`,
          [crossOp.id, buyerResult.proveedorMovimientoId, buyerTenantId]
        );

        // UPDATE productos auto-creados del buyer con la op_id real.
        await client.query(
          `UPDATE productos SET created_from_cross_tenant_op_id = $1
             WHERE id = ANY($2::int[]) AND tenant_id = $3`,
          [crossOp.id, mappedItems.map((x) => x.buyer_producto_id), buyerTenantId]
        );

        // J. Notif al buyer (mantiene SET LOCAL buyer del bloque anterior).
        await notify(
          client,
          buyerTenantId,
          'operation_received',
          {
            partner: tenantSnapshot(sellerTenant),
            operation_id: crossOp.id,
            total_usd: round2(body.total_usd),
            total_ars: round2(body.total_ars),
            items_count: body.items.length,
            from_user_id: userId,
            from_username: req.user.username,
          },
          { partnershipId: partnership.id, operationId: crossOp.id }
        );

        // Audit del seller (notify cambió el SET LOCAL al buyer — restauramos).
        await client.query(`SET LOCAL app.current_tenant = ${Number(myTenantId)}`);
        await audit(client, {
          tenantId: myTenantId,
          userId,
          action: 'cross_tenant_op_created',
          payload: {
            operation_id: crossOp.id,
            partnership_id: partnership.id,
            buyer_tenant_id: buyerTenantId,
            total_usd: round2(body.total_usd),
            items_count: body.items.length,
          },
        });

        await client.query('COMMIT');
        return {
          ok: true,
          operation: crossOp,
          sellerResult,
          buyerResult,
          partnership,
          buyerTenant,
          sellerTenant,
          mappedItems,
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

    // Invalidate cache de inventario de AMBOS tenants — el seller decrementó
    // stock, el buyer agregó productos nuevos.
    invalidateMetricas(myTenantId).catch(() => { /* best-effort */ });
    invalidateMetricas(result.buyerTenant.id).catch(() => { /* best-effort */ });

    // F5 #458: email al buyer (gated por operation_received).
    setImmediate(() => {
      redB2bEmail.dispatch({
        tenantId: result.buyerTenant.id,
        type:     'operation_received',
        args: {
          partnerNombre: result.sellerTenant?.nombre || `Tenant #${myTenantId}`,
          totalUsd:      round2(body.total_usd),
          totalArs:      round2(body.total_ars),
          itemsCount:    body.items.length,
          operationId:   result.operation.id,
        },
      }).catch(() => {});
    });

    logger.info(
      {
        operation_id: result.operation.id,
        seller_tenant_id: myTenantId,
        buyer_tenant_id: result.buyerTenant.id,
        partnership_id: result.partnership.id,
        user_id: userId,
        total_usd: round2(body.total_usd),
        items_count: body.items.length,
      },
      '[red-b2b] cross-tenant operation creada'
    );

    return res.status(201).json({
      operation: {
        id: result.operation.id,
        status: 'active',
        created_at: result.operation.created_at,
        partnership_id: result.partnership.id,
        partner: tenantSnapshot(result.buyerTenant),
        my_side: 'seller',
        seller_venta_id: result.sellerResult.movimientoCcId,
        buyer_compra_id: result.buyerResult.proveedorMovimientoId,
        total_usd: round2(body.total_usd),
        total_ars: round2(body.total_ars),
        tc_used: Number(body.tc),
        items_count: body.items.length,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/operations
//
// Query params:
//   partnership_id  → filtra a una partnership específica
//   status          → 'active' | 'cancelled' | 'frozen'
//   from / to       → rango de fechas (created_at)
//
// Devuelve lista con my_side calculado + partner info.
// ──────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  const myTenantId = req.tenantId;
  const partnershipId = req.query.partnership_id ? parseId(req.query.partnership_id) : null;
  const statusFilter = ['active', 'cancelled', 'frozen'].includes(req.query.status)
    ? req.query.status
    : null;
  const fromDate = req.query.from || null;
  const toDate = req.query.to || null;

  try {
    // Belt-and-suspenders: WHERE inline por mi tenant, además del RLS dual.
    // En tests local (superuser BYPASSRLS) el inline es el guard real.
    const mineFilter = `(seller_tenant_id = ${Number(myTenantId)} OR buyer_tenant_id = ${Number(myTenantId)})`;
    const where = [mineFilter];
    const params = [];
    if (partnershipId) { params.push(partnershipId); where.push(`partnership_id = $${params.length}`); }
    if (statusFilter)  { params.push(statusFilter);  where.push(`status = $${params.length}`); }
    if (fromDate)      { params.push(fromDate);      where.push(`created_at >= $${params.length}`); }
    if (toDate)        { params.push(toDate);        where.push(`created_at <= $${params.length}`); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const ops = await db.withTenant(myTenantId, async (client) => {
      const q = await client.query(
        `SELECT
           id, partnership_id, seller_tenant_id, buyer_tenant_id,
           seller_venta_id, buyer_compra_id, status,
           total_usd, total_ars, tc_used,
           created_by_user_id, created_at, updated_at,
           last_modified_by_user_id, last_modified_at,
           CASE WHEN seller_tenant_id = ${Number(myTenantId)} THEN 'seller' ELSE 'buyer' END AS my_side,
           CASE WHEN seller_tenant_id = ${Number(myTenantId)} THEN buyer_tenant_id ELSE seller_tenant_id END AS partner_tenant_id
           FROM cross_tenant_operations
           ${whereSql}
           ORDER BY created_at DESC
           LIMIT 200`,
        params
      );

      // Items count por op (cheap subquery).
      if (q.rows.length > 0) {
        const opIds = q.rows.map((r) => r.id);
        const itemsQ = await client.query(
          `SELECT cross_tenant_operation_id AS op_id, COUNT(*) AS n
             FROM cross_tenant_operation_items
             WHERE cross_tenant_operation_id = ANY($1::bigint[])
             GROUP BY 1`,
          [opIds]
        );
        const countByOp = new Map(itemsQ.rows.map((r) => [String(r.op_id), Number(r.n)]));
        for (const op of q.rows) {
          op.items_count = countByOp.get(String(op.id)) || 0;
        }
      }
      return q.rows;
    });

    // Hidratar partner tenant info (cross-tenant lookup via adminQuery).
    const partnerIds = [...new Set(ops.map((o) => o.partner_tenant_id))];
    let tenantsById = new Map();
    if (partnerIds.length > 0) {
      await db.adminQuery(async (client) => {
        const t = await client.query(
          `SELECT id, nombre, slug, plan FROM tenants WHERE id = ANY($1::int[])`,
          [partnerIds]
        );
        tenantsById = new Map(t.rows.map((r) => [r.id, r]));
      });
    }

    return res.json({
      operations: ops.map((op) => ({
        id: op.id,
        partnership_id: op.partnership_id,
        my_side: op.my_side,
        partner: tenantSnapshot(tenantsById.get(op.partner_tenant_id)),
        status: op.status,
        seller_venta_id: op.seller_venta_id,
        buyer_compra_id: op.buyer_compra_id,
        total_usd: Number(op.total_usd),
        total_ars: Number(op.total_ars),
        tc_used: Number(op.tc_used),
        items_count: op.items_count || 0,
        created_at: op.created_at,
        updated_at: op.updated_at,
        last_modified_at: op.last_modified_at,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/operations/:id
//
// Detalle full: items + status + partner + my_side + links a venta/compra.
// Si la op no pertenece al caller (ni como seller ni como buyer) → 404.
// ──────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  const myTenantId = req.tenantId;
  const opId = parseId(req.params.id);
  if (!opId) return res.status(400).json({ error: 'id inválido' });

  try {
    const op = await db.withTenant(myTenantId, async (client) => {
      const q = await client.query(
        `SELECT * FROM cross_tenant_operations
           WHERE id = $1
             AND (seller_tenant_id = $2 OR buyer_tenant_id = $2)`,
        [opId, myTenantId]
      );
      return q.rows[0] || null;
    });

    if (!op) {
      return res.status(404).json({ error: 'Operación no encontrada', reason: 'not_found' });
    }

    // Items + partner snapshot.
    const partnerTenantId = op.seller_tenant_id === myTenantId
      ? op.buyer_tenant_id
      : op.seller_tenant_id;

    const [items, partnerTenant, notesFromMov] = await Promise.all([
      // Items: no tienen RLS propio — leemos con admin (consistente con
      // el patrón de F2 productosPendingReview hidratando partner info).
      db.adminQuery(async (client) => {
        const q = await client.query(
          `SELECT id, seller_producto_id, buyer_producto_id, cantidad,
                  precio_unitario_usd, precio_unitario_ars,
                  original_cantidad, original_precio_unitario_usd
             FROM cross_tenant_operation_items
             WHERE cross_tenant_operation_id = $1
             ORDER BY id`,
          [opId]
        );
        return q.rows;
      }),
      db.adminQuery(async (client) => {
        const q = await client.query(
          `SELECT id, nombre, slug, plan FROM tenants WHERE id = $1`,
          [partnerTenantId]
        );
        return q.rows[0] || null;
      }),
      // Notes: las leemos del movimientos_cc / proveedor_movimientos según
      // qué lado soy. Lo hacemos con SET LOCAL al mi tenant (RLS estándar).
      db.withTenant(myTenantId, async (client) => {
        if (op.seller_tenant_id === myTenantId) {
          const q = await client.query(
            `SELECT notas, descripcion FROM movimientos_cc WHERE id = $1`,
            [op.seller_venta_id]
          );
          return q.rows[0] || null;
        } else {
          const q = await client.query(
            `SELECT notas, descripcion FROM proveedor_movimientos WHERE id = $1`,
            [op.buyer_compra_id]
          );
          return q.rows[0] || null;
        }
      }),
    ]);

    return res.json({
      operation: {
        id: op.id,
        partnership_id: op.partnership_id,
        my_side: op.seller_tenant_id === myTenantId ? 'seller' : 'buyer',
        partner: tenantSnapshot(partnerTenant),
        status: op.status,
        seller_venta_id: op.seller_venta_id,
        buyer_compra_id: op.buyer_compra_id,
        total_usd: Number(op.total_usd),
        total_ars: Number(op.total_ars),
        tc_used: Number(op.tc_used),
        notes: notesFromMov?.notas || null,
        descripcion: notesFromMov?.descripcion || null,
        created_at: op.created_at,
        updated_at: op.updated_at,
        last_modified_at: op.last_modified_at,
        items: items.map((it) => ({
          id: it.id,
          seller_producto_id: it.seller_producto_id,
          buyer_producto_id: it.buyer_producto_id,
          cantidad: it.cantidad,
          precio_unitario_usd: Number(it.precio_unitario_usd),
          precio_unitario_ars: Number(it.precio_unitario_ars),
          original_cantidad: it.original_cantidad,
          original_precio_unitario_usd: it.original_precio_unitario_usd != null
            ? Number(it.original_precio_unitario_usd) : null,
        })),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/operations/:id/cancel
//
// Solo el SELLER puede cancelar (decisión #10 del doc). Body: { reason? }.
//
// Flow:
//   - Verificar caller es seller_tenant_id (sino 403).
//   - Si status='cancelled' → 409 idempotente.
//   - SET LOCAL seller → UPDATE movimiento_cc.estado='anulado' (NO existe
//     en el CHECK constraint — usamos 'pendiente' + soft-delete deleted_at).
//     En realidad para el seller revertimos stock + soft-delete del mov.
//   - SET LOCAL buyer → UPDATE proveedor_movimientos similar + revert stock
//     (sin guard — el buyer puede haber vendido el stock).
//   - UPDATE cross_tenant_operations.status='cancelled'.
//   - Notif al buyer 'operation_cancelled'.
//   - Audit.
//
// Edge case stock negativo del buyer: si el buyer ya vendió el stock que
// recibió, el revert (UPDATE -cant) puede dejar la columna en negativo.
// F3 decisión #6: PERMITIR — incluimos warning en la notif para que el
// buyer sepa que tiene stock comprometido.
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/cancel', validate(cancelOperationSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const opId = parseId(req.params.id);
  if (!opId) return res.status(400).json({ error: 'id inválido' });

  const { reason } = req.body;

  try {
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // Lookup la op con BYPASSRLS — necesitamos ambos lados.
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
          return { error: 'already_cancelled', status: 409 };
        }
        if (op.seller_tenant_id !== myTenantId) {
          await client.query('ROLLBACK');
          return { error: 'only_seller_can_cancel', status: 403 };
        }

        // Cargar items para reverso de stock.
        const itemsQ = await client.query(
          `SELECT seller_producto_id, buyer_producto_id, cantidad
             FROM cross_tenant_operation_items
             WHERE cross_tenant_operation_id = $1`,
          [opId]
        );
        const items = itemsQ.rows;

        // SET LOCAL seller → revert stock + soft-delete mov.
        await client.query(`SET LOCAL app.current_tenant = ${Number(myTenantId)}`);
        if (items.length > 0) {
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
              items.map((x) => x.seller_producto_id),
              items.map((x) => x.cantidad),
              myTenantId,
            ]
          );
        }
        // Soft-delete del movimientos_cc del seller. No usamos UPDATE estado
        // porque el CHECK constraint del módulo CC no incluye 'anulado'.
        await client.query(
          `UPDATE movimientos_cc SET deleted_at = NOW()
             WHERE id = $1 AND tenant_id = $2`,
          [op.seller_venta_id, myTenantId]
        );

        // SET LOCAL buyer → revert stock (sin guard) + soft-delete mov.
        const buyerTenantId = op.buyer_tenant_id;
        await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);

        let stockNegativoBuyer = false;
        if (items.length > 0) {
          // UPDATE sin guard — puede dejar negativo. Pre-check para warning.
          const buyerProdIds = items.map((x) => x.buyer_producto_id);
          const buyerStockQ = await client.query(
            `SELECT id, cantidad FROM productos
               WHERE id = ANY($1::int[]) AND tenant_id = $2 AND deleted_at IS NULL`,
            [buyerProdIds, buyerTenantId]
          );
          const buyerStockMap = new Map(buyerStockQ.rows.map((r) => [Number(r.id), Number(r.cantidad)]));
          for (const it of items) {
            const cur = buyerStockMap.get(Number(it.buyer_producto_id));
            if (cur != null && cur < Number(it.cantidad)) {
              stockNegativoBuyer = true;
              break;
            }
          }

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
              items.map((x) => x.buyer_producto_id),
              items.map((x) => x.cantidad),
              buyerTenantId,
            ]
          );
        }
        await client.query(
          `UPDATE proveedor_movimientos SET deleted_at = NOW()
             WHERE id = $1 AND tenant_id = $2`,
          [op.buyer_compra_id, buyerTenantId]
        );

        // UPDATE cross_tenant_operations.status='cancelled' + last_modified.
        await client.query(
          `UPDATE cross_tenant_operations SET
              status = 'cancelled',
              updated_at = NOW(),
              last_modified_by_user_id = $1,
              last_modified_at = NOW()
            WHERE id = $2`,
          [userId, opId]
        );

        // Notif al buyer. Incluye warning si su stock quedó negativo.
        // Lookup del nombre del seller para el payload.
        const sellerTenantQ = await client.query(
          `SELECT id, nombre, slug, plan FROM tenants WHERE id = $1`,
          [myTenantId]
        );
        await notify(
          client,
          buyerTenantId,
          'operation_cancelled',
          {
            partner: tenantSnapshot(sellerTenantQ.rows[0]),
            operation_id: opId,
            reason: reason || null,
            stock_negativo_warning: stockNegativoBuyer,
            cancelled_by_user_id: userId,
          },
          { partnershipId: op.partnership_id, operationId: opId }
        );

        // Audit (volvemos al SET LOCAL del seller).
        await client.query(`SET LOCAL app.current_tenant = ${Number(myTenantId)}`);
        await audit(client, {
          tenantId: myTenantId,
          userId,
          action: 'cross_tenant_op_cancelled',
          payload: {
            operation_id: opId,
            buyer_tenant_id: buyerTenantId,
            reason: reason || null,
            stock_negativo_buyer: stockNegativoBuyer,
          },
        });

        await client.query('COMMIT');
        return {
          ok: true,
          opId,
          buyerTenantId,
          stockNegativoBuyer,
          sellerNombre: sellerTenantQ.rows[0]?.nombre || null,
          totalUsd:     op.total_usd != null ? Number(op.total_usd) : null,
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
      });
    }

    invalidateMetricas(myTenantId).catch(() => {});
    invalidateMetricas(result.buyerTenantId).catch(() => {});

    // F5 #458: email al buyer (gated por operation_cancelled).
    setImmediate(() => {
      redB2bEmail.dispatch({
        tenantId: result.buyerTenantId,
        type:     'operation_cancelled',
        args: {
          partnerNombre: result.sellerNombre || `Tenant #${myTenantId}`,
          totalUsd:      result.totalUsd,
          operationId:   opId,
          reason:        reason || null,
        },
      }).catch(() => {});
    });

    logger.info(
      { operation_id: opId, seller_tenant_id: myTenantId, user_id: userId, stock_negativo_buyer: result.stockNegativoBuyer },
      '[red-b2b] cross-tenant operation cancelada'
    );

    return res.json({ ok: true, operation_id: opId, status: 'cancelled' });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /api/red-b2b/operations/:id
//
// F3 SOLO permite editar `notes`. Body: { notes }.
// Solo el SELLER puede editar (consistente con cancel).
//
// UPDATE en cross_tenant_operations (no tiene columna notes — la guardamos
// via las descripciones de los mov_cc del seller + proveedor_mov del buyer)
// + descripciones + last_modified.
// ──────────────────────────────────────────────────────────────────────────
router.patch('/:id', validate(patchOperationSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const opId = parseId(req.params.id);
  if (!opId) return res.status(400).json({ error: 'id inválido' });

  const { notes } = req.body;

  try {
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const opQ = await client.query(
          `SELECT * FROM cross_tenant_operations
             WHERE id = $1 AND (seller_tenant_id = $2 OR buyer_tenant_id = $2)
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
          return { error: 'already_cancelled', status: 409 };
        }
        if (op.seller_tenant_id !== myTenantId) {
          await client.query('ROLLBACK');
          return { error: 'only_seller_can_edit', status: 403 };
        }

        // UPDATE mov_cc seller (notas).
        await client.query(`SET LOCAL app.current_tenant = ${Number(myTenantId)}`);
        await client.query(
          `UPDATE movimientos_cc SET notas = $1
             WHERE id = $2 AND tenant_id = $3`,
          [notes, op.seller_venta_id, myTenantId]
        );

        // UPDATE proveedor_mov buyer (notas).
        const buyerTenantId = op.buyer_tenant_id;
        await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
        await client.query(
          `UPDATE proveedor_movimientos SET notas = $1
             WHERE id = $2 AND tenant_id = $3`,
          [notes, op.buyer_compra_id, buyerTenantId]
        );

        // UPDATE last_modified.
        await client.query(
          `UPDATE cross_tenant_operations SET
              last_modified_by_user_id = $1,
              last_modified_at = NOW(),
              updated_at = NOW()
            WHERE id = $2`,
          [userId, opId]
        );

        // Notif al buyer.
        const sellerTenantQ = await client.query(
          `SELECT id, nombre, slug, plan FROM tenants WHERE id = $1`,
          [myTenantId]
        );
        await notify(
          client,
          buyerTenantId,
          'operation_modified',
          {
            partner: tenantSnapshot(sellerTenantQ.rows[0]),
            operation_id: opId,
            changed_fields: ['notes'],
            modified_by_user_id: userId,
          },
          { partnershipId: op.partnership_id, operationId: opId }
        );

        await client.query('COMMIT');
        return { ok: true, opId, buyerTenantId };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });

    if (result.error) {
      return res.status(result.status).json({
        error: errorMessage(result.error),
        reason: result.error,
      });
    }

    return res.json({ ok: true, operation_id: opId, notes });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Helper: mapping interno reason → mensaje user-friendly.
// ──────────────────────────────────────────────────────────────────────────
function errorMessage(reason) {
  const map = {
    not_found:                'Operación no encontrada.',
    partnership_not_active:   'La partnership con ese partner no está activa.',
    caller_not_in_partnership:'No participás de esa partnership.',
    seller_suspended:         'Tu tenant está suspendido.',
    buyer_suspended:          'El tenant del partner está suspendido.',
    seller_expired:           'Tu suscripción está vencida — no podés crear operaciones cross-tenant.',
    buyer_expired:            'La suscripción del partner está vencida.',
    producto_not_found:       'Alguno de los productos no existe o fue eliminado.',
    stock_insufficient:       'No hay stock suficiente para uno o más productos.',
    total_usd_mismatch:       'El total USD no coincide con la suma de los items.',
    already_cancelled:        'Esta operación ya está cancelada.',
    only_seller_can_cancel:   'Solo el seller puede cancelar la operación.',
    only_seller_can_edit:     'Solo el seller puede editar la operación.',
  };
  return map[reason] || 'Acción inválida.';
}

module.exports = router;

/**
 * Red B2B — productos pending review (F2 #455).
 *
 * Endpoints bajo /api/red-b2b/productos-pending-review. Diseño completo en
 * docs/design/red-b2b-cross-tenant.md sección 5.4 + 4.2.
 *
 * Flujo (lado buyer):
 *   F3 dispara auto-create de productos cuando recibe una venta cross-tenant
 *   (todavía no implementado — F2 solo agrega los endpoints buyer-side). Los
 *   productos auto-creados quedan con `pending_cross_tenant_review=true` +
 *   `created_from_cross_tenant_op_id` apuntando a la op. El buyer va a la
 *   pantalla "Pendientes de revisión" y decide:
 *     · Confirm-new → es un producto realmente nuevo en su catálogo →
 *       limpiamos el flag.
 *     · Merge-into  → ya tiene un producto equivalente → migramos stock +
 *       referencias al target, soft-delete del source.
 *
 * Endpoints:
 *   GET    /                       → lista mis pendientes con datos del partner
 *   POST   /:id/confirm-new        → clearea el flag
 *   POST   /:id/merge-into         → mergea source en target_producto_id
 *
 * Multi-tenant:
 *   Todas las operaciones son SOBRE productos del propio tenant del caller.
 *   Usamos `db.withTenant` (NOSUPERUSER + RLS estándar) — NO adminQuery. El
 *   producto tiene RLS por tenant_id, así que el WHERE id=$1 ya filtra
 *   implícitamente por tenant; agregamos un belt-and-suspenders inline.
 *
 *   El JOIN cross-tenant para hidratar el `partner` (seller_tenant_id de la
 *   cross_tenant_operation) sí necesita BYPASSRLS — tenants ajenos están
 *   RLS-blocked. Lo hacemos en una segunda query con adminQuery (igual que
 *   partnerships.js hidrata el partner).
 *
 * Audit:
 *   confirm-new y merge-into escriben a audit_logs con la acción
 *   correspondiente. Notification al "partner" original NO se crea acá —
 *   F5 decide si merece notif al seller que sepa que el buyer confirmó/
 *   mergeó el producto. Por ahora solo el audit del buyer.
 *
 * Cache invalidation:
 *   El merge-into mueve stock entre productos → invalidamos `inventarioCache`
 *   por tenant. confirm-new solo flippa el flag y NO toca stock — sin
 *   invalidación necesaria.
 */

const router = require('express').Router();
const db = require('../../config/database');
const logger = require('../../lib/logger');
const validate = require('../../lib/validate');
const parseId = require('../../lib/parseId');
const audit = require('../../lib/audit');
const { invalidateMetricas } = require('../../lib/inventarioCache');
const { mergeIntoSchema } = require('../../schemas/redB2b');

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/productos-pending-review
//
// Lista los productos del tenant actual con pending_cross_tenant_review=true.
// Devuelve datos del partner (seller_tenant_id de la cross_tenant_operation
// que originó el producto) para que el buyer sepa "esto vino de tal partner".
//
// Si `created_from_cross_tenant_op_id IS NULL` (caso defensivo si alguien
// setea el flag manualmente sin op asociada), `partner` queda como null.
// ──────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  const myTenantId = req.tenantId;
  try {
    // 1. Listar productos del tenant con el flag activo.
    const productos = await db.withTenant(myTenantId, async (client) => {
      const q = await client.query(
        `SELECT
           id,
           nombre,
           observaciones AS descripcion,
           imei AS sku,
           NULL::text AS codigo_interno,
           precio_venta AS precio,
           costo,
           cantidad AS stock,
           created_from_cross_tenant_op_id,
           created_at
           FROM productos
          WHERE tenant_id = $1
            AND pending_cross_tenant_review = true
            AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 500`,
        [myTenantId]
      );
      return q.rows;
    });

    // 2. Hidratar el partner (seller del lado origen) usando adminQuery.
    // Una sola query con UNNEST para todos los op_ids únicos.
    const opIds = [...new Set(productos.map((p) => p.created_from_cross_tenant_op_id).filter(Boolean))];
    let partnerByOpId = new Map();
    if (opIds.length > 0) {
      await db.adminQuery(async (client) => {
        // Lookup ops + tenants en un solo JOIN.
        const q = await client.query(
          `SELECT o.id AS op_id, t.id AS partner_id, t.nombre AS partner_nombre, t.slug AS partner_slug
             FROM cross_tenant_operations o
             JOIN tenants t ON t.id = o.seller_tenant_id
            WHERE o.id = ANY($1::bigint[])`,
          [opIds]
        );
        partnerByOpId = new Map(
          q.rows.map((r) => [
            String(r.op_id),
            { id: r.partner_id, nombre: r.partner_nombre, slug: r.partner_slug },
          ])
        );
      });
    }

    return res.json({
      pendientes: productos.map((p) => ({
        id: p.id,
        nombre: p.nombre,
        descripcion: p.descripcion,
        sku: p.sku,
        codigo_interno: p.codigo_interno,
        precio: p.precio,
        costo: p.costo,
        stock: p.stock,
        created_from_cross_tenant_op_id: p.created_from_cross_tenant_op_id,
        created_at: p.created_at,
        partner: p.created_from_cross_tenant_op_id
          ? partnerByOpId.get(String(p.created_from_cross_tenant_op_id)) || null
          : null,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/productos-pending-review/:id/confirm-new
//
// Confirma el producto auto-creado como nuevo. UPDATE flag → false.
//
// Validaciones (inline):
//   - producto pertenece al tenant del caller (RLS + WHERE explícito)
//   - producto NO soft-deleted (deleted_at IS NULL)
//   - producto está en pending_review=true (sino → 409 already_confirmed)
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/confirm-new', async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const productoId = parseId(req.params.id);
  if (!productoId) return res.status(400).json({ error: 'id inválido' });

  try {
    const result = await db.withTenant(myTenantId, async (client) => {
      await client.query('BEGIN');
      try {
        // Lookup + autoridad. El RLS + WHERE filtra por tenant; chequeamos
        // estado para distinguir 404 (no existe / no es mío) de 409 (existe
        // pero ya estaba confirmed).
        const lookup = await client.query(
          `SELECT id, pending_cross_tenant_review, deleted_at
             FROM productos
            WHERE id = $1 AND tenant_id = $2`,
          [productoId, myTenantId]
        );
        const prod = lookup.rows[0];

        if (!prod || prod.deleted_at) {
          await client.query('ROLLBACK');
          return { error: 'not_found', status: 404 };
        }
        if (!prod.pending_cross_tenant_review) {
          await client.query('ROLLBACK');
          return { error: 'already_confirmed', status: 409 };
        }

        // UPDATE flag.
        const upd = await client.query(
          `UPDATE productos
              SET pending_cross_tenant_review = false
            WHERE id = $1 AND tenant_id = $2 AND pending_cross_tenant_review = true
            RETURNING *`,
          [productoId, myTenantId]
        );
        const updated = upd.rows[0];
        if (!updated) {
          // Race: alguien lo mergeo/confirmó en paralelo.
          await client.query('ROLLBACK');
          return { error: 'race_condition', status: 409 };
        }

        // Audit dentro de la tx (preserva consistencia + SAVEPOINT pattern
        // protege el INSERT del audit si fallara internamente).
        await audit(client, 'productos', 'UPDATE', updated.id, {
          antes:   { pending_cross_tenant_review: true },
          despues: { pending_cross_tenant_review: false, _origen: 'red_b2b_confirm_new' },
          user_id: userId,
          req,
        });

        await client.query('COMMIT');
        return { ok: true, producto: updated };
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

    logger.info(
      { tenant_id: myTenantId, user_id: userId, producto_id: productoId },
      '[red-b2b] producto pending confirmado como nuevo'
    );
    return res.json({ ok: true, producto: projectProducto(result.producto) });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/productos-pending-review/:id/merge-into
//
// Mergea el producto pending (source) en un producto existente del catálogo
// (target). Suma stock, migra referencias en venta_items/canjes/envio_items/
// items_movimiento_cc, soft-deletes el source.
//
// Body: { target_producto_id }
//
// Validaciones:
//   - source pertenece al tenant + pending_review=true + no deleted
//   - target pertenece al tenant + no es el mismo que source + no deleted
//
// Stock migration:
//   target.cantidad += source.cantidad. El source queda soft-deleted con
//   cantidad intacta (preserva audit). Si el seller en F3 envía otra venta
//   del mismo producto en el futuro, va a generar OTRO pending — el buyer
//   tendrá que mergear de nuevo. (En F4+ podríamos auto-detectar matches
//   por código/EAN — diferido por diseño, ver doc).
//
// Referencias migradas:
//   producto_historial NO existe en el repo (revisé migrations). Las tablas
//   con FK productos(id) son: venta_items, canjes, envio_items,
//   items_movimiento_cc. Para un producto pending recién auto-creado, todas
//   estas referencias serán 0 — el producto NUNCA participó de una venta
//   real del buyer (solo fue receptor de la compra cross-tenant). Aún así
//   migramos defensivo: si en el futuro F3.5 permite que el buyer venda el
//   pending antes de mergearlo, la migración deja todo consistente.
//
//   proveedor_movimiento_items NO tiene FK a productos(id) — guarda
//   producto como TEXT (campo legacy). Sin migración.
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/merge-into', validate(mergeIntoSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const sourceId = parseId(req.params.id);
  if (!sourceId) return res.status(400).json({ error: 'id inválido' });

  const { target_producto_id: targetId } = req.body;

  if (sourceId === targetId) {
    return res.status(400).json({
      error: errorMessage('source_equals_target'),
      reason: 'source_equals_target',
    });
  }

  try {
    const result = await db.withTenant(myTenantId, async (client) => {
      await client.query('BEGIN');
      try {
        // 1. Lookup source — debe ser pending + del tenant + no deleted.
        const srcQ = await client.query(
          `SELECT id, nombre, cantidad, pending_cross_tenant_review, deleted_at
             FROM productos
            WHERE id = $1 AND tenant_id = $2`,
          [sourceId, myTenantId]
        );
        const source = srcQ.rows[0];
        if (!source || source.deleted_at) {
          await client.query('ROLLBACK');
          return { error: 'source_not_found', status: 404 };
        }
        if (!source.pending_cross_tenant_review) {
          await client.query('ROLLBACK');
          return { error: 'source_not_pending', status: 409 };
        }

        // 2. Lookup target — debe ser del tenant + no deleted. NO chequeamos
        // pending_review en target (típicamente target es un producto normal
        // del catálogo, no pending).
        const tgtQ = await client.query(
          `SELECT id, nombre, cantidad, deleted_at
             FROM productos
            WHERE id = $1 AND tenant_id = $2`,
          [targetId, myTenantId]
        );
        const target = tgtQ.rows[0];
        if (!target) {
          await client.query('ROLLBACK');
          return { error: 'target_not_found', status: 404 };
        }
        if (target.deleted_at) {
          await client.query('ROLLBACK');
          return { error: 'target_deleted', status: 400 };
        }

        // 3. Sumar stock al target. UPDATE atómico — si en paralelo otra tx
        // modifica el stock del target, esta query no se pisa con ella
        // (Postgres row-level lock via UPDATE).
        const stockAdded = source.cantidad || 0;
        await client.query(
          `UPDATE productos
              SET cantidad = cantidad + $1
            WHERE id = $2 AND tenant_id = $3`,
          [stockAdded, targetId, myTenantId]
        );

        // 4. Migrar referencias. Las tablas con FK productos(id):
        //   - venta_items.producto_id
        //   - canjes.producto_id
        //   - envio_items.producto_id
        //   - items_movimiento_cc.producto_id
        // Todas son ON DELETE SET NULL, pero acá hacemos UPDATE explícito
        // para preservar la referencia post-merge (sino el soft-delete del
        // source las dejaría apuntando a un producto deleted).
        //
        // Para un producto pending recién auto-creado, todas estas
        // referencias son típicamente 0 — el producto NUNCA fue vendido. La
        // migración es defensiva para el caso edge donde el buyer vendió el
        // pending antes de mergear (F3.5+ podría permitirlo).
        await client.query(
          `UPDATE venta_items SET producto_id = $1 WHERE producto_id = $2`,
          [targetId, sourceId]
        );
        await client.query(
          `UPDATE canjes SET producto_id = $1 WHERE producto_id = $2`,
          [targetId, sourceId]
        );
        await client.query(
          `UPDATE envio_items SET producto_id = $1 WHERE producto_id = $2`,
          [targetId, sourceId]
        );
        await client.query(
          `UPDATE items_movimiento_cc SET producto_id = $1 WHERE producto_id = $2`,
          [targetId, sourceId]
        );

        // 5. Soft-delete source.
        await client.query(
          `UPDATE productos SET deleted_at = NOW() WHERE id = $1 AND tenant_id = $2`,
          [sourceId, myTenantId]
        );

        // 6. Re-leer target post-update para devolverlo en la response.
        const updatedTargetQ = await client.query(
          `SELECT * FROM productos WHERE id = $1 AND tenant_id = $2`,
          [targetId, myTenantId]
        );
        const updatedTarget = updatedTargetQ.rows[0];

        // 7. Audit. Dos entradas (UPDATE target + UPDATE source) — la pareja
        // permite reconstruir el merge en forensics.
        await audit(client, 'productos', 'UPDATE', targetId, {
          antes:   { cantidad: target.cantidad },
          despues: { cantidad: updatedTarget.cantidad, _origen: 'red_b2b_merge_into', stock_added: stockAdded, merged_from_producto_id: sourceId },
          user_id: userId,
          req,
        });
        await audit(client, 'productos', 'DELETE', sourceId, {
          antes:   { nombre: source.nombre, cantidad: source.cantidad, pending_cross_tenant_review: true },
          despues: { _origen: 'red_b2b_merge_into', merged_into_producto_id: targetId },
          user_id: userId,
          req,
        });

        await client.query('COMMIT');
        return { ok: true, target: updatedTarget, stockAdded };
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

    // Invalidar cache de inventario — el stock cambió.
    invalidateMetricas(myTenantId).catch(() => { /* best-effort */ });

    logger.info(
      {
        tenant_id: myTenantId,
        user_id: userId,
        source_producto_id: sourceId,
        target_producto_id: targetId,
        stock_added: result.stockAdded,
      },
      '[red-b2b] producto pending mergeado en existente'
    );

    return res.json({
      ok: true,
      target_producto: projectProducto(result.target),
      stock_added: result.stockAdded,
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function projectProducto(p) {
  if (!p) return null;
  return {
    id: p.id,
    nombre: p.nombre,
    descripcion: p.observaciones || null,
    sku: p.imei || null,
    precio: p.precio_venta,
    costo: p.costo,
    stock: p.cantidad,
    pending_cross_tenant_review: p.pending_cross_tenant_review,
    created_from_cross_tenant_op_id: p.created_from_cross_tenant_op_id,
  };
}

function errorMessage(reason) {
  const map = {
    not_found:              'Producto no encontrado.',
    already_confirmed:      'Este producto ya estaba confirmado (no estaba pendiente de revisión).',
    race_condition:         'El producto cambió de estado mientras procesábamos. Reintentá.',
    source_not_found:       'Producto a mergear no encontrado.',
    source_not_pending:     'El producto fuente ya no está pendiente de revisión.',
    target_not_found:       'Producto destino no encontrado o no pertenece a tu tenant.',
    target_deleted:         'No podés mergear sobre un producto eliminado.',
    source_equals_target:   'El producto destino debe ser distinto del producto a mergear.',
  };
  return map[reason] || 'Acción inválida.';
}

module.exports = router;

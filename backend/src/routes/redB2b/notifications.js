/**
 * Red B2B — inbox de notificaciones cross-tenant (F5 #458).
 *
 * Endpoints bajo /api/red-b2b/notifications:
 *
 *   GET  /                       → lista paginada (created_at DESC)
 *   GET  /count-unread           → { count: N } — endpoint dedicado para
 *                                  el bell counter (lightweight, sin payload)
 *   POST /:id/read               → marca una como leída (idempotente)
 *   POST /read-all               → marca todas las unread del tenant
 *
 * Auth: requireAuth + requireCapability('cross_tenant.write') (gateado al
 * mount en app.js). Todos los endpoints son READ/UPDATE sobre el propio
 * tenant del caller, así que usan `db.withTenant()` (no `adminQuery`) —
 * la RLS estándar de cross_tenant_notifications (tenant_id = current_tenant)
 * filtra automáticamente y previene leaks por construcción.
 *
 * Decisiones durables:
 *   - `count-unread` separado del listado: el bell del topbar polea cada 60s
 *     este endpoint. Devolver solo el número (no las filas + payloads) es
 *     significativamente más barato a escala (1000+ tenants polling). Index
 *     parcial `idx_cross_notif_unread` matchea la query del COUNT.
 *   - `:id/read` idempotente: si ya estaba leída, `UPDATE ... WHERE
 *     read_at IS NULL` no actualiza filas → respondemos 200 ok igual (el
 *     caller no necesita lógica especial). Lo mismo para id inexistente
 *     bajo este tenant — devolvemos 200 (no leak de si existe en otro
 *     tenant). Compromiso: no devolvemos 404 para evitar enumeration leaks
 *     entre tenants vía error code probing.
 *   - `read-all`: UPDATE bulk con `read_at IS NULL` filter. Aprovecha el
 *     index parcial. RLS scope al tenant automatic.
 *   - GET `/` filtros: `unread=true` (bool), `type` (whitelist), `limit`
 *     (1-100, default 50). Sin paginación cursor — para inbox de Red B2B
 *     50 últimas alcanza al 99% de los casos. Si crece, agregamos `before`
 *     cursor en F6.
 */

const router = require('express').Router();
const db = require('../../config/database');
const logger = require('../../lib/logger');
const parseId = require('../../lib/parseId');

// Whitelist de tipos válidos en el filtro `?type=...`. Matchea el CHECK de
// la tabla (migration F1 20260627000001). Si agregás un tipo nuevo en una
// migration futura, también agregalo acá.
const VALID_TYPES = new Set([
  'invitation_received',
  'invitation_accepted',
  'invitation_rejected',
  'partnership_revoked',
  'operation_received',
  'operation_modified',
  'operation_cancelled',
  'payment_received',
  'payment_registered',
  'product_pending_review',
]);

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/notifications
//
// Query:
//   ?unread=true       → solo unread (default: incluye leídas)
//   ?type=<one of>     → filtra por type
//   ?limit=N           → 1..100, default 50
//
// Response:
//   { notifications: [{ id, type, payload, partnership_id, cross_tenant_operation_id, read_at, created_at }], total_returned }
// ──────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  const myTenantId = req.tenantId;
  const { unread, type } = req.query;
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 100) limit = 100;
  const filterUnread = unread === 'true' || unread === '1';
  const filterType = type && VALID_TYPES.has(String(type)) ? String(type) : null;

  try {
    const data = await db.withTenant(myTenantId, async (client) => {
      const where = [`tenant_id = ${Number(myTenantId)}`];
      const params = [];
      if (filterUnread) where.push(`read_at IS NULL`);
      if (filterType) {
        params.push(filterType);
        where.push(`type = $${params.length}`);
      }
      const whereSql = `WHERE ${where.join(' AND ')}`;

      params.push(limit);
      const q = await client.query(
        `SELECT id, type, payload, partnership_id, cross_tenant_operation_id,
                read_at, created_at
           FROM cross_tenant_notifications
           ${whereSql}
           ORDER BY created_at DESC
           LIMIT $${params.length}`,
        params
      );
      return q.rows;
    });

    return res.json({
      notifications: data.map((n) => ({
        id:                          Number(n.id),
        type:                        n.type,
        payload:                     n.payload,
        partnership_id:              n.partnership_id ? Number(n.partnership_id) : null,
        cross_tenant_operation_id:   n.cross_tenant_operation_id ? Number(n.cross_tenant_operation_id) : null,
        read_at:                     n.read_at,
        created_at:                  n.created_at,
      })),
      total_returned: data.length,
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/notifications/count-unread
//
// Dedicado al bell counter — devuelve solo `{ count: N }`. Mucho más barato
// que GET / cuando el polling es continuo (cada 60s desde el frontend).
// Index parcial `idx_cross_notif_unread` cubre exactamente este WHERE.
// ──────────────────────────────────────────────────────────────────────────
router.get('/count-unread', async (req, res, next) => {
  const myTenantId = req.tenantId;
  try {
    const count = await db.withTenant(myTenantId, async (client) => {
      const q = await client.query(
        `SELECT COUNT(*)::int AS n
           FROM cross_tenant_notifications
           WHERE tenant_id = $1 AND read_at IS NULL`,
        [myTenantId]
      );
      return q.rows[0]?.n || 0;
    });
    return res.json({ count });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/notifications/:id/read
//
// Marca una notif como leída. Idempotente:
//   - Si ya estaba leída → 200 ok sin cambios.
//   - Si no existe (o pertenece a otro tenant — RLS la oculta) → 200 ok
//     (NO 404 para evitar enumeration leak entre tenants).
//
// El UPDATE solo cambia read_at si era NULL — no pisamos read_at preexistente.
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/read', async (req, res, next) => {
  const myTenantId = req.tenantId;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });

  try {
    const result = await db.withTenant(myTenantId, async (client) => {
      const q = await client.query(
        `UPDATE cross_tenant_notifications
            SET read_at = NOW()
          WHERE id = $1
            AND tenant_id = $2
            AND read_at IS NULL
          RETURNING id, read_at`,
        [id, myTenantId]
      );
      return q.rows[0] || null;
    });
    // Idempotente: si no hubo update (ya leída o no existe), devolvemos ok.
    if (result) {
      return res.json({ ok: true, id: Number(result.id), read_at: result.read_at });
    }
    return res.json({ ok: true, id, read_at: null, idempotent: true });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/notifications/read-all
//
// Marca todas las unread del tenant como leídas. UPDATE bulk con WHERE
// parcial sobre el index `idx_cross_notif_unread`. Devuelve el count
// actualizado para el frontend (poder hacer optimistic update del bell).
// ──────────────────────────────────────────────────────────────────────────
router.post('/read-all', async (req, res, next) => {
  const myTenantId = req.tenantId;
  try {
    const updated = await db.withTenant(myTenantId, async (client) => {
      const q = await client.query(
        `UPDATE cross_tenant_notifications
            SET read_at = NOW()
          WHERE tenant_id = $1
            AND read_at IS NULL`,
        [myTenantId]
      );
      return q.rowCount;
    });
    logger.info(
      { tenant_id: myTenantId, user_id: req.user?.id, updated },
      '[red-b2b/F5] read-all notifications'
    );
    return res.json({ ok: true, updated });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

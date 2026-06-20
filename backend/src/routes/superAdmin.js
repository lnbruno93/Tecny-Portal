/**
 * Super-Admin routes — para la app admin.tecnyapp.com (#353 Fase 1).
 *
 * IMPORTANTE — distinción vs `/api/admin/*`:
 *   - `/api/admin/*` (routes/admin.js): operaciones admin DENTRO de un tenant
 *     (backfill cajas, run invariantes, etc). Tenant-scoped, RLS aplica.
 *     Protegido por `adminOnly` (role === 'admin' del user dentro del tenant).
 *   - `/api/super-admin/*` (este módulo): operaciones SUPER-ADMIN CROSS-TENANT
 *     (listar todos los tenants, gestionar planes, ver métricas SaaS). BYPASSRLS
 *     vía pool admin separado. Protegido por `requireSuperAdmin`
 *     (is_super_admin === true en users, gestionado vía script — NO API).
 *
 * Endpoints (Fase 1):
 *   GET /api/super-admin/me                — ping de verificación
 *   GET /api/super-admin/tenants           — lista tenants con stats inline
 *   GET /api/super-admin/tenants/:id       — detalle de un tenant
 *
 * Endpoints futuros (Fase 2):
 *   PATCH /api/super-admin/tenants/:id     — mutate (plan, suspend, etc)
 *   POST  /api/super-admin/tenants/:id/extend-trial
 *   POST  /api/super-admin/tenants/:id/suspend
 *   POST  /api/super-admin/tenants/:id/reactivate
 *   GET   /api/super-admin/tenants/:id/activity
 *   GET   /api/super-admin/metrics
 *   GET   /api/super-admin/metrics/history
 *
 * Diseño:
 *   - TODAS las queries pasan por `db.adminQuery()` (BYPASSRLS). El linter
 *     de CI debería rechazar `db.query` o `db.withTenant` en este archivo.
 *   - Validamos `parseInt(req.params.id)` defensivamente — los params vienen
 *     del path y no pasan por validate().
 *   - Responses incluyen MRR calculado via `getTenantMrr` de planPricing.js.
 *     Mientras los precios estén en placeholders 0, el MRR del dashboard
 *     muestra 0 — sirve la estructura, los números se llenan después.
 */

const router = require('express').Router();
const db = require('../config/database');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const { getTenantMrr } = require('../lib/planPricing');
const parseId = require('../lib/parseId');

// Todos los endpoints de este módulo requieren super-admin.
router.use(requireSuperAdmin);

// ──────────────────────────────────────────────────────────────────────────
// GET /me — ping de verificación
//
// El admin frontend lo llama al boot para confirmar que el JWT abre el admin
// app. Si responde 200, el frontend mantiene la sesión; si 403, redirige a
// login (no es super-admin). Devuelve datos mínimos — el admin no necesita
// más info de sí mismo (el JWT ya tiene username/email).
// ──────────────────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  res.json({
    is_super_admin: true,
    user_id: req.user.id,
    username: req.user.username,
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /tenants — lista con stats inline
//
// Devuelve TODOS los tenants (excluidos soft-deleted) con stats agregadas
// necesarias para la tabla del dashboard. Optimizada en una sola query con
// subqueries correlacionadas + LATERAL — más rápido que N+1 desde Node.
//
// Filtros opcionales (query string):
//   ?plan=trial|starter|pro|enterprise — filtra por plan exacto
//   ?suspended=true|false              — solo activos o solo suspendidos
//   ?search=texto                       — match en nombre OR slug (ILIKE)
//
// No paginamos en Fase 1 — esperamos < 100 tenants en el primer año. Cuando
// crezca, agregamos LIMIT/OFFSET + count total.
// ──────────────────────────────────────────────────────────────────────────
router.get('/tenants', async (req, res, next) => {
  try {
    const { plan, suspended, search } = req.query;
    const where = ['t.deleted_at IS NULL'];
    const params = [];

    if (plan && ['trial', 'starter', 'pro', 'enterprise'].includes(String(plan))) {
      params.push(plan);
      where.push(`t.plan = $${params.length}`);
    }
    if (suspended === 'true') where.push('t.suspended_at IS NOT NULL');
    if (suspended === 'false') where.push('t.suspended_at IS NULL');
    if (search && typeof search === 'string' && search.trim().length > 0) {
      params.push(`%${search.trim()}%`);
      where.push(`(t.nombre ILIKE $${params.length} OR t.slug ILIKE $${params.length})`);
    }

    const rows = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT
           t.id,
           t.nombre,
           t.slug,
           t.plan,
           t.custom_mrr_usd,
           t.suspended_at,
           t.suspended_reason,
           t.trial_until,
           t.created_at,
           t.notes,
           -- # de users del tenant (vía tenant_users)
           (SELECT COUNT(*)::int FROM tenant_users tu WHERE tu.tenant_id = t.id) AS users_count,
           -- Última actividad real del tenant: ahora MAX(created_at) de ventas.
           -- Lo refinamos en Fase 2 con un "last_activity_at" denormalizado
           -- si se vuelve un cuello de botella (hoy es ~50 tenants × 1 query).
           (SELECT MAX(created_at) FROM ventas v
              WHERE v.tenant_id = t.id AND v.deleted_at IS NULL) AS last_venta_at,
           -- Signups (nuevos users) últimos 30 días.
           (SELECT COUNT(*)::int FROM users u
             INNER JOIN tenant_users tu ON tu.user_id = u.id
             WHERE tu.tenant_id = t.id
               AND u.created_at >= NOW() - INTERVAL '30 days') AS signups_30d
         FROM tenants t
         WHERE ${where.join(' AND ')}
         ORDER BY t.created_at DESC`,
        params
      );
      return rows;
    });

    // Calcular MRR per-tenant en Node (la fórmula vive en planPricing.js).
    res.json(rows.map((t) => ({
      ...t,
      mrr_usd: getTenantMrr(t.plan, t.custom_mrr_usd),
    })));
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /tenants/:id — detalle de un tenant
//
// Devuelve datos completos del tenant + últimas 10 acciones admin
// (de tenant_admin_actions) para el panel de auditoría.
// ──────────────────────────────────────────────────────────────────────────
router.get('/tenants/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    // parseId devuelve NaN (no null) si el input no es entero positivo.
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }

    const result = await db.adminQuery(async (client) => {
      const tenantRow = await client.query(
        `SELECT t.*,
                (SELECT COUNT(*)::int FROM tenant_users tu WHERE tu.tenant_id = t.id) AS users_count,
                (SELECT MAX(created_at) FROM ventas v
                   WHERE v.tenant_id = t.id AND v.deleted_at IS NULL) AS last_venta_at,
                (SELECT COUNT(*)::int FROM users u
                   INNER JOIN tenant_users tu ON tu.user_id = u.id
                   WHERE tu.tenant_id = t.id
                     AND u.created_at >= NOW() - INTERVAL '30 days') AS signups_30d
           FROM tenants t
          WHERE t.id = $1 AND t.deleted_at IS NULL`,
        [id]
      );
      if (!tenantRow.rows[0]) return null;

      const actionsRow = await client.query(
        `SELECT taa.id, taa.action, taa.before_state, taa.after_state,
                taa.reason, taa.created_at,
                u.username AS super_admin_username
           FROM tenant_admin_actions taa
           LEFT JOIN users u ON u.id = taa.super_admin_user_id
          WHERE taa.tenant_id = $1
          ORDER BY taa.created_at DESC
          LIMIT 10`,
        [id]
      );

      return { tenant: tenantRow.rows[0], recent_admin_actions: actionsRow.rows };
    });

    if (!result) return res.status(404).json({ error: 'Tenant no encontrado' });

    res.json({
      ...result.tenant,
      mrr_usd: getTenantMrr(result.tenant.plan, result.tenant.custom_mrr_usd),
      recent_admin_actions: result.recent_admin_actions,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

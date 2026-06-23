/**
 * Super-Admin routes — para la app admin.tecnyapp.com (#353 Fases 1+2).
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
 * Endpoints:
 *   GET   /api/super-admin/me                       — ping de verificación
 *   GET   /api/super-admin/tenants                  — lista con stats inline
 *   GET   /api/super-admin/tenants/:id              — detalle del tenant
 *   PATCH /api/super-admin/tenants/:id              — mutate atómico c/ audit
 *   POST  /api/super-admin/tenants/:id/extend-trial — extiende trial N días
 *   POST  /api/super-admin/tenants/:id/suspend      — suspende (reason req.)
 *   POST  /api/super-admin/tenants/:id/reactivate   — reactiva
 *   GET   /api/super-admin/tenants/:id/activity     — drill-down per tipo
 *   GET   /api/super-admin/metrics                  — KPIs SaaS agregados
 *   GET   /api/super-admin/metrics/history          — serie temporal 90d
 *   GET   /api/super-admin/metrics/recent-actions   — feed cross-tenant de
 *                                                     acciones admin (para el
 *                                                     Resumen del dashboard)
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
const validate = require('../lib/validate');
const {
  getTenantMrr,
  PLAN_PRICES_USD,
  getPlanPrices,
  refreshCache: refreshPlanPricesCache,
} = require('../lib/planPricing');
const parseId = require('../lib/parseId');
const {
  patchTenantSchema,
  extendTrialSchema,
  suspendTenantSchema,
  reactivateTenantSchema,
  patchPlanPriceSchema,
  PLANES,
} = require('../schemas/superAdmin');
const logger = require('../lib/logger');

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
// Devuelve tenants paginados (excluidos soft-deleted) con stats agregadas
// necesarias para la tabla del dashboard. Optimizada en una sola query con
// subqueries correlacionadas + LATERAL — más rápido que N+1 desde Node.
//
// Filtros opcionales (query string):
//   ?plan=trial|starter|pro|enterprise — filtra por plan exacto
//   ?suspended=true|false              — solo activos o solo suspendidos
//   ?search=texto                       — match en nombre OR slug (ILIKE)
//
// Paginación + sort (PERF-2 audit 2026-06-22):
//   ?limit=N       — default 50, max 200. Limita filas devueltas.
//   ?offset=N      — default 0. Para paginación tipo "siguiente página".
//   ?sort=col:dir  — default 'created_at:desc'. Whitelist:
//                       col ∈ {created_at, nombre, plan, plan_order}
//                       dir ∈ {asc, desc}
//                    plan_order es alias para mantener trial → starter → pro
//                    → enterprise estable; útil cuando el operador agrupa.
//
// Response shape: { tenants: [...], total: N, limit, offset }.
// (Cambio desde array crudo — Fase 1 esperaba <100 tenants y no paginaba.
// Frontends actualizados para consumir desde `.tenants`.)
// ──────────────────────────────────────────────────────────────────────────
const SORT_COLUMNS = {
  created_at: 't.created_at',
  nombre:     't.nombre',
  plan:       't.plan',
  // Para "ordenar por plan" con orden lógico (no alfabético: enterprise va
  // último, no primero). CASE inline para no agregar una columna calculada.
  plan_order: `CASE t.plan
    WHEN 'trial' THEN 1
    WHEN 'starter' THEN 2
    WHEN 'pro' THEN 3
    WHEN 'enterprise' THEN 4
    ELSE 5 END`,
};
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function parseSort(raw) {
  // Parser defensivo. Default: created_at desc (más reciente primero).
  if (typeof raw !== 'string' || !raw.trim()) {
    return { sql: 't.created_at DESC', col: 'created_at', dir: 'desc' };
  }
  const [colRaw, dirRaw] = raw.split(':');
  const col = SORT_COLUMNS[colRaw] ? colRaw : 'created_at';
  const dir = dirRaw === 'asc' ? 'ASC' : 'DESC';
  return { sql: `${SORT_COLUMNS[col]} ${dir}`, col, dir: dir.toLowerCase() };
}

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

    // Pagination guards: clamp a [0, MAX_LIMIT] y [0, ∞). offset negativo
    // o NaN → 0; limit fuera de rango → DEFAULT_LIMIT.
    const limitRaw = Number(req.query.limit);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= MAX_LIMIT
      ? limitRaw : DEFAULT_LIMIT;
    const offsetRaw = Number(req.query.offset);
    const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const sort = parseSort(req.query.sort);

    const result = await db.adminQuery(async (client) => {
      // COUNT separado del SELECT principal: necesario para que el frontend
      // muestre "X de Y" y pueda calcular páginas totales. Misma WHERE clause
      // para que sea consistente con el SELECT.
      const countQ = await client.query(
        `SELECT COUNT(*)::int AS total
           FROM tenants t
          WHERE ${where.join(' AND ')}`,
        params
      );
      const total = countQ.rows[0]?.total ?? 0;

      // SELECT principal con LIMIT/OFFSET. Los placeholders de limit/offset
      // van AL FINAL del array params para no romper el numerado anterior.
      const limitParam = params.length + 1;
      const offsetParam = params.length + 2;
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
         ORDER BY ${sort.sql}
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        [...params, limit, offset]
      );
      return { rows, total };
    });

    res.json({
      // Calcular MRR per-tenant en Node (la fórmula vive en planPricing.js).
      tenants: result.rows.map((t) => ({
        ...t,
        mrr_usd: getTenantMrr(t.plan, t.custom_mrr_usd),
      })),
      total: result.total,
      limit,
      offset,
      sort: { col: sort.col, dir: sort.dir },
    });
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

// ──────────────────────────────────────────────────────────────────────────
// Helper interno — escribe a tenant_admin_actions dentro de la tx admin.
//
// Recibe el `client` ya en tx (BEGIN ejecutado). Espera before/after como
// objects JSON-serializables. No throws (deja al caller manejar el error si
// la query falla — pero realísticamente si esto falla, el commit también).
// ──────────────────────────────────────────────────────────────────────────
async function insertAdminAction(client, {
  tenantId,
  superAdminUserId,
  action,
  beforeState,
  afterState,
  reason,
}) {
  await client.query(
    `INSERT INTO tenant_admin_actions
       (tenant_id, super_admin_user_id, action, before_state, after_state, reason)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [
      tenantId,
      superAdminUserId,
      action,
      beforeState ? JSON.stringify(beforeState) : null,
      afterState  ? JSON.stringify(afterState)  : null,
      reason || null,
    ]
  );
}

// ──────────────────────────────────────────────────────────────────────────
// PATCH /tenants/:id — mutate genérico
//
// Permite cambiar cualquier combinación de campos admin en un solo request.
// Atomicidad: leemos estado actual + comparamos + UPDATE + audit en UNA tx.
// Sin esto, dos super-admins concurrentes podrían pisarse y el audit reflejar
// un before_state que ya no era cierto cuando se aplicó el cambio.
//
// Reglas de coherencia (más allá del Zod schema):
//   - Si plan cambia a algo != 'trial', limpiamos trial_until automáticamente.
//     Sin esto el CHECK constraint de DB rebotaría con 500 — preferimos UX
//     transparente (el cambio aplica + limpia el campo relacionado).
//   - Si plan cambia a algo != 'enterprise', limpiamos custom_mrr_usd igual.
//   - Estas auto-limpiezas se loguean en after_state también — el operador
//     ve qué se modificó.
//
// Action loggeado: el más específico que detectemos. Si el patch cambia plan
// → 'plan_change'. Si cambia notes → 'note_update'. Si cambia ambos →
// 'plan_change' tiene prioridad. Sin esto, todos los PATCH serían el genérico
// "patch" y la búsqueda de "¿qué cambios de plan hubo?" sería más difícil.
// ──────────────────────────────────────────────────────────────────────────
router.patch('/tenants/:id', validate(patchTenantSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const { reason, ...mutables } = req.body;

    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // 1. Estado actual (locked para evitar race con otros PATCHes).
        const beforeRow = await client.query(
          `SELECT plan, suspended_at, suspended_reason, trial_until,
                  custom_mrr_usd, notes
             FROM tenants
            WHERE id = $1 AND deleted_at IS NULL
            FOR UPDATE`,
          [id]
        );
        if (!beforeRow.rows[0]) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        const before = beforeRow.rows[0];

        // 2. Coherencia: limpiar campos relacionados al cambio de plan.
        const after = { ...before, ...mutables };
        if (mutables.plan !== undefined) {
          if (mutables.plan !== 'trial') after.trial_until = null;
          if (mutables.plan !== 'enterprise') after.custom_mrr_usd = null;
        }

        // 3. UPDATE solo de campos que cambiaron — generamos el SET dinámico.
        const sets = [];
        const params = [];
        for (const k of Object.keys(after)) {
          if (after[k] !== before[k]) {
            params.push(after[k]);
            sets.push(`${k} = $${params.length}`);
          }
        }
        if (sets.length === 0) {
          // No-op (el patch coincidía con el estado actual). Devolvemos
          // estado actual sin audit — no hay cambio que loggear.
          await client.query('ROLLBACK');
          return { tenant: before, noop: true };
        }
        params.push(id);
        const updateRow = await client.query(
          `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
          params
        );
        const updatedTenant = updateRow.rows[0];

        // 4. Decidir el `action` más específico.
        let action = 'note_update';
        if (mutables.plan !== undefined && mutables.plan !== before.plan) {
          action = 'plan_change';
        } else if (mutables.suspended_at !== undefined) {
          action = mutables.suspended_at ? 'suspend' : 'reactivate';
        } else if (mutables.trial_until !== undefined) {
          action = 'trial_extend';
        } else if (mutables.custom_mrr_usd !== undefined) {
          action = 'custom_mrr_update';
        }

        // 5. Audit trail.
        await insertAdminAction(client, {
          tenantId: id,
          superAdminUserId: req.user.id,
          action,
          beforeState: before,
          afterState: after,
          reason,
        });

        await client.query('COMMIT');
        return { tenant: updatedTenant };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow — error original ya se propaga */ }
        throw err;
      }
    });

    if (result.notFound) return res.status(404).json({ error: 'Tenant no encontrado' });

    logger.info(
      { tenant_id: id, super_admin: req.user.id, noop: !!result.noop },
      '[super-admin] PATCH /tenants/:id'
    );

    res.json({
      ...result.tenant,
      mrr_usd: getTenantMrr(result.tenant.plan, result.tenant.custom_mrr_usd),
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /tenants/:id/extend-trial — shortcut: trial_until += days
//
// Más cómodo que un PATCH con cálculo de fechas en el frontend. Solo
// aplica si el tenant tiene plan='trial' — sino devuelve 400 (no tiene
// sentido extender trial de un cliente pago).
// ──────────────────────────────────────────────────────────────────────────
router.post('/tenants/:id/extend-trial', validate(extendTrialSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const { days, reason } = req.body;

    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const beforeRow = await client.query(
          `SELECT plan, trial_until FROM tenants
            WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [id]
        );
        if (!beforeRow.rows[0]) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        const before = beforeRow.rows[0];
        if (before.plan !== 'trial') {
          await client.query('ROLLBACK');
          return { invalidPlan: before.plan };
        }

        // Calcular nuevo trial_until. Si era NULL, base es HOY; sino base
        // es el trial_until actual. PG hace la suma con INTERVAL.
        const updateRow = await client.query(
          `UPDATE tenants
              SET trial_until = COALESCE(trial_until, CURRENT_DATE) + ($1 || ' days')::interval
            WHERE id = $2
            RETURNING trial_until`,
          [String(days), id]
        );
        const newTrialUntil = updateRow.rows[0].trial_until;

        await insertAdminAction(client, {
          tenantId: id,
          superAdminUserId: req.user.id,
          action: 'trial_extend',
          beforeState: { trial_until: before.trial_until },
          afterState:  { trial_until: newTrialUntil, days_added: days },
          reason,
        });
        await client.query('COMMIT');
        return { trial_until: newTrialUntil };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow — error original ya se propaga */ }
        throw err;
      }
    });

    if (result.notFound) return res.status(404).json({ error: 'Tenant no encontrado' });
    if (result.invalidPlan) {
      return res.status(400).json({
        error: `No se puede extender trial: el tenant tiene plan='${result.invalidPlan}'.`,
      });
    }
    res.json({ trial_until: result.trial_until });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /tenants/:id/suspend — marca suspended_at=NOW + razón
// POST /tenants/:id/reactivate — marca suspended_at=NULL
//
// Shortcuts más legibles que PATCH genérico para acciones frecuentes.
// El frontend usa endpoints separados para botones bien diferenciados
// ("Suspender" vs "Reactivar") sin tener que armar payloads.
// ──────────────────────────────────────────────────────────────────────────
router.post('/tenants/:id/suspend', validate(suspendTenantSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const { reason } = req.body;

    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const beforeRow = await client.query(
          `SELECT suspended_at, suspended_reason FROM tenants
            WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [id]
        );
        if (!beforeRow.rows[0]) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        const before = beforeRow.rows[0];

        await client.query(
          `UPDATE tenants
              SET suspended_at = NOW(), suspended_reason = $1
            WHERE id = $2`,
          [reason, id]
        );
        await insertAdminAction(client, {
          tenantId: id,
          superAdminUserId: req.user.id,
          action: 'suspend',
          beforeState: before,
          afterState: { suspended_at: 'NOW()', suspended_reason: reason },
          reason,
        });
        await client.query('COMMIT');
        return { ok: true };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow — error original ya se propaga */ }
        throw err;
      }
    });

    if (result.notFound) return res.status(404).json({ error: 'Tenant no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/tenants/:id/reactivate', validate(reactivateTenantSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const { reason } = req.body;

    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const beforeRow = await client.query(
          `SELECT suspended_at, suspended_reason FROM tenants
            WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [id]
        );
        if (!beforeRow.rows[0]) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        const before = beforeRow.rows[0];

        await client.query(
          `UPDATE tenants
              SET suspended_at = NULL, suspended_reason = NULL
            WHERE id = $1`,
          [id]
        );
        await insertAdminAction(client, {
          tenantId: id,
          superAdminUserId: req.user.id,
          action: 'reactivate',
          beforeState: before,
          afterState: { suspended_at: null, suspended_reason: null },
          reason,
        });
        await client.query('COMMIT');
        return { ok: true };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow — error original ya se propaga */ }
        throw err;
      }
    });

    if (result.notFound) return res.status(404).json({ error: 'Tenant no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /tenants/:id/activity — drill-down de actividad del tenant
//
// Devuelve summary por type: ventas, cajas, alertas, bot, audit. El frontend
// los renderiza como tabs. Cada type tiene su shape — no buscamos un schema
// unificado, sería un mal compromiso.
//
// Cap a últimos 20 items por type (frontend pagina con scroll vertical o
// "ver más" — Fase 4 si hace falta más detalle).
// ──────────────────────────────────────────────────────────────────────────
router.get('/tenants/:id/activity', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const type = String(req.query.type || 'ventas');
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 20), 100);

    const data = await db.adminQuery(async (client) => {
      // Confirmar que el tenant existe (404 limpio si no).
      const t = await client.query(
        `SELECT 1 FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
        [id]
      );
      if (!t.rows[0]) return null;

      switch (type) {
        case 'ventas': {
          const { rows } = await client.query(
            `SELECT id, order_id, fecha, total_usd, cliente_nombre, estado, created_at
               FROM ventas
              WHERE tenant_id = $1 AND deleted_at IS NULL
              ORDER BY created_at DESC
              LIMIT $2`,
            [id, limit]
          );
          return { type, items: rows };
        }
        case 'cajas': {
          const { rows } = await client.query(
            `SELECT cm.id, cm.fecha, cm.tipo, cm.monto, cm.monto_usd,
                    cm.concepto, cm.origen, mp.nombre AS caja_nombre, mp.moneda
               FROM caja_movimientos cm
               JOIN metodos_pago mp ON mp.id = cm.caja_id
              WHERE cm.tenant_id = $1 AND cm.deleted_at IS NULL
              ORDER BY cm.fecha DESC, cm.id DESC
              LIMIT $2`,
            [id, limit]
          );
          return { type, items: rows };
        }
        case 'bot': {
          // Mensajes del bot — vista forense de uso (cuántos mensajes, qué
          // usaron). NO devolvemos el contenido completo (privacy + payload
          // grande). Solo el contador + fecha del último.
          const { rows: counts } = await client.query(
            `SELECT
               COUNT(*)::int AS mensajes_total,
               COUNT(*) FILTER (WHERE role = 'user')::int AS mensajes_user,
               MAX(created_at) AS ultimo_mensaje,
               COUNT(DISTINCT conversation_id)::int AS conversaciones
              FROM chat_messages
             WHERE tenant_id = $1`,
            [id]
          );
          const { rows: recent } = await client.query(
            `SELECT c.id AS conversation_id, c.titulo, c.created_at,
                    u.username,
                    (SELECT COUNT(*)::int FROM chat_messages m
                       WHERE m.conversation_id = c.id) AS msg_count
               FROM chat_conversations c
               JOIN users u ON u.id = c.user_id
              WHERE c.tenant_id = $1
              ORDER BY c.updated_at DESC
              LIMIT $2`,
            [id, limit]
          );
          return { type, summary: counts[0], recent_conversations: recent };
        }
        case 'alertas': {
          const { rows } = await client.query(
            `SELECT tipo, activa, parametros, updated_at
               FROM alertas_config
              WHERE tenant_id = $1
              ORDER BY tipo`,
            [id]
          );
          return { type, items: rows };
        }
        case 'audit': {
          // Últimos cambios de DATA del tenant (no del admin sobre tenant —
          // eso vive en tenant_admin_actions). Útil para forense del lado
          // del cliente: "qué movió, cuándo".
          const { rows } = await client.query(
            `SELECT id, tabla, accion, registro_id, user_id, created_at
               FROM audit_logs
              WHERE tenant_id = $1
              ORDER BY created_at DESC
              LIMIT $2`,
            [id, limit]
          );
          return { type, items: rows };
        }
        default:
          return { type, items: [], error: `type '${type}' desconocido (válidos: ventas, cajas, bot, alertas, audit)` };
      }
    });

    if (!data) return res.status(404).json({ error: 'Tenant no encontrado' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /metrics — dashboard SaaS agregado
//
// Devuelve KPIs operativos en una sola query (subqueries paralelas vía PG).
// Cacheo en frontend (no en backend) — el dashboard se actualiza al refrescar,
// no necesita ser 100% en vivo.
// ──────────────────────────────────────────────────────────────────────────
router.get('/metrics', async (_req, res, next) => {
  try {
    const data = await db.adminQuery(async (client) => {
      // Una sola query con CTEs para evitar 5 round-trips. PG paraleliza
      // los subselects mejor que Node.js + Promise.all (un SQL = 1 plan).
      const { rows } = await client.query(`
        SELECT
          (SELECT COUNT(*)::int FROM tenants
            WHERE deleted_at IS NULL AND suspended_at IS NULL) AS active,
          (SELECT COUNT(*)::int FROM tenants
            WHERE deleted_at IS NULL AND plan = 'trial' AND suspended_at IS NULL) AS in_trial,
          (SELECT COUNT(*)::int FROM tenants
            WHERE deleted_at IS NULL AND suspended_at IS NOT NULL) AS suspended,
          (SELECT COUNT(*)::int FROM tenants
            WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '7 days') AS signups_7d,
          (SELECT COUNT(*)::int FROM tenants
            WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '30 days') AS signups_30d,
          (SELECT COUNT(*)::int FROM tenants
            WHERE deleted_at IS NULL AND suspended_at >= NOW() - INTERVAL '30 days') AS churn_30d
      `);
      const counts = rows[0];

      // MRR total + breakdown por plan. Una sola query GROUP BY (plan,
      // custom_mrr_usd) — usamos custom_mrr_usd en el group porque hace falta
      // diferenciar enterprise con distintos precios negociados al sumar MRR.
      // Pero para `tenants_by_plan` agrupamos solo por plan (el frontend no
      // necesita ver "enterprise@500" vs "enterprise@800" como rows distintos
      // en la distribución, le alcanza con "enterprise: N clientes, $X MRR").
      const mrrRow = await client.query(`
        SELECT plan, custom_mrr_usd, COUNT(*)::int AS cnt
          FROM tenants
         WHERE deleted_at IS NULL AND suspended_at IS NULL
         GROUP BY plan, custom_mrr_usd
      `);
      let mrr_total_usd = 0;
      const planAgg = new Map(); // plan → { count, mrr_usd }
      for (const r of mrrRow.rows) {
        const rowMrr = getTenantMrr(r.plan, r.custom_mrr_usd) * r.cnt;
        mrr_total_usd += rowMrr;
        const prev = planAgg.get(r.plan) || { plan: r.plan, count: 0, mrr_usd: 0 };
        prev.count += r.cnt;
        prev.mrr_usd += rowMrr;
        planAgg.set(r.plan, prev);
      }
      // Garantizamos un row por plan canónico aunque tenga 0 clientes
      // (así el frontend renderiza siempre la lista completa sin gaps).
      for (const p of ['trial', 'starter', 'pro', 'enterprise']) {
        if (!planAgg.has(p)) planAgg.set(p, { plan: p, count: 0, mrr_usd: 0 });
      }
      const tenants_by_plan = Array.from(planAgg.values())
        .map((p) => ({ ...p, mrr_usd: Math.round(p.mrr_usd * 100) / 100 }))
        .sort((a, b) => b.mrr_usd - a.mrr_usd || b.count - a.count);

      // Conversion trial → paid en los últimos 30d.
      // Heurística: tenants que CAMBIARON de plan='trial' a otro plan en
      // los últimos 30d, contados sobre tenants que ENTRARON en trial en
      // los últimos 60d (para tener cohort representativa).
      // Fuente: tenant_admin_actions con action='plan_change'.
      const convRow = await client.query(`
        WITH trials_60d AS (
          SELECT id FROM tenants
           WHERE deleted_at IS NULL
             AND created_at >= NOW() - INTERVAL '60 days'
        ),
        converted_30d AS (
          SELECT DISTINCT taa.tenant_id
            FROM tenant_admin_actions taa
            JOIN trials_60d t ON t.id = taa.tenant_id
           WHERE taa.action = 'plan_change'
             AND taa.created_at >= NOW() - INTERVAL '30 days'
             AND taa.before_state->>'plan' = 'trial'
             AND taa.after_state->>'plan' <> 'trial'
        )
        SELECT
          (SELECT COUNT(*)::int FROM trials_60d) AS cohort,
          (SELECT COUNT(*)::int FROM converted_30d) AS converted
      `);
      const { cohort, converted } = convRow.rows[0];
      const conversion_trial_paid_30d = cohort > 0 ? Math.round((converted / cohort) * 1000) / 10 : 0; // % con 1 decimal

      return {
        mrr_total_usd: Math.round(mrr_total_usd * 100) / 100,
        tenants_active: counts.active,
        tenants_trial: counts.in_trial,
        tenants_suspended: counts.suspended,
        signups_7d: counts.signups_7d,
        signups_30d: counts.signups_30d,
        churn_30d: counts.churn_30d,
        conversion_trial_paid_30d, // porcentaje (e.g. 23.5)
        plan_prices_usd: PLAN_PRICES_USD,
        tenants_by_plan, // [{ plan, count, mrr_usd }] orden desc por MRR
      };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /metrics/history — serie temporal últimos 90 días
//
// Para gráficos: MRR diario + signups diarios + suspensions diarias.
// generate_series garantiza N días continuos (sin gaps cuando hay 0).
// ──────────────────────────────────────────────────────────────────────────
router.get('/metrics/history', async (_req, res, next) => {
  try {
    const data = await db.adminQuery(async (client) => {
      const { rows } = await client.query(`
        WITH days AS (
          SELECT generate_series(
            CURRENT_DATE - INTERVAL '89 days',
            CURRENT_DATE,
            INTERVAL '1 day'
          )::date AS d
        )
        SELECT
          d::text AS date,
          (SELECT COUNT(*)::int FROM tenants
             WHERE deleted_at IS NULL AND created_at::date = d) AS signups,
          (SELECT COUNT(*)::int FROM tenants
             WHERE deleted_at IS NULL AND suspended_at::date = d) AS suspensions
          FROM days
         ORDER BY d ASC
      `);
      return { history: rows };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /metrics/recent-actions — feed cross-tenant de acciones admin
//
// El Resumen del dashboard lo muestra como activity feed ("Lucas suspendió
// Aurora Mobile · hace 3 h"). Es el equivalente al activity per-tenant pero
// agregado para todos los tenants — útil cuando hay varios super-admins
// trabajando en paralelo o para ver "qué hicimos esta semana".
//
// Distinto a tenant_admin_actions con LIMIT: acá joineamos tenant + super-admin
// user en una sola query para que el frontend renderice sin lookups extra.
// Cap default 10 (Resumen muestra 5-7), max 50 (sub-fase futura "ver todo").
// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────
// GET /plan-prices — lista los precios de planes editables (C.1.2 #353).
//
// Lee la tabla `plan_prices` directo (NO el cache) — el admin puede ver el
// estado autoritativo de la DB, no el snapshot que tiene este proceso en
// memoria. Útil si Lucas pidió el cambio en réplica A y consulta desde
// réplica B (refresh aún no corrió).
//
// Devuelve rows ordenadas por orden canónico (trial, starter, pro, enterprise),
// con join a users para mostrar quién hizo el último UPDATE.
// ──────────────────────────────────────────────────────────────────────────
router.get('/plan-prices', async (_req, res, next) => {
  try {
    const data = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT pp.plan,
                pp.price_usd,
                pp.active,
                pp.notes,
                pp.created_at,
                pp.updated_at,
                pp.updated_by,
                u.username AS updated_by_username
           FROM plan_prices pp
           LEFT JOIN users u ON u.id = pp.updated_by
          ORDER BY CASE pp.plan
                     WHEN 'trial' THEN 1
                     WHEN 'starter' THEN 2
                     WHEN 'pro' THEN 3
                     WHEN 'enterprise' THEN 4
                     ELSE 99
                   END`
      );
      return rows;
    });
    res.json({ plan_prices: data });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /plan-prices/:plan — actualiza precio + notes de un plan (C.1.2 #353).
//
// Validaciones (más allá del Zod schema):
//   - `plan` del path debe estar en PLANES (404 sino).
//   - `trial` NO se puede editar (el frontend lo deshabilita pero defendemos
//     server-side igual: trial siempre es 0 por contrato del producto).
//   - `enterprise` requiere price_usd=null (custom per-tenant). El CHECK de
//     DB lo enforcea pero rebotamos antes para 400 limpio.
//
// Atomicidad: leer estado actual + UPDATE + audit en UNA tx (mismo pattern
// que PATCH /tenants/:id). Si dos super-admins editan el mismo plan en
// paralelo, FOR UPDATE serializa.
//
// Audit: action='plan_price_change'. tenant_id=1 como anchor (es config
// global, no per-tenant — ver rationale en migration 20260622153000).
//
// Post-commit: refreshCache() para que ESTA réplica vea el cambio inmediato.
// Las otras réplicas se enteran en su próximo refresh periódico (≤5min).
// ──────────────────────────────────────────────────────────────────────────
router.patch('/plan-prices/:plan', validate(patchPlanPriceSchema), async (req, res, next) => {
  try {
    const plan = String(req.params.plan);
    if (!PLANES.includes(plan)) {
      return res.status(404).json({ error: `Plan '${plan}' no existe` });
    }
    if (plan === 'trial') {
      return res.status(400).json({
        error: 'Trial siempre es gratis — no se puede editar su precio.',
      });
    }
    const { price_usd, notes, reason } = req.body;
    if (plan === 'enterprise' && price_usd !== null) {
      return res.status(400).json({
        error: 'Enterprise no acepta precio fijo (custom per-tenant via tenants.custom_mrr_usd).',
      });
    }

    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const beforeRow = await client.query(
          `SELECT plan, price_usd, notes, updated_at, updated_by
             FROM plan_prices
            WHERE plan = $1
            FOR UPDATE`,
          [plan]
        );
        if (!beforeRow.rows[0]) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        const before = beforeRow.rows[0];

        // No-op detection: si price_usd no cambia y notes no se mandó o es igual.
        const notesProvided = Object.prototype.hasOwnProperty.call(req.body, 'notes');
        const priceChanged = Number(before.price_usd) !== Number(price_usd)
                          || (before.price_usd === null) !== (price_usd === null);
        const notesChanged = notesProvided && before.notes !== notes;
        if (!priceChanged && !notesChanged) {
          await client.query('ROLLBACK');
          return { noop: true, row: before };
        }

        // UPDATE solo de campos que cambian (mantiene updated_at sin tocar
        // si solo se editó notes, etc.). Si cambia price_usd, también
        // updated_at + updated_by.
        const sets = [];
        const params = [];
        if (priceChanged) {
          params.push(price_usd);
          sets.push(`price_usd = $${params.length}`);
        }
        if (notesChanged) {
          params.push(notes);
          sets.push(`notes = $${params.length}`);
        }
        params.push(req.user.id);
        sets.push(`updated_by = $${params.length}`);
        sets.push(`updated_at = NOW()`);
        params.push(plan);
        const updateRow = await client.query(
          `UPDATE plan_prices SET ${sets.join(', ')}
            WHERE plan = $${params.length}
            RETURNING *`,
          params
        );

        // Audit: tenant_id=1 (Tecny, anchor del super-admin que hizo el cambio).
        // Ver rationale en migration 20260622153000.
        await insertAdminAction(client, {
          tenantId: 1,
          superAdminUserId: req.user.id,
          action: 'plan_price_change',
          beforeState: {
            plan: before.plan,
            price_usd: before.price_usd === null ? null : Number(before.price_usd),
            notes: before.notes,
          },
          afterState: {
            plan,
            price_usd,
            ...(notesChanged ? { notes } : {}),
          },
          reason,
        });

        await client.query('COMMIT');
        return { row: updateRow.rows[0] };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
        throw err;
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: `Plan '${plan}' no existe` });
    }

    // Hot-invalidate del cache en ESTA réplica. Las otras se enteran en su
    // próximo refresh (≤5min). Es async pero awaiteamos: si falla, el cliente
    // ve 200 con datos viejos en la próxima request — preferimos consistencia
    // inmediata sobre el latency extra (~10-20ms).
    if (!result.noop) {
      await refreshPlanPricesCache();
      logger.info(
        { plan, super_admin: req.user.id, new_price: result.row.price_usd },
        '[super-admin] PATCH /plan-prices/:plan'
      );
    }

    res.json({
      plan: result.row.plan,
      price_usd: result.row.price_usd === null ? null : Number(result.row.price_usd),
      notes: result.row.notes,
      updated_at: result.row.updated_at,
      updated_by: result.row.updated_by,
      noop: !!result.noop,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/metrics/recent-actions', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 10), 50);

    const data = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT taa.id,
                taa.tenant_id,
                t.nombre AS tenant_nombre,
                t.slug   AS tenant_slug,
                taa.action,
                taa.reason,
                taa.created_at,
                u.username AS super_admin_username
           FROM tenant_admin_actions taa
           JOIN tenants t ON t.id = taa.tenant_id
           LEFT JOIN users u ON u.id = taa.super_admin_user_id
          ORDER BY taa.created_at DESC
          LIMIT $1`,
        [limit]
      );
      return { recent_actions: rows };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

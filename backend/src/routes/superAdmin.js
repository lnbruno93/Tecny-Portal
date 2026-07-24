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
  deleteTenantSchema,
  createTenantSchema,
  setPaidUntilSchema,
  patchPlanPriceSchema,
  changePaisSchema,
  updateComprobanteFooterSchema,
  updateSiteLandingContactSchema,
  mergeClasesProductoSchema,
  createTrustedCompanySchema,
  updateTrustedCompanySchema,
  patchFeatureFlagSchema,
  upsertTenantOverrideSchema,
  upsertPlanOverrideSchema,
  PLANES,
} = require('../schemas/superAdmin');
// 2026-07-18 CMS Landing Fase 4: helper para almacenar logos de empresas
// (Cloudflare R2 en prod, base64 en columna DB en staging/dev). Ver
// backend/src/lib/fileStore.js para la abstracción de drivers.
const fileStore = require('../lib/fileStore');
const { invalidateTenantStatus } = require('../lib/tenantStatus');
const { invalidateUserAuth } = require('../lib/userAuthCache');
// 2026-07-24 (cache audit P2 follow-up): clases-merge mueve productos entre
// clases → el cache INVENTARIO_METRICAS (que agrega inv_por_clase) queda stale.
const { invalidateMetricas } = require('../lib/inventarioCache');
// #473: reusamos las defaults de signup para que el set de cajas creado por
// "cambiar país" matchee 1:1 al que recibe un tenant nuevo del país destino.
const { getDefaultCajasPorPais } = require('./signup');
const { computeHealthScore } = require('../lib/tenantHealth');
// F3.a: seed de las 9 clases base + "Sin categoría" en clases_producto.
const { seedClasesProducto } = require('../lib/seedClasesProducto');
const { sendPasswordResetEmail } = require('../lib/email');
const googleReviews = require('../lib/googleReviews');
const { randomBytes, randomUUID } = require('crypto');
const crypto = { randomUUID };
const logger = require('../lib/logger');

// #452: TTL del token de set-initial-password (mismo que password reset
// común). 24h da margen al owner para abrir el email sin presión, suficiente
// corto para limitar window de abuso si el email fue interceptado.
const SET_PASSWORD_TOKEN_TTL_HOURS = 24;

// 3 cajas default sembradas para cada tenant nuevo (igual que signup público).
// Mantener sincronizado con signup.js — si Lucas agrega más al signup público,
// también acá. Idealmente extraer a un módulo shared en una sub-fase futura.
const DEFAULT_CAJAS = [
  { nombre: 'Efectivo Pesos', moneda: 'ARS', orden: 1, es_financiera: true },
  { nombre: 'Efectivo USD',   moneda: 'USD', orden: 2, es_financiera: false },
  { nombre: 'Banco Pesos',    moneda: 'ARS', orden: 3, es_financiera: false },
];
const DEFAULT_CATEGORIAS = ['Celulares', 'Accesorios', 'Servicios', 'Otros'];

// Helpers locales (réplica de signup.js — extracción a shared en sub-fase
// futura cuando agreguemos un 3er camino de creación, ej. invite-to-existing).
function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length >= 2 ? slug : 'tenant';
}
function deriveUsername(email) {
  const local = String(email).split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return local.length >= 2 ? local : 'user';
}
async function uniqueSlug(client, base) {
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    const { rows } = await client.query('SELECT 1 FROM tenants WHERE slug = $1', [candidate]);
    if (rows.length === 0) return candidate;
  }
  throw new Error('No se pudo generar un slug único después de 100 intentos');
}
async function uniqueUsername(client, base) {
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : `${base}_${n + 1}`;
    const { rows } = await client.query(
      'SELECT 1 FROM users WHERE username = $1 AND deleted_at IS NULL', [candidate]
    );
    if (rows.length === 0) return candidate;
  }
  throw new Error('No se pudo generar un username único después de 100 intentos');
}
function frontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:5173';
}

// SQL fragment con las stats necesarias para computeHealthScore. Se reusa
// en listTenants y getTenant para que el cálculo sea consistente. Cada
// stat es una subquery — ~7 subqueries por row del listing es costoso pero
// aceptable mientras tenemos <100 tenants. Si escala, mover a una vista
// materializada con refresh nocturno.
//
// Nota nomenclatura: la "cajas" del UI es `metodos_pago` en la DB.
// chat_messages tiene tenant_id directo (no necesita join con conversations).
const HEALTH_STATS_SQL = `
  (SELECT COUNT(*)::int FROM ventas v
    WHERE v.tenant_id = t.id AND v.deleted_at IS NULL
      AND v.created_at >= NOW() - INTERVAL '30 days')             AS ventas_30d,
  (SELECT COUNT(*)::int FROM ventas v
    WHERE v.tenant_id = t.id AND v.deleted_at IS NULL)            AS ventas_total,
  (SELECT COUNT(*)::int FROM chat_messages cm
    WHERE cm.tenant_id = t.id
      AND cm.created_at >= NOW() - INTERVAL '30 days')            AS bot_msgs_30d,
  (SELECT COUNT(*)::int FROM productos p
    WHERE p.tenant_id = t.id AND p.deleted_at IS NULL)            AS productos_count,
  (SELECT COUNT(*)::int FROM contactos c
    WHERE c.tenant_id = t.id AND c.deleted_at IS NULL)            AS contactos_count,
  (SELECT COUNT(*)::int FROM metodos_pago mp
    WHERE mp.tenant_id = t.id AND mp.deleted_at IS NULL)          AS cajas_count,
  (SELECT COUNT(*)::int FROM alertas_config ac
    WHERE ac.tenant_id = t.id AND ac.activa = true)               AS alertas_count
`;

// Helper: enrichTenantWithHealth — proyecta health_score + breakdown +
// category sobre un tenant ya hidratado con stats. Usado tras ambas queries
// (list + detail) para mantener una sola fuente de verdad para el cálculo.
function enrichTenantWithHealth(tenant) {
  const stats = {
    ventas_30d:      tenant.ventas_30d,
    ventas_total:    tenant.ventas_total,
    bot_msgs_30d:    tenant.bot_msgs_30d,
    productos_count: tenant.productos_count,
    contactos_count: tenant.contactos_count,
    cajas_count:     tenant.cajas_count,
    alertas_count:   tenant.alertas_count,
    users_count:     tenant.users_count,
  };
  const health = computeHealthScore({ tenant, stats });
  return {
    ...tenant,
    health_score:     health.score,
    health_breakdown: health.breakdown,
    health_category:  health.category,
  };
}

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
               AND u.created_at >= NOW() - INTERVAL '30 days') AS signups_30d,
           -- Health score stats (#440)
           ${HEALTH_STATS_SQL}
         FROM tenants t
         WHERE ${where.join(' AND ')}
         ORDER BY ${sort.sql}
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        [...params, limit, offset]
      );
      return { rows, total };
    });

    res.json({
      // Calcular MRR + health per-tenant en Node. La fórmula de salud vive
      // en lib/tenantHealth.js — calculamos acá (no en SQL) porque la lógica
      // es compleja (4 sub-scorers + onboarding override + suspended bypass)
      // y queremos tests unitarios puros sin DB.
      tenants: result.rows.map((t) => enrichTenantWithHealth({
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
// GET /tenants/export — exportar listado completo a CSV (#450)
//
// Mismos filtros que GET /tenants (plan, suspended, search) pero SIN paginación.
// Devuelve todas las filas matcheadas en formato CSV (RFC 4180).
//
// Hardcap: 10.000 filas. Si el universo es más grande, devolvemos 400 — más
// allá de eso, el operador debería filtrar antes (no tiene sentido ver 10k
// tenants en una sola hoja). Hoy con <100 tenants este límite es académico.
//
// Encoding: UTF-8 con BOM (U+FEFF prefix) para que Excel lo abra bien con
// tildes y acentos sin que el usuario tenga que cambiar el encoding manual.
// ──────────────────────────────────────────────────────────────────────────
const EXPORT_CAP = 10000;

// CSV escaping per RFC 4180: si el valor tiene coma, comilla doble o newline,
// se envuelve en comillas dobles y las comillas internas se duplican.
function csvCell(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

router.get('/tenants/export', async (req, res, next) => {
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

    const result = await db.adminQuery(async (client) => {
      // Count primero para enforce el cap antes de pegar el SELECT grande.
      const countQ = await client.query(
        `SELECT COUNT(*)::int AS total
           FROM tenants t
          WHERE ${where.join(' AND ')}`,
        params
      );
      const total = countQ.rows[0]?.total ?? 0;
      if (total > EXPORT_CAP) return { tooBig: true, total };

      const { rows } = await client.query(
        `SELECT
           t.id, t.nombre, t.slug, t.plan, t.custom_mrr_usd,
           t.suspended_at, t.suspended_reason,
           t.trial_until, t.paid_until, t.created_at, t.notes,
           (SELECT COUNT(*)::int FROM tenant_users tu WHERE tu.tenant_id = t.id) AS users_count,
           (SELECT MAX(created_at) FROM ventas v
              WHERE v.tenant_id = t.id AND v.deleted_at IS NULL) AS last_venta_at,
           ${HEALTH_STATS_SQL}
         FROM tenants t
         WHERE ${where.join(' AND ')}
         ORDER BY t.id ASC`,
        params
      );
      return { rows };
    });

    if (result.tooBig) {
      return res.status(400).json({
        error: `El filtro matchea ${result.total} tenants (máximo ${EXPORT_CAP}). Restringí con ?plan o ?search.`,
      });
    }

    const headers = [
      'id', 'nombre', 'slug', 'plan', 'mrr_usd',
      'custom_mrr_usd', 'suspended_at', 'suspended_reason',
      'trial_until', 'paid_until', 'created_at',
      'users_count', 'last_venta_at',
      'health_score', 'health_category',
      'notes',
    ];

    // BOM (U+FEFF) para que Excel decode UTF-8 sin que el usuario configure
    // encoding. Sin BOM, Excel asume Windows-1252 y rompe tildes/ñ.
    // Usamos escape form para que el linter no rechace whitespace irregular.
    const BOM = String.fromCharCode(0xFEFF);
    let csv = BOM + headers.join(',') + '\r\n';
    for (const t of result.rows) {
      const enriched = enrichTenantWithHealth({
        ...t,
        mrr_usd: getTenantMrr(t.plan, t.custom_mrr_usd),
      });
      const row = [
        enriched.id,
        enriched.nombre,
        enriched.slug,
        enriched.plan,
        enriched.mrr_usd,
        enriched.custom_mrr_usd,
        enriched.suspended_at ? new Date(enriched.suspended_at).toISOString() : '',
        enriched.suspended_reason,
        enriched.trial_until,
        enriched.paid_until,
        enriched.created_at ? new Date(enriched.created_at).toISOString() : '',
        enriched.users_count,
        enriched.last_venta_at ? new Date(enriched.last_venta_at).toISOString() : '',
        enriched.health_score,
        enriched.health_category,
        enriched.notes,
      ].map(csvCell).join(',');
      csv += row + '\r\n';
    }

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tenants_${today}.csv"`);
    res.send(csv);

    logger.info(
      { super_admin: req.user.id, rows: result.rows.length },
      '[super-admin] GET /tenants/export'
    );
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /tenants — crear tenant manual desde el back office (#452).
//
// Caso de uso: super-admin onboardea un cliente desde la UI. Típico: demo
// cerrada en sales call → tenant pre-creado antes del primer login del owner.
// Esto reemplaza el workflow ad-hoc "darle el link de signup público y rezar".
//
// Flow:
//   1. Validar body con createTenantSchema (Zod .strict()).
//   2. Anti-conflict: si el email ya pertenece a un user (cualquier tenant),
//      devolver 409. NO hay anti-enum acá — el endpoint es admin-only, el
//      super-admin necesita saber por qué no se creó.
//   3. INSERT tenant + user + tenant_users + tenant_user_roles + seeds
//      (cajas/categorías/vendedor/config) — EXACTAMENTE el mismo flow que
//      signup público, salvo que email_verified_at=NOW() (admin-vouched).
//   4. Generar password_reset_token con TTL 24h e INSERT.
//   5. Audit a tenant_admin_actions con action='create'.
//   6. Post-commit, fire-and-forget: enviar email "elegí tu password" usando
//      sendPasswordResetEmail (reusa el template existente — semánticamente
//      "set initial password" y "reset password" son el mismo flow: clickeás
//      el link y elegís una contraseña).
//
// Diseño durable:
//   - email_verified_at=NOW(): el super-admin ya verificó identidad por
//     teléfono/Calendly antes de crear. No imponemos al owner clickear un
//     verification link extra solo para activar la cuenta.
//   - Sin password inicial: el owner LO elige via reset link. Esto evita
//     que el admin tenga que generar una temp password segura y compartirla
//     por canal inseguro (Slack, email plano).
//   - SET LOCAL app.current_tenant es crítico para RLS en metodos_pago,
//     categorias, vendedores, config, user_capabilities (tablas con RLS).
//
// Tradeoffs:
//   - Si Resend falla, el owner no recibe el email. El admin puede
//     reintentar via "Enviar invitación" (sub-fase futura) o decirle al
//     owner que use /forgot-password con su email.
//   - El token reset tiene TTL 24h. Si el owner no clickea en 24h, debe
//     usar /forgot-password (rate-limited).
// ──────────────────────────────────────────────────────────────────────────
router.post('/tenants', validate(createTenantSchema), async (req, res, next) => {
  const { tenant_nombre, nombre, email, plan, custom_mrr_usd, reason } = req.body;

  // Anti-conflict: email ya en uso. CASE-INSENSITIVE (matchea unique index
  // LOWER(email) creado en TANDA 1).
  const existing = await db.query(
    'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL',
    [email]
  );
  if (existing.rows.length > 0) {
    return res.status(409).json({
      error: 'Ese email ya está registrado en otro tenant.',
      reason: 'email_taken',
    });
  }

  // Usamos adminQuery (BYPASSRLS) para el INSERT en `users` (que no tiene
  // RLS) + el INSERT en tablas RLS-scoped vía SET LOCAL al tenant nuevo.
  // BYPASSRLS evita necesitar permisos especiales pero el SET LOCAL sigue
  // ejecutándose como guardrail de defense-in-depth.
  //
  // db.adminQuery NO auto-wraps en tx (por diseño — la mayoría de admin queries
  // son reads). Acá necesitamos atomicidad explícita: tenant + user + audit
  // viven o mueren juntos. Manejamos BEGIN/COMMIT/ROLLBACK manualmente.
  let result;
  try {
    result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const out = await createTenantTx(client, req, {
          tenant_nombre, nombre, email, plan, custom_mrr_usd, reason,
        });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });
  } catch (err) {
    // Race condition: alguien creó el email/username/slug entre el SELECT
    // anti-conflict y los INSERTs. PG enforcea con UNIQUE → 23505 → 409.
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Email o slug ya en uso (race condition). Reintentá.',
        reason: 'unique_conflict',
      });
    }
    return next(err);
  }

  // Post-commit: enviar email "elegí tu password". Fire-and-forget — si
  // Resend falla el endpoint igual devuelve 201 (el admin puede reenviar
  // o decirle al owner que use /forgot-password). Loggeamos para Sentry.
  setImmediate(async () => {
    try {
      const resetUrl = `${frontendUrl()}/reset-password?token=${result.token}`;
      await sendPasswordResetEmail({
        to: result.user.email,
        name: result.user.nombre,
        resetUrl,
        ttlHours: SET_PASSWORD_TOKEN_TTL_HOURS,
      });
      logger.info(
        { user_id: result.user.id, tenant_id: result.tenant.id },
        '[super-admin] create-tenant: password setup email enviado'
      );
    } catch (e) {
      logger.error(
        { err: e, user_id: result.user.id, tenant_id: result.tenant.id },
        '[super-admin] create-tenant: password setup email falló — owner debe usar /forgot-password'
      );
    }
  });

  // Response: incluimos el tenant + user para que el frontend pueda
  // redirigir directo a la Ficha. NO incluimos el token (excepto en test/dev,
  // mismo patrón que /signup).
  logger.info(
    {
      super_admin_id: req.user.id,
      tenant_id: result.tenant.id,
      tenant_nombre: result.tenant.nombre,
      tenant_slug: result.tenant.slug,
      tenant_plan: result.tenant.plan,
      owner_email: result.user.email,
    },
    '[super-admin] tenant manual creado'
  );

  const response = {
    tenant: {
      ...result.tenant,
      mrr_usd: getTenantMrr(result.tenant.plan, result.tenant.custom_mrr_usd),
    },
    owner: result.user,
    password_setup_url_ttl_hours: SET_PASSWORD_TOKEN_TTL_HOURS,
  };

  // Mismo gate dual que signup.js (NODE_ENV + EXPOSE_VERIFICATION_TOKEN).
  // Defense in depth para evitar leak en staging/preview mal configurados.
  const exposeToken = process.env.NODE_ENV === 'test'
    || (process.env.NODE_ENV !== 'production' && process.env.EXPOSE_VERIFICATION_TOKEN === '1');
  if (exposeToken) {
    response._password_setup_token = result.token;
  }

  return res.status(201).json(response);
});

// Helper que encapsula la transacción de createTenant. Se ejecuta DENTRO
// del BEGIN/COMMIT del handler — no abre tx por sí mismo.
async function createTenantTx(client, req, body) {
  const { tenant_nombre, nombre, email, plan, custom_mrr_usd, reason } = body;
      // 1. Tenant nuevo. Plan validado por Zod.
      const slug = await uniqueSlug(client, slugify(tenant_nombre));
      const { rows: [tenant] } = await client.query(
        `INSERT INTO tenants (nombre, slug, plan, custom_mrr_usd)
           VALUES ($1, $2, $3, $4)
         RETURNING id, nombre, slug, plan, custom_mrr_usd, created_at`,
        // custom_mrr_usd solo para enterprise. Defensive: clamp a null si no
        // aplica (Zod ya validó que si es enterprise está presente).
        [tenant_nombre, slug, plan, plan === 'enterprise' ? custom_mrr_usd : null]
      );

      // 1.5. SET LOCAL antes de cualquier INSERT en tabla RLS-protegida.
      // Para BYPASSRLS, el SET LOCAL es defense-in-depth (no requerido por
      // RLS pero útil si en el futuro algún UPDATE consulta current_setting).
      await client.query(
        `SELECT set_config('app.current_tenant', $1::text, true)`,
        [String(tenant.id)]
      );

      // 2. User owner — email_verified_at=NOW() (admin-vouched).
      // password_hash queda con un placeholder NO-USABLE: 60 chars con
      // formato bcrypt válido pero que jamás matcheará bcrypt.compare (porque
      // el "hash" es derivado de un random que se descarta). El owner DEBE
      // setear su pass via el link de set-password antes del primer login.
      const username = await uniqueUsername(client, deriveUsername(email));
      // bcrypt-shaped placeholder: 60 chars, no es un hash válido de ninguna
      // password conocida. Garantizamos que SI el owner no clickea el link
      // y trata de loguearse, bcrypt.compare devuelve false (bloqueado).
      const unusablePasswordHash = '$2b$12$' + randomBytes(40).toString('base64url').slice(0, 53);
      const { rows: [user] } = await client.query(
        `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
           VALUES ($1, $2, $3, $4, 'op', NOW())
         RETURNING id, nombre, username, email, email_verified_at`,
        [nombre, username, email, unusablePasswordHash]
      );

      // 3. tenant_users (bridge) — sin RLS.
      await client.query(
        `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`,
        [tenant.id, user.id]
      );

      // 4. tenant_user_roles (capability-based, post-F4 cutover).
      await client.query(
        `INSERT INTO tenant_user_roles (tenant_id, user_id, rol)
           VALUES ($1, $2, 'owner')`,
        [tenant.id, user.id]
      );

      // 5. Seeds defaults — cajas, categorías, vendedor, config (#452 réplica
      // de signup.js — mantener sincronizado).
      for (const caja of DEFAULT_CAJAS) {
        await client.query(
          `INSERT INTO metodos_pago (nombre, moneda, orden, es_financiera, tenant_id)
             VALUES ($1, $2, $3, $4, $5)`,
          [caja.nombre, caja.moneda, caja.orden, caja.es_financiera, tenant.id]
        );
      }
      for (const catNombre of DEFAULT_CATEGORIAS) {
        await client.query(
          `INSERT INTO categorias (nombre, tenant_id) VALUES ($1, $2)`,
          [catNombre, tenant.id]
        );
      }
      await client.query(
        `INSERT INTO vendedores (nombre, tenant_id) VALUES ($1, $2)`,
        [nombre, tenant.id]
      );
      // 2026-07-08 F3.a: seed de las 9 clases base + "Sin categoría" en
      // clases_producto. Réplica del seed de signup.js — mantener alineado.
      await seedClasesProducto(client, tenant.id);
      await client.query(
        `INSERT INTO config (id, pct_financiera, tenant_id) VALUES (1, 0, $1)
         ON CONFLICT (tenant_id, id) DO NOTHING`,
        [tenant.id]
      );

      // 6. password_reset_token con TTL 24h. Reusamos la tabla del flow
      // forgot-password — semánticamente "set initial password" = "reset password".
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + SET_PASSWORD_TOKEN_TTL_HOURS * 60 * 60 * 1000);
      await client.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [user.id, token, expiresAt]
      );

      // 7. Audit. action='create' (migration 20260626100000 agregó al CHECK).
      // tenant_id ahora apunta al tenant recién creado — natural para forensic
      // queries ("dame todo lo que se hizo a tenant X").
      await client.query(
        `INSERT INTO tenant_admin_actions
           (tenant_id, super_admin_user_id, action, reason, before_state, after_state)
         VALUES ($1, $2, 'create', $3, NULL, $4::jsonb)`,
        [
          tenant.id,
          req.user.id,
          reason || null,
          JSON.stringify({
            tenant: { id: tenant.id, nombre: tenant.nombre, slug: tenant.slug, plan: tenant.plan },
            owner:  { id: user.id, email: user.email, username },
          }),
        ]
      );

      return { tenant, user, token };
}

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
                     AND u.created_at >= NOW() - INTERVAL '30 days') AS signups_30d,
                -- Health score stats (#440)
                ${HEALTH_STATS_SQL}
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

    // Enriquecemos con MRR + health antes de devolver. El health_breakdown
    // se proyecta para que el frontend pueda mostrar las 4 barras del tab
    // Resumen con valores reales (no derivaciones débiles del proxy viejo).
    const enriched = enrichTenantWithHealth({
      ...result.tenant,
      mrr_usd: getTenantMrr(result.tenant.plan, result.tenant.custom_mrr_usd),
    });
    res.json({
      ...enriched,
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
        //    Incluimos nombre+slug porque ahora son mutables (#439).
        const beforeRow = await client.query(
          `SELECT nombre, slug, plan, suspended_at, suspended_reason, trial_until,
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
        // Slug UNIQUE constraint: si el nuevo slug ya existe en otro tenant,
        // PG rebota con code 23505 (unique_violation). Lo cacheamos abajo
        // en el catch para devolver 409 limpio en vez de 500.
        let updateRow;
        try {
          updateRow = await client.query(
            `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
            params
          );
        } catch (pgErr) {
          if (pgErr && pgErr.code === '23505') {
            await client.query('ROLLBACK');
            return { slugConflict: true, attemptedSlug: after.slug };
          }
          throw pgErr;
        }
        const updatedTenant = updateRow.rows[0];

        // 4. Decidir el `action` más específico.
        //    Prioridad: plan_change > suspend/reactivate > trial_extend >
        //    custom_mrr_update > rename > note_update.
        //    rename va antes de note_update porque cuando el operador cambia
        //    nombre/slug suele venir sin tocar notes — querer ver "rename"
        //    en el feed es más útil que "note_update".
        let action = 'note_update';
        if (mutables.plan !== undefined && mutables.plan !== before.plan) {
          action = 'plan_change';
        } else if (mutables.suspended_at !== undefined) {
          action = mutables.suspended_at ? 'suspend' : 'reactivate';
        } else if (mutables.trial_until !== undefined) {
          action = 'trial_extend';
        } else if (mutables.custom_mrr_usd !== undefined) {
          action = 'custom_mrr_update';
        } else if (
          (mutables.nombre !== undefined && mutables.nombre !== before.nombre) ||
          (mutables.slug   !== undefined && mutables.slug   !== before.slug)
        ) {
          action = 'rename';
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
    if (result.slugConflict) {
      return res.status(409).json({
        error: 'slug ya en uso',
        detail: `El slug "${result.attemptedSlug}" ya pertenece a otro tenant. Elegí otro.`,
      });
    }

    logger.info(
      { tenant_id: id, super_admin: req.user.id, noop: !!result.noop },
      '[super-admin] PATCH /tenants/:id'
    );

    // 2026-07-24 (cache audit P1): invalidar tenantStatus cross-instance.
    // El cache de `getTenantStatus` (TTL 5min Redis + local) incluye
    // `nombre`, `plan`, `paid_until`, `suspended_at`, `pais` — cualquier
    // PATCH sobre estos campos deja el cache stale hasta el próximo TTL,
    // causando que /me + comprobantes PDF + middleware billing vean valores
    // viejos durante minutos post-cambio. Los otros endpoints admin sensibles
    // (suspend/reactivate/extend-trial/PATCH paid-until/migrate-country) ya
    // llaman invalidateTenantStatus — este PATCH genérico se había quedado
    // atrás. Fire-and-forget con catch para no bloquear la response.
    if (!result.noop) {
      invalidateTenantStatus(id).catch(err =>
        logger.warn({ err: err.message, tenantId: id }, 'PATCH /tenants: invalidate cache falló')
      );
    }

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

    // Invalidar cache cross-instance — suspend pasa el tenant a is_active=false.
    // Sin invalidate, los writes en el tenant siguen pasando hasta el TTL (5min).
    invalidateTenantStatus(id).catch(err =>
      logger.warn({ err: err.message, tenantId: id }, 'suspend: invalidate cache falló')
    );

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

    // Invalidar cache cross-instance — reactivar quita suspended_at, así que
    // el tenant pasa de inactive a active. Sin invalidate, las réplicas con
    // cache caliente siguen viendo "suspended" hasta el TTL natural (5min).
    invalidateTenantStatus(id).catch(err =>
      logger.warn({ err: err.message, tenantId: id }, 'reactivate: invalidate cache falló')
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// DELETE /tenants/:id — soft-delete tenant (2026-06-26 feature #438).
//
// Trigger: el super-admin quiere limpiar tenants de prueba / cancelados
// desde la UI del back office, en vez de SQL manual.
//
// Soft-delete: UPDATE tenants SET deleted_at = NOW(). NO toca las tablas
// hijas (productos, ventas, cajas, etc.) — quedan huérfanas pero recuperables
// si revertimos el deleted_at. Un cron futuro (>30d) puede hard-deletear con
// CASCADE para limpieza definitiva, dando ventana de "deshacer".
//
// Seguridad anti-clicaccidental: query param `?confirm=<slug>` debe matchear
// exactamente el slug del tenant. Mismo patrón que GitHub repo delete —
// obliga a tipear el nombre antes de habilitar el botón rojo.
//
// Idempotencia: si el tenant ya está soft-deleted, devolvemos 200 (no fail).
// Esto facilita doble-click o reintento tras timeout sin error confuso.
//
// Cache invalidation: igual que suspend, invalidamos tenantStatus después
// del COMMIT para que las réplicas no devuelvan al tenant como activo.
// ──────────────────────────────────────────────────────────────────────────
router.delete('/tenants/:id', validate(deleteTenantSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const { reason } = req.body;
    const confirmSlug = req.query.confirm;
    if (!confirmSlug || typeof confirmSlug !== 'string') {
      return res.status(400).json({
        error: 'confirm requerido',
        detail: 'Para eliminar, pasá ?confirm=<slug-del-tenant> en la URL',
      });
    }

    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const beforeRow = await client.query(
          `SELECT slug, nombre, plan, deleted_at FROM tenants
            WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (!beforeRow.rows[0]) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        const before = beforeRow.rows[0];

        // Validar slug confirm contra el real (anti-click accidental).
        if (before.slug !== confirmSlug) {
          await client.query('ROLLBACK');
          return { slugMismatch: true, expected: before.slug };
        }

        // Idempotencia: si ya está soft-deleted, no hacemos nada (no fail).
        // Audit tampoco se loguea — no es una acción nueva.
        if (before.deleted_at !== null) {
          await client.query('ROLLBACK');
          return { alreadyDeleted: true };
        }

        await client.query(
          `UPDATE tenants SET deleted_at = NOW() WHERE id = $1`,
          [id]
        );
        await insertAdminAction(client, {
          tenantId: id,
          superAdminUserId: req.user.id,
          action: 'delete',
          beforeState: { deleted_at: null, slug: before.slug, nombre: before.nombre, plan: before.plan },
          afterState:  { deleted_at: 'NOW()' },
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
    if (result.slugMismatch) {
      return res.status(400).json({
        error: 'confirm slug no coincide',
        detail: `El tenant tiene slug "${result.expected}" — pasá ese valor en ?confirm=`,
      });
    }
    if (result.alreadyDeleted) {
      // Devolvemos 200 igual — idempotente. El frontend puede mostrar "ya estaba borrado".
      return res.json({ ok: true, alreadyDeleted: true });
    }

    // Invalidar cache cross-instance — delete pasa el tenant a is_active=false
    // (tenantStatus chequea deleted_at). Sin invalidate, las réplicas con cache
    // caliente siguen sirviéndolo como activo hasta el TTL natural (5min).
    invalidateTenantStatus(id).catch(err =>
      logger.warn({ err: err.message, tenantId: id }, 'delete: invalidate cache falló')
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /tenants/:id/set-paid-until — marca paid_until manual (TANDA 4.B
// billing pre-live 2026-06-25).
//
// Trigger: el operador recibió una transferencia y extiende el período pagado.
// Setea paid_until a una fecha YYYY-MM-DD. NULL permitido para grandfather.
//
// Atomicidad: read FOR UPDATE → UPDATE → audit en una tx. Si dos super-admins
// pisan paid_until concurrentemente, el lock serializa y el audit refleja la
// secuencia real.
//
// Invalidate cache: invalidateTenantStatus() después del COMMIT. Si falla
// (Redis down), no rollbackeamos — el TTL natural de 5min recuperará.
// ──────────────────────────────────────────────────────────────────────────
router.post('/tenants/:id/set-paid-until', validate(setPaidUntilSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const { paid_until, reason } = req.body;

    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        const beforeRow = await client.query(
          `SELECT paid_until FROM tenants
            WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [id]
        );
        if (!beforeRow.rows[0]) {
          await client.query('ROLLBACK');
          return { notFound: true };
        }
        const before = beforeRow.rows[0];

        const updateRow = await client.query(
          `UPDATE tenants SET paid_until = $1::date WHERE id = $2 RETURNING paid_until`,
          [paid_until, id]
        );
        const newPaidUntil = updateRow.rows[0].paid_until;

        await insertAdminAction(client, {
          tenantId: id,
          superAdminUserId: req.user.id,
          action: 'paid_until_update',
          beforeState: { paid_until: before.paid_until },
          afterState:  { paid_until: newPaidUntil },
          reason,
        });
        await client.query('COMMIT');
        return { paid_until: newPaidUntil };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
        throw err;
      }
    });

    if (result.notFound) return res.status(404).json({ error: 'Tenant no encontrado' });

    // Invalidar cache cross-instance — best-effort. Si falla, el TTL natural
    // (5min) recuperará. No rollbackeamos el UPDATE por un Redis error.
    invalidateTenantStatus(id).catch(err =>
      logger.warn({ err: err.message, tenantId: id }, 'set-paid-until: invalidate cache falló')
    );

    res.json({ paid_until: result.paid_until });
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
//
// MRR diario (#451): para cada día calculamos la suma de MRR de los tenants
// que estaban "activos" ese día (created_at <= día, no eliminados, no
// suspendidos al cierre del día). Usamos los precios ACTUALES de cada plan
// + custom_mrr_usd actual — es una aproximación documentada porque no
// guardamos historial de precios (sub-fase futura: tabla plan_prices_history
// + tenants.plan_history). Sirve para visualizar la tendencia de crecimiento
// (forma de la curva), NO para reporting financiero exacto retroactivo.
//
// Implementación: una sola query agrupa (día, plan, custom_mrr_usd) — el
// universo de pares distintos es chico (≤4 planes × N enterprise distintos)
// y getTenantMrr() en Node consolida la lógica de pricing en un solo lugar.
// ──────────────────────────────────────────────────────────────────────────
router.get('/metrics/history', async (_req, res, next) => {
  try {
    const data = await db.adminQuery(async (client) => {
      // Query 1: signups + suspensions diarias (igual que antes).
      const { rows: dailyRows } = await client.query(`
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

      // Query 2: tenants activos por día agrupados por (plan, custom_mrr_usd).
      // CROSS JOIN días × tenants filtrado por las 3 condiciones de "activo en
      // ese día". Postgres lo resuelve eficientemente con merge join sobre el
      // pequeño universo de tenants. Para 30 tenants × 90 días = 2700 evaluaciones,
      // ridículo. Si llegamos a 5000 tenants × 90 días = 450k, agregamos índice
      // funcional o particionamos por mes.
      const { rows: mrrBreakdown } = await client.query(`
        WITH days AS (
          SELECT generate_series(
            CURRENT_DATE - INTERVAL '89 days',
            CURRENT_DATE,
            INTERVAL '1 day'
          )::date AS d
        )
        SELECT
          d.d::text AS date,
          t.plan,
          t.custom_mrr_usd,
          COUNT(*)::int AS cnt
          FROM days d
          JOIN tenants t ON
                t.created_at::date <= d.d
            AND (t.deleted_at IS NULL OR t.deleted_at::date > d.d)
            AND (t.suspended_at IS NULL OR t.suspended_at::date > d.d)
         GROUP BY d.d, t.plan, t.custom_mrr_usd
      `);

      // Consolidar MRR por día en JS — getTenantMrr() es la fuente única de
      // verdad para el cálculo y queremos que el endpoint use exactamente la
      // misma fórmula que /metrics (el current MRR del KPI). Si en el futuro
      // hay una promoción que descuenta X% sobre el price del plan, vive ahí.
      const mrrByDay = new Map();
      for (const r of mrrBreakdown) {
        const prev = mrrByDay.get(r.date) || 0;
        mrrByDay.set(r.date, prev + getTenantMrr(r.plan, r.custom_mrr_usd) * r.cnt);
      }

      // Merge: el array final tiene exactamente N=90 elementos (uno por día
      // continuo). Si un día no aparece en mrrByDay (no había tenants) ponemos
      // 0 — la gráfica muestra "valle" honesto y no NaN.
      const history = dailyRows.map((row) => ({
        date: row.date,
        signups: row.signups,
        suspensions: row.suspensions,
        mrr_usd: Math.round((mrrByDay.get(row.date) || 0) * 100) / 100,
      }));

      return { history };
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

// ──────────────────────────────────────────────────────────────────────────
// GET /facturacion — dashboard de facturación y cobros del SaaS Tecny.
//
// 2026-07-15 v2 (task #131): reescrito para reflejar la REALIDAD del cobro
// manual. Antes (v1) generaba facturas mock por hash — se veía vacío porque
// muchos tenants están en trial (monto=0) y quedaban skipeados, o los
// plan_prices estaban en 0. Peor aún, mostraba estados inventados (Pagada /
// Pendiente / Fallida) que no correspondían a nada real.
//
// Ahora: lista TODOS los tenants (incluyendo suspendidos, excepto soft-
// deleted) y deriva el ESTADO REAL de la cuenta a partir de los campos que
// ya usamos en Ficha de cliente:
//
//   Estado canónico              Condición
//   ────────────────────────     ──────────────────────────────────────────
//   suspendida                   suspended_at IS NOT NULL
//   trial                        plan='trial' AND (trial_until IS NULL OR
//                                                  trial_until >= NOW)
//   trial_vencido                plan='trial' AND trial_until < NOW
//   sin_config                   plan!='trial' AND paid_until IS NULL
//                                (ej. onboarding legacy o grandfathered)
//   al_dia                       plan!='trial' AND paid_until >= NOW
//   vencida                      plan!='trial' AND paid_until < NOW
//
// KPIs redefinidos con semántica honesta:
//   · mrr_usd: suma de MRR de tenants NO suspendidos con plan pago.
//   · al_dia_count / al_dia_usd: tenants con paid_until vigente.
//   · vencidos_count / vencidos_usd: tenants con paid_until vencida.
//   · trials_count: tenants en trial (vigente + vencido).
//   · trials_por_vencer_7d: trials cuyo trial_until <= NOW+7d (early warning).
//
// Cuando integremos billing real (Stripe/MP con webhooks), este endpoint
// puede coexistir con /facturas — /facturacion sigue siendo el "estado de
// cuenta" y /facturas será el histórico transaccional.
// ──────────────────────────────────────────────────────────────────────────

// Deriva el estado canónico desde los campos raw del tenant. Función pura,
// testeable, sin acceso a DB — todos los inputs son campos ya leídos.
// Los estados están priorizados: suspendida gana sobre todo lo demás.
function _facturacionEstadoTenant(t, now) {
  if (t.suspended_at) return 'suspendida';
  if (t.plan === 'trial') {
    if (t.trial_until && new Date(t.trial_until) < now) return 'trial_vencido';
    return 'trial';
  }
  // Plan pago (starter/pro/enterprise).
  if (!t.paid_until) return 'sin_config';
  if (new Date(t.paid_until) < now) return 'vencida';
  return 'al_dia';
}

// Mapa plan canónico → label display capitalizado. El schema de Tecny
// soporta exactamente estos 4: trial | starter | pro | enterprise.
// Confirmado por Lucas 2026-07-15: no hay más planes, no se agrega
// "negocio" ni ninguna otra variante.
const _FACTURACION_PLAN_LABEL = {
  trial:      'Trial',
  starter:    'Starter',
  pro:        'Pro',
  enterprise: 'Enterprise',
};

router.get('/facturacion', async (_req, res, next) => {
  try {
    const data = await db.adminQuery(async (client) => {
      // Todos los tenants NO soft-deleted. Incluimos suspendidos a propósito
      // — son parte del "estado de cuenta" y aparecen con badge Suspendida
      // (sin contribuir al MRR). LEFT JOIN a payment_methods para traer el
      // nombre del método asignado (task #132 2026-07-15).
      const { rows: tenants } = await client.query(`
        SELECT t.id, t.nombre, t.plan, t.custom_mrr_usd,
               t.created_at, t.paid_until, t.trial_until,
               t.suspended_at, t.suspended_reason,
               t.metodo_pago_id,
               pm.nombre AS metodo_pago_nombre
          FROM tenants t
          LEFT JOIN payment_methods pm ON pm.id = t.metodo_pago_id
         WHERE t.deleted_at IS NULL
         ORDER BY t.id ASC
      `);

      // Lista de métodos ACTIVOS para popular el dropdown de asignación.
      // Los inactivos no se ofrecen para nuevas asignaciones (pero un tenant
      // ya asignado a uno inactivo sigue mostrándolo en su fila).
      const { rows: metodos_disponibles } = await client.query(`
        SELECT id, nombre
          FROM payment_methods
         WHERE activo = true
         ORDER BY orden ASC, LOWER(nombre) ASC
      `);

      const now = new Date();
      const in7d = new Date(now.getTime() + 7 * 86400000);

      let mrr_total_usd = 0;
      let al_dia_count = 0, al_dia_usd = 0;
      let vencidos_count = 0, vencidos_usd = 0;
      let trials_count = 0, trials_por_vencer_7d = 0;
      let suspendidos_count = 0;
      let sin_config_count = 0;

      const clientes = [];

      for (const t of tenants) {
        const estado = _facturacionEstadoTenant(t, now);
        const monto = getTenantMrr(t.plan, t.custom_mrr_usd);

        // MRR incluye tenants con plan pago no suspendidos, aunque estén
        // vencidos — refleja el MRR "contratado" incluso si el cobro está
        // atrasado. Este es el mismo criterio que usa /metrics.
        if (t.plan !== 'trial' && !t.suspended_at) {
          mrr_total_usd += monto;
        }

        if (estado === 'suspendida') suspendidos_count++;
        else if (estado === 'trial' || estado === 'trial_vencido') {
          trials_count++;
          if (t.trial_until && new Date(t.trial_until) <= in7d) {
            trials_por_vencer_7d++;
          }
        } else if (estado === 'al_dia') {
          al_dia_count++;
          al_dia_usd += monto;
        } else if (estado === 'vencida') {
          vencidos_count++;
          vencidos_usd += monto;
        } else if (estado === 'sin_config') {
          sin_config_count++;
        }

        // Fecha de referencia para mostrar: paid_until para planes pagos
        // (próximo cobro), trial_until para trials (fecha de expiración).
        const fecha_referencia = t.plan === 'trial' ? t.trial_until : t.paid_until;

        clientes.push({
          id: t.id,
          tenant_id: t.id,
          tenant_nombre: t.nombre,
          plan: t.plan,
          plan_label: _FACTURACION_PLAN_LABEL[t.plan] || t.plan,
          monto_usd: monto,
          fecha_referencia: fecha_referencia
            ? new Date(fecha_referencia).toISOString()
            : null,
          estado,
          suspended_reason: t.suspended_reason || null,
          metodo_pago_id: t.metodo_pago_id,
          metodo_pago_nombre: t.metodo_pago_nombre || null,
        });
      }

      // Orden: los que necesitan atención primero (vencidos > sin_config >
      // trial_vencido > trial > al_dia > suspendidos). Dentro de cada estado,
      // por fecha_referencia asc (más urgente primero) — así los trials que
      // vencen mañana quedan arriba de los que vencen en 3 meses.
      const orden = {
        vencida: 0, sin_config: 1, trial_vencido: 2,
        trial: 3, al_dia: 4, suspendida: 5,
      };
      clientes.sort((a, b) => {
        const oa = orden[a.estado] ?? 99;
        const ob = orden[b.estado] ?? 99;
        if (oa !== ob) return oa - ob;
        // Dentro del mismo estado: nulls al final, sino asc por fecha.
        if (!a.fecha_referencia && !b.fecha_referencia) return a.tenant_nombre.localeCompare(b.tenant_nombre);
        if (!a.fecha_referencia) return 1;
        if (!b.fecha_referencia) return -1;
        return a.fecha_referencia.localeCompare(b.fecha_referencia);
      });

      return {
        kpis: {
          mrr_usd: Math.round(mrr_total_usd * 100) / 100,
          al_dia_count,
          al_dia_usd: Math.round(al_dia_usd * 100) / 100,
          vencidos_count,
          vencidos_usd: Math.round(vencidos_usd * 100) / 100,
          trials_count,
          trials_por_vencer_7d,
          suspendidos_count,
          sin_config_count,
          total_clientes: tenants.length,
        },
        clientes,
        metodos_disponibles,
      };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Métodos de pago maestros (task #132, 2026-07-15).
//
// CRUD para la lista global editable de métodos de pago. Cada tenant puede
// tener uno asignado (tenants.metodo_pago_id → payment_methods.id). Se
// consumen desde la pantalla /facturacion:
//   · Modal "Métodos de pago" (botón del header): CRUD sobre esta tabla.
//   · Dropdown inline en cada fila: asigna un método a un tenant específico
//     vía PATCH /tenants/:id/metodo-pago.
//
// Soft-delete via `activo=false`: mantiene tenants ya asignados con el
// nombre visible, pero saca la opción del dropdown. Hard-delete solo si
// nadie lo está usando (chequeo en el endpoint DELETE, no en la DB).
// ──────────────────────────────────────────────────────────────────────────

// GET /payment-methods → lista completa (activos + inactivos) con conteo
// de tenants usando cada uno. Ordenada por `orden` asc, después por nombre.
router.get('/payment-methods', async (_req, res, next) => {
  try {
    const data = await db.adminQuery(async (client) => {
      const { rows } = await client.query(`
        SELECT pm.id, pm.nombre, pm.activo, pm.orden,
               pm.created_at, pm.updated_at,
               (SELECT COUNT(*)::int FROM tenants t
                 WHERE t.metodo_pago_id = pm.id AND t.deleted_at IS NULL) AS en_uso
          FROM payment_methods pm
         ORDER BY pm.orden ASC, LOWER(pm.nombre) ASC
      `);
      return { payment_methods: rows };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /payment-methods { nombre } → crear.
// nombre trimmed, no vacío. Unicidad case-insensitive garantizada por index.
router.post('/payment-methods', async (req, res, next) => {
  try {
    const nombre = String(req.body?.nombre || '').trim();
    if (!nombre) {
      return res.status(400).json({ error: 'El nombre es requerido.' });
    }
    if (nombre.length > 50) {
      return res.status(400).json({ error: 'El nombre no puede tener más de 50 caracteres.' });
    }
    const data = await db.adminQuery(async (client) => {
      // Orden = último + 10 (dejamos espacios por si Lucas quiere reordenar
      // en el futuro sin recalcular todo).
      const { rows: maxRows } = await client.query(
        `SELECT COALESCE(MAX(orden), 0) + 10 AS next_orden FROM payment_methods`
      );
      const nextOrden = maxRows[0].next_orden;
      try {
        const { rows } = await client.query(
          `INSERT INTO payment_methods (nombre, orden)
                VALUES ($1, $2)
             RETURNING id, nombre, activo, orden, created_at, updated_at,
                       0::int AS en_uso`,
          [nombre, nextOrden]
        );
        return rows[0];
      } catch (err) {
        // 23505 = unique_violation → nombre duplicado (case-insensitive).
        if (err.code === '23505') {
          const e = new Error('Ya existe un método con ese nombre.');
          e.statusCode = 409;
          throw e;
        }
        throw err;
      }
    });
    res.status(201).json(data);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// PATCH /payment-methods/:id { nombre?, activo?, orden? } → edición parcial.
// Devuelve 404 si no existe. 409 si el nombre choca con otro método.
router.patch('/payment-methods/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = [];
    const params = [];

    if (req.body?.nombre !== undefined) {
      const nombre = String(req.body.nombre || '').trim();
      if (!nombre) return res.status(400).json({ error: 'El nombre no puede ser vacío.' });
      if (nombre.length > 50) return res.status(400).json({ error: 'El nombre no puede tener más de 50 caracteres.' });
      params.push(nombre);
      updates.push(`nombre = $${params.length}`);
    }
    if (req.body?.activo !== undefined) {
      params.push(!!req.body.activo);
      updates.push(`activo = $${params.length}`);
    }
    if (req.body?.orden !== undefined) {
      const orden = Number(req.body.orden);
      if (!Number.isInteger(orden)) return res.status(400).json({ error: 'Orden debe ser un entero.' });
      params.push(orden);
      updates.push(`orden = $${params.length}`);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nada para actualizar (nombre/activo/orden).' });
    }
    updates.push('updated_at = NOW()');
    params.push(id);

    const data = await db.adminQuery(async (client) => {
      try {
        const { rows } = await client.query(
          `UPDATE payment_methods
              SET ${updates.join(', ')}
            WHERE id = $${params.length}
            RETURNING id, nombre, activo, orden, created_at, updated_at,
                      (SELECT COUNT(*)::int FROM tenants t
                        WHERE t.metodo_pago_id = payment_methods.id AND t.deleted_at IS NULL) AS en_uso`,
          params
        );
        return rows[0] || null;
      } catch (err) {
        if (err.code === '23505') {
          const e = new Error('Ya existe otro método con ese nombre.');
          e.statusCode = 409;
          throw e;
        }
        throw err;
      }
    });
    if (!data) return res.status(404).json({ error: 'Método de pago no encontrado.' });
    res.json(data);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// DELETE /payment-methods/:id → hard-delete solo si en_uso=0.
// Si hay tenants usándolo, devolvemos 409 con hint — el operador debe primero
// reasignar/desasignar esos tenants (o soft-delete vía PATCH activo=false).
router.delete('/payment-methods/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const data = await db.adminQuery(async (client) => {
      const { rows: uso } = await client.query(
        `SELECT COUNT(*)::int AS en_uso FROM tenants
          WHERE metodo_pago_id = $1 AND deleted_at IS NULL`,
        [id]
      );
      if (uso[0].en_uso > 0) {
        const e = new Error(
          `No se puede eliminar: ${uso[0].en_uso} cliente(s) lo tienen asignado. ` +
          `Reasignalos primero o desactivá el método (soft-delete).`
        );
        e.statusCode = 409;
        throw e;
      }
      const { rowCount } = await client.query(
        `DELETE FROM payment_methods WHERE id = $1`,
        [id]
      );
      return { deleted: rowCount };
    });
    if (data.deleted === 0) return res.status(404).json({ error: 'Método de pago no encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// PATCH /tenants/:id/metodo-pago { metodo_pago_id } → asigna (o desasigna
// con null). Valida que el método exista y esté activo (evita asignar a
// uno inactivo desde la UI vieja/cache stale).
router.patch('/tenants/:id/metodo-pago', async (req, res, next) => {
  try {
    const tenantId = Number(req.params.id);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: 'tenant_id inválido.' });
    }
    const rawId = req.body?.metodo_pago_id;
    const metodoId = rawId === null || rawId === undefined || rawId === '' ? null : String(rawId);

    const data = await db.adminQuery(async (client) => {
      if (metodoId) {
        const { rows: check } = await client.query(
          `SELECT id, activo FROM payment_methods WHERE id = $1`,
          [metodoId]
        );
        if (check.length === 0) {
          const e = new Error('El método de pago no existe.');
          e.statusCode = 404;
          throw e;
        }
        if (!check[0].activo) {
          const e = new Error('No se puede asignar un método inactivo. Reactivalo primero.');
          e.statusCode = 409;
          throw e;
        }
      }
      const { rows } = await client.query(
        `UPDATE tenants
            SET metodo_pago_id = $1
          WHERE id = $2 AND deleted_at IS NULL
          RETURNING id, metodo_pago_id,
                    (SELECT nombre FROM payment_methods WHERE id = $1) AS metodo_pago_nombre`,
        [metodoId, tenantId]
      );
      return rows[0] || null;
    });
    if (!data) return res.status(404).json({ error: 'Tenant no encontrado.' });
    res.json(data);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Release notes / novedades (task #141, 2026-07-16).
//
// CRUD para el sistema de comunicación de cambios/features al cliente final.
// El super-admin (Lucas) crea/edita/borra notas desde admin-frontend. Los
// tenants las consumen en /novedades del portal con badge de "N no vistas"
// en el sidebar.
//
// Formato: título corto (max 60) + descripción tipo tweet (max 280) + tipo
// (feature | mejora | fix) + fecha de publicación (default NOW).
//
// Sin RLS — las notas son globales, mismas para todos los tenants.
// ──────────────────────────────────────────────────────────────────────────

const RELEASE_NOTE_TIPOS = ['feature', 'mejora', 'fix'];

function _validateReleaseNoteBody(body, { partial = false } = {}) {
  const errors = {};
  const t = body?.titulo != null ? String(body.titulo).trim() : undefined;
  const d = body?.descripcion != null ? String(body.descripcion).trim() : undefined;
  const tipo = body?.tipo != null ? String(body.tipo).trim() : undefined;
  const publicado_en = body?.publicado_en;

  if (!partial || t !== undefined) {
    if (!t) errors.titulo = 'El título es requerido.';
    else if (t.length > 60) errors.titulo = 'Máximo 60 caracteres.';
  }
  if (!partial || d !== undefined) {
    if (!d) errors.descripcion = 'La descripción es requerida.';
    else if (d.length > 280) errors.descripcion = 'Máximo 280 caracteres.';
  }
  if (!partial || tipo !== undefined) {
    if (!tipo || !RELEASE_NOTE_TIPOS.includes(tipo)) {
      errors.tipo = `Tipo inválido. Valores: ${RELEASE_NOTE_TIPOS.join(', ')}.`;
    }
  }
  if (publicado_en !== undefined && publicado_en !== null) {
    // Aceptamos ISO 8601 o el string vacío = usar default (NOW).
    if (typeof publicado_en !== 'string' || (publicado_en && isNaN(Date.parse(publicado_en)))) {
      errors.publicado_en = 'Fecha inválida (usar ISO 8601 o omitir para NOW).';
    }
  }
  return Object.keys(errors).length ? errors : null;
}

// GET /release-notes → lista todas ordenada por publicado_en DESC.
router.get('/release-notes', async (_req, res, next) => {
  try {
    const data = await db.adminQuery(async (client) => {
      const { rows } = await client.query(`
        SELECT id, titulo, descripcion, tipo, publicado_en, created_at, updated_at
          FROM release_notes
         ORDER BY publicado_en DESC
      `);
      return { release_notes: rows };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /release-notes { titulo, descripcion, tipo, publicado_en? } → crear.
router.post('/release-notes', async (req, res, next) => {
  try {
    const errors = _validateReleaseNoteBody(req.body);
    if (errors) return res.status(400).json({ error: 'Validación falló.', fields: errors });

    const { titulo, descripcion, tipo, publicado_en } = req.body;
    const data = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO release_notes (titulo, descripcion, tipo, publicado_en)
              VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))
           RETURNING id, titulo, descripcion, tipo, publicado_en, created_at, updated_at`,
        [String(titulo).trim(), String(descripcion).trim(), tipo, publicado_en || null]
      );
      return rows[0];
    });
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

// PATCH /release-notes/:id { titulo?, descripcion?, tipo?, publicado_en? } → edición parcial.
router.patch('/release-notes/:id', async (req, res, next) => {
  try {
    const errors = _validateReleaseNoteBody(req.body, { partial: true });
    if (errors) return res.status(400).json({ error: 'Validación falló.', fields: errors });

    const { id } = req.params;
    const updates = [];
    const params = [];

    if (req.body.titulo !== undefined)      { params.push(String(req.body.titulo).trim());      updates.push(`titulo = $${params.length}`); }
    if (req.body.descripcion !== undefined) { params.push(String(req.body.descripcion).trim()); updates.push(`descripcion = $${params.length}`); }
    if (req.body.tipo !== undefined)        { params.push(req.body.tipo);                       updates.push(`tipo = $${params.length}`); }
    if (req.body.publicado_en !== undefined){ params.push(req.body.publicado_en || null);       updates.push(`publicado_en = $${params.length}::timestamptz`); }

    if (updates.length === 0) return res.status(400).json({ error: 'Nada para actualizar.' });
    updates.push('updated_at = NOW()');
    params.push(id);

    const data = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `UPDATE release_notes SET ${updates.join(', ')}
          WHERE id = $${params.length}
          RETURNING id, titulo, descripcion, tipo, publicado_en, created_at, updated_at`,
        params
      );
      return rows[0] || null;
    });
    if (!data) return res.status(404).json({ error: 'Release note no encontrada.' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// DELETE /release-notes/:id → hard-delete (no soft — el histórico no importa
// para este dominio: si Lucas la borra es porque fue un typo o duplicado).
router.delete('/release-notes/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const data = await db.adminQuery(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM release_notes WHERE id = $1`,
        [id]
      );
      return { deleted: rowCount };
    });
    if (data.deleted === 0) return res.status(404).json({ error: 'Release note no encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /tenants/:id/pais — cambiar el país de un tenant existente (#473).
//
// Use case que motiva el endpoint: cliente UY que signupeó pre-F4 cuando el
// selector de país aún no existía. Todos los tenants creados antes del
// 2026-06-29 quedaron con pais='AR' por el backfill de la migration
// 20260629100001. El owner UY necesita operar en UYU pero las cajas seedeadas
// son ARS y la alerta TC está calibrada a ~1400 (vs ~40 que tiene sentido UY).
//
// Decisión durable (design doc multi-pais-uyu.md §9.1): `tenant.pais` es
// inmutable desde la UI normal. Solo super-admin puede cambiarlo, y deja
// audit trail. NO existe endpoint público (ni admin-of-tenant) — exclusivo
// del back office.
//
// Side effects atomizados en una sola tx admin:
//   1. UPDATE tenants.pais (con guard "mismo país" → 400 same_country).
//   2. Crear cajas default del país NUEVO sin borrar las viejas. El operador
//      del tenant puede limpiar las que no le sirvan después. Guard contra
//      duplicados (si por algún motivo ya existe una caja con el mismo
//      nombre+moneda, no insertamos esa fila, las demás sí).
//   3. UPDATE alerta TC referencia al valor por defecto del país nuevo
//      (UY=40, AR=1400). Solo si la fila existe (todos los tenants post-F2
//      la tienen seedeada; tenants viejos pre-F2 no, en cuyo caso el UPDATE
//      es no-op).
//   4. invalidateTenantStatus(tenantId) — el helper de F2 cachea
//      pais/suspended/paid_until en Redis. Sin invalidar, la próxima request
//      del owner del tenant podría seguir viendo `pais=viejo` hasta TTL.
//   5. Audit a tenant_admin_actions con action='tenant_pais_changed', payload
//      con before/after del país. SAVEPOINT pattern (PR-C B4 #462) por si la
//      migration del CHECK no corrió todavía — no abortamos toda la tx por
//      un audit failure, solo warning.
//
// Guards previos al UPDATE:
//   - requireSuperAdmin middleware (gate principal).
//   - Zod `.strict()` rechaza body extra (no aceptamos `reason` por ahora).
//   - 404 si tenant no existe o está soft-deleted.
//   - 409 has_active_partnerships si el tenant tiene partnerships Red B2B
//     activas. Cambiar el país de un tenant con vínculo vivo a otro podría
//     generar operaciones cross-tenant en moneda no soportada por uno de
//     los lados — preferimos forzar al operador a revocar partnerships
//     antes (decisión manual + audit trail explícito en cada revoke).
//   - 400 same_country si pais_nuevo === pais_actual (no-op = error explícito
//     para que el frontend no muestre "todo OK" cuando no pasó nada).
//
// Response shape mantiene el patrón de otros endpoints destructivos: tenant_id
// + before/after del campo + summary de side-effects. Útil para que el
// frontend muestre "Se crearon N cajas + alerta TC actualizada" sin tener que
// re-fetchear todo.
// ──────────────────────────────────────────────────────────────────────────
router.patch('/tenants/:id/pais', validate(changePaisSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const { pais: paisNuevo } = req.body;

    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // 1. Lock + read estado actual. FOR UPDATE serializa contra otros
        //    PATCH/POST sobre el mismo tenant (e.g. concurrent suspend).
        const beforeRow = await client.query(
          `SELECT id, pais, suspended_at
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

        // 2. Guard mismo país. Si paisNuevo === before.pais el operador
        //    seguramente se equivocó — preferimos 400 explícito vs no-op
        //    silencioso (que daría falsa señal de éxito).
        if (before.pais === paisNuevo) {
          await client.query('ROLLBACK');
          return { sameCountry: true, pais: before.pais };
        }

        // 2b. Guard tenant suspendido. Operar sobre un tenant bloqueado no
        //     debería ser posible — además de coherencia con otros endpoints
        //     destructivos, evita que cambiemos país de un tenant que está
        //     por ser eliminado y dejar audit confuso.
        if (before.suspended_at) {
          await client.query('ROLLBACK');
          return { suspended: true };
        }

        // 3. Guard partnerships activas. Si el tenant participa en al menos
        //    una partnership Red B2B `active`, abortamos. El operador debe
        //    revocar primero — el cambio de país afecta la moneda local que
        //    se usa en operaciones cross-tenant, mezclar AR↔UY en una
        //    partnership activa rompería el modelo de pagos multi-divisa.
        const partsRow = await client.query(
          `SELECT 1 FROM tenant_partnerships
            WHERE (tenant_a_id = $1 OR tenant_b_id = $1)
              AND status = 'active'
            LIMIT 1`,
          [id]
        );
        if (partsRow.rowCount > 0) {
          await client.query('ROLLBACK');
          return { activePartnerships: true };
        }

        // 4. UPDATE tenant.pais. RETURNING pais para confirmar y devolver
        //    al cliente.
        const upd = await client.query(
          `UPDATE tenants SET pais = $1 WHERE id = $2 RETURNING pais`,
          [paisNuevo, id]
        );
        const paisAnterior = before.pais;

        // 5. Crear cajas default del país nuevo. Reusamos
        //    getDefaultCajasPorPais para single source of truth con signup.
        //    No borramos las viejas (el operador del tenant decide qué
        //    limpiar). Guard contra duplicados por (nombre, moneda) — usamos
        //    NOT EXISTS en el INSERT, simple y race-safe bajo FOR UPDATE.
        //
        //    Nota RLS: metodos_pago tiene FORCE RLS. El pool admin
        //    (BYPASSRLS) no necesita SET LOCAL app.current_tenant, pero
        //    pasamos tenant_id explícito en cada INSERT para evitar
        //    accidentes si alguien refactorea el pool más adelante.
        // El UNIQUE INDEX `(tenant_id, LOWER(nombre)) WHERE deleted_at IS NULL`
        // (migration 20260616000006) hace que dos cajas no puedan compartir
        // nombre — sin importar la moneda. Las defaults de signup usan los
        // mismos nombres entre AR y UY ("Efectivo Pesos", "Banco Pesos") y
        // un tenant AR ya tiene esas cajas en ARS. Si quisiéramos crear
        // "Efectivo Pesos" en UYU, chocaría con el UNIQUE.
        //
        // Decisión: las cajas nuevas creadas por "cambiar país" llevan
        // sufijo `(<pais>)` en el nombre para distinguirlas visualmente +
        // evadir el UNIQUE constraint. "Efectivo Pesos (UY)", "Banco Pesos (UY)",
        // "Efectivo USD (UY)". El operador puede renombrarlas y borrar las
        // viejas a discreción.
        //
        // Excepción: si por algún motivo la caja sufijada ya existe (re-run,
        // operador la creó a mano), salteamos con NOT EXISTS — el endpoint
        // se vuelve idempotente para esta sección.
        // Guard adicional: el UNIQUE INDEX idx_metodos_pago_financiera
        // (migration 20260616000005) permite SOLO UNA caja con
        // es_financiera=true por tenant. Como el tenant viejo ya tiene su
        // caja financiera marcada (default de signup), las nuevas cajas
        // creadas por el cambio de país nunca deben llevar es_financiera=true
        // — sino reventaría el INSERT. El operador puede re-flagear
        // manualmente desde la UI de Cajas si quiere desplazar la financiera.
        const cajasDelPaisNuevo = getDefaultCajasPorPais(paisNuevo);
        let cajasCreadas = 0;
        for (const caja of cajasDelPaisNuevo) {
          const nombreSufijado = `${caja.nombre} (${paisNuevo})`;
          const ins = await client.query(
            `INSERT INTO metodos_pago (nombre, moneda, orden, es_financiera, tenant_id)
               SELECT $1, $2, $3, false, $4
                WHERE NOT EXISTS (
                  SELECT 1 FROM metodos_pago
                   WHERE tenant_id = $4
                     AND LOWER(nombre) = LOWER($1)
                     AND deleted_at IS NULL
                )`,
            [nombreSufijado, caja.moneda, caja.orden, id]
          );
          if (ins.rowCount > 0) cajasCreadas += 1;
        }

        // 6. Actualizar alerta tc_referencia al default del país nuevo.
        //    Usamos jsonb_set para preservar las otras claves del parametros
        //    (tolerancia_pct, alerta_por_debajo, etc.). Solo aplica si la
        //    fila existe — tenants pre-F2 que no la tienen quedan como
        //    estaban (el operador puede configurar manualmente desde la UI
        //    de alertas).
        const tcValor = paisNuevo === 'UY' ? 40 : 1400;
        const alertaUpd = await client.query(
          `UPDATE alertas_config
              SET parametros = jsonb_set(parametros, '{valor}', $1::jsonb, true),
                  updated_at = NOW()
            WHERE tenant_id = $2 AND tipo = 'tc_referencia'`,
          [String(tcValor), id]
        );
        const alertaActualizada = alertaUpd.rowCount > 0;

        // 7. Invalidar el cache de tenantStatus. Lo hacemos DENTRO de la
        //    tx para mantener ordering simple — si la tx rollback-ea por un
        //    error posterior, el siguiente getTenantStatus repobla el cache
        //    con el estado real (pais viejo). El cost de un cache miss
        //    extra es despreciable vs riesgo de cache stale.
        await invalidateTenantStatus(id);

        // 7b. #501 hotfix — forzar re-login de todos los users del tenant.
        //
        //   Problema: el cambio de país modifica `tenant.pais` en DB, pero
        //   el frontend guarda `user.tenant.pais` en memoria desde la sesión
        //   que abrió ANTES del cambio. Sin forzar re-login, el owner del
        //   tenant sigue viendo dropdowns con las monedas viejas hasta que
        //   cierre sesión manualmente. Cliente Uruguay (tenant 17) lo reportó
        //   2026-07-01 tras el cambio del 2026-06-30 — sigue viendo ARS.
        //
        //   Solución: bumpear `users.password_changed_at` para todos los
        //   users vivos del tenant. El middleware requireAuth compara
        //   `jwt.iat >= users.password_changed_at`: con el bump, todos los
        //   JWT preexistentes quedan invalidados → 401 → auto-logout en
        //   el frontend → login fresco con /me que trae `pais` nuevo.
        //
        //   Trade-off: los users que estaban trabajando pierden la sesión
        //   sin previo aviso. Aceptable porque (a) es una operación rara
        //   (cambio de país es one-time por tenant en la práctica); (b) el
        //   super-admin sabe que va a interrumpir sesiones; (c) alternativa
        //   (dejarlos con dropdowns viejos) tiene peor UX y correctness.
        //
        //   Cache Redis: hay que invalidar userAuthCache por cada user
        //   (cachea password_changed_at TTL 60s). Sin invalidar, el bump
        //   en DB queda pero el middleware sigue leyendo el cache stale
        //   hasta TTL — los users siguen "logueados" hasta 60s.
        const bumpResult = await client.query(
          `UPDATE users u
              SET password_changed_at = NOW()
             FROM tenant_users tu
            WHERE tu.tenant_id = $1
              AND tu.user_id = u.id
              AND u.deleted_at IS NULL
            RETURNING u.id`,
          [id]
        );
        const usersInvalidados = bumpResult.rows.length;
        // Cache invalidation por user. Best-effort: si Redis está caído
        // no abortamos la tx (el bump en DB es la source-of-truth; a lo sumo
        // los users tardan 60s extra en desloguearse). Wrapping en
        // Promise.all fuera del await de cada uno serializa I/O.
        await Promise.all(
          bumpResult.rows.map((r) =>
            invalidateUserAuth(r.id).catch((err) => {
              logger.warn(
                { userId: r.id, tenantId: id, err: err.message },
                '[super-admin/#473] invalidateUserAuth fallo — TTL 60s se hará cargo'
              );
            })
          )
        );

        // 8. Audit log. SAVEPOINT pattern para que un CHECK constraint sin
        //    la action nueva (e.g. migration sin correr todavía en staging)
        //    no abote la tx — preservamos la operación con warning.
        await client.query('SAVEPOINT sp_audit');
        try {
          await insertAdminAction(client, {
            tenantId: id,
            superAdminUserId: req.user.id,
            action: 'tenant_pais_changed',
            beforeState: { pais: paisAnterior },
            afterState:  { pais: paisNuevo },
            reason: null,
          });
          await client.query('RELEASE SAVEPOINT sp_audit');
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT sp_audit').catch(() => {});
          if (err.code === '23514') {
            logger.warn(
              { action: 'tenant_pais_changed', tenant_id: id, err: err.message },
              '[super-admin/#473] audit action no permitida en CHECK — migration pendiente? (continuando sin abortar tx)'
            );
          } else {
            throw err;
          }
        }

        await client.query('COMMIT');
        return {
          tenantId: id,
          paisAnterior,
          paisNuevo: upd.rows[0].pais,
          cajasCreadas,
          alertaActualizada,
          usersInvalidados,
        };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
        throw err;
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }
    if (result.suspended) {
      return res.status(400).json({
        error: 'No se puede cambiar el país de un tenant suspendido',
        code: 'tenant_suspended',
      });
    }
    if (result.sameCountry) {
      return res.status(400).json({
        error: `El tenant ya tiene país ${result.pais}`,
        code: 'same_country',
        detail: { pais: result.pais },
      });
    }
    if (result.activePartnerships) {
      return res.status(409).json({
        error: 'El tenant tiene partnerships Red B2B activas. Revocá las partnerships antes de cambiar el país.',
        code: 'has_active_partnerships',
      });
    }

    logger.info(
      {
        tenant_id: result.tenantId,
        super_admin: req.user.id,
        pais_anterior: result.paisAnterior,
        pais_nuevo: result.paisNuevo,
        cajas_creadas: result.cajasCreadas,
        alerta_actualizada: result.alertaActualizada,
        users_invalidados: result.usersInvalidados,
      },
      '[super-admin/#473] PATCH /tenants/:id/pais'
    );

    res.json({
      tenant_id: result.tenantId,
      pais_anterior: result.paisAnterior,
      pais_nuevo: result.paisNuevo,
      side_effects: {
        cajas_creadas: result.cajasCreadas,
        alerta_actualizada: result.alertaActualizada,
        users_invalidados: result.usersInvalidados,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── #475: PATCH tenant.comprobante_email_footer ──────────────────────────
//
// El super-admin setea el footer custom plain-text para los emails de
// comprobante de venta retail del tenant. Body: { footer: string|null }.
// Plain-text obligatorio (XSS protection — el render escapa antes de inyectar
// en el HTML del email).
//
// Diseño minimalista:
//   - Sin lock FOR UPDATE: el footer no participa de ningún invariante con
//     otras columnas, no requiere serialización pesada. UPDATE simple basta.
//   - Sin audit a tenant_admin_actions: el footer es una preferencia visual,
//     no una decisión comercial. El audit_logs general (via logger.info) basta.
//     Si Lucas más adelante quiere historial de cambios, agregar action al
//     CHECK + insertAdminAction (pattern de los otros endpoints).
//   - String vacío → null. La UI envía '' cuando limpian el textarea;
//     consolidamos a null para que "sin override" tenga una sola representación.
router.patch('/tenants/:id/comprobante-footer',
  validate(updateComprobanteFooterSchema),
  async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'id inválido' });
      }
      // Normalizar: '' o whitespace-only → null. El Zod ya hizo trim().
      const footerRaw = req.body.footer;
      const footer = (footerRaw === null || footerRaw === '') ? null : footerRaw;

      const result = await db.adminQuery(async (client) => {
        const { rows } = await client.query(
          `UPDATE tenants
              SET comprobante_email_footer = $1
            WHERE id = $2 AND deleted_at IS NULL
            RETURNING id, comprobante_email_footer`,
          [footer, id]
        );
        return rows[0] || null;
      });

      if (!result) {
        return res.status(404).json({ error: 'Tenant no encontrado' });
      }

      logger.info(
        {
          tenant_id: id,
          super_admin: req.user.id,
          footer_len: footer ? footer.length : 0,
        },
        '[super-admin/#475] PATCH /tenants/:id/comprobante-footer'
      );

      res.json({
        tenant_id: id,
        comprobante_email_footer: result.comprobante_email_footer,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// CMS Landing Fase 1 — configuración del sitio público tecnyapp.com
//
// 2026-07-13 (feature): Lucas edita mail/WhatsApp/dirección/Instagram desde
// el admin. Los cambios aparecen en la landing en <5min (cache TTL del
// endpoint público GET /api/public/site-config).
//
// Diseño:
//   · Tabla singleton `site_landing_config` (id=1 fijo).
//   · Schema Zod normaliza strings vacíos → null en el UPDATE.
//   · Solo super-admin puede editar. Log via logger.info (feature de baja
//     frecuencia y baja criticidad — el audit_logs general basta).
//   · updated_by trackea al super-admin que hizo el cambio.
//
// Fase 2 (reseñas) y Fase 3 (footer) van a extender este endpoint con más
// campos en el mismo body — el schema es aditivo.
// ──────────────────────────────────────────────────────────────────────────
router.get('/site-config', async (_req, res, next) => {
  try {
    // Sprint 3 M4b (2026-07-20): source de reads = `content` JSONB.
    // Igual que el GET público, mantenemos la SHAPE FLAT del response
    // (contact_email, hero_headline, etc.) para NO romper el admin
    // (admin-frontend/src/pages/SitioPublico.jsx los consume por nombre
    // individual). La response shape flat es el contract público; el
    // JSONB es storage detail interno.
    const row = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT content, updated_at, updated_by
           FROM site_landing_config WHERE id = 1`
      );
      return rows[0] || null;
    });
    if (!row) return res.json({});

    const c = row.content || {};
    // Reconstruimos el shape flat que el admin espera.
    res.json({
      // Contact (6 campos)
      contact_email:            c.contact?.email             ?? null,
      contact_whatsapp:         c.contact?.whatsapp          ?? null,
      contact_whatsapp_display: c.contact?.whatsapp_display  ?? null,
      contact_address:          c.contact?.address           ?? null,
      contact_instagram_handle: c.contact?.instagram_handle  ?? null,
      contact_instagram_url:    c.contact?.instagram_url     ?? null,
      // Arrays JSONB — pasan tal cual (ya son arrays del JSONB).
      testimonials: Array.isArray(c.testimonials) ? c.testimonials : [],
      faq:          Array.isArray(c.faq)          ? c.faq          : [],
      // Hero (3 campos) + CTA (2 campos)
      hero_headline:    c.hero?.headline    ?? null,
      hero_subheadline: c.hero?.subheadline ?? null,
      hero_blurb:       c.hero?.blurb       ?? null,
      cta_headline:     c.cta?.headline     ?? null,
      cta_body:         c.cta?.body         ?? null,
      // Feature flag — default a true si viene undefined (matchea el
      // default de la columna que teníamos antes).
      google_reviews_enabled: c.features?.google_reviews_enabled ?? true,
      // Audit fields (siguen en columnas, no en JSONB)
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/site-config',
  validate(updateSiteLandingContactSchema),
  async (req, res, next) => {
    try {
      // Sprint 3 M4c (2026-07-20): writes flipeados a `content` JSONB. El
      // PATCH ya no toca las cols legacy — actualiza `content` directo, y
      // el trigger bidireccional de la migration 20260720000002 sincroniza
      // las cols FROM content para dejar todo consistente. M4d va a hacer
      // DROP COLUMN + DROP TRIGGER una vez que M4c esté estable en prod.
      //
      // Normalización preservada:
      //   · '' → null (misma convención pre-M4c)
      //   · Testimonials + FAQ: UUIDs generados server-side para items nuevos
      const norm = (v) => (v === '' || v === undefined) ? null : v;
      const JSONB_ARRAY_FIELDS = new Set(['testimonials', 'faq']);

      // Map de "flat body field" → "path en el JSONB content". Es la
      // fuente de verdad del contract PATCH → content shape.
      // Ver también: content shape doc en migration 20260720000001.
      const FIELD_TO_JSONB_PATH = {
        contact_email:            ['contact', 'email'],
        contact_whatsapp:         ['contact', 'whatsapp'],
        contact_whatsapp_display: ['contact', 'whatsapp_display'],
        contact_address:          ['contact', 'address'],
        contact_instagram_handle: ['contact', 'instagram_handle'],
        contact_instagram_url:    ['contact', 'instagram_url'],
        hero_headline:            ['hero', 'headline'],
        hero_subheadline:         ['hero', 'subheadline'],
        hero_blurb:               ['hero', 'blurb'],
        cta_headline:             ['cta', 'headline'],
        cta_body:                 ['cta', 'body'],
        testimonials:             ['testimonials'],
        faq:                      ['faq'],
        google_reviews_enabled:   ['features', 'google_reviews_enabled'],
      };

      // Helper: set `path` en `obj` a `value`, creando containers intermedios.
      // Mutates obj — usar solo en el clone que armamos abajo.
      function setDeep(obj, path, value) {
        let cursor = obj;
        for (let i = 0; i < path.length - 1; i++) {
          const key = path[i];
          if (cursor[key] == null || typeof cursor[key] !== 'object') {
            cursor[key] = {};
          }
          cursor = cursor[key];
        }
        cursor[path[path.length - 1]] = value;
      }

      // Read-modify-write en una transacción implícita (single UPDATE). El
      // read del content actual es necesario para hacer un merge preservando
      // fields no tocados por el PATCH (partial update).
      const keys = Object.keys(req.body);
      const result = await db.adminQuery(async (client) => {
        const { rows: [current] } = await client.query(
          `SELECT content FROM site_landing_config WHERE id = 1`
        );
        // Clone defensivo para no mutar el objeto que pg devuelve.
        const newContent = JSON.parse(JSON.stringify(current?.content || {}));

        // Aplicar cada field del PATCH sobre el content.
        for (const key of keys) {
          const path = FIELD_TO_JSONB_PATH[key];
          if (!path) {
            // Field desconocido — no debería pasar (Zod ya filtró), pero
            // por defensa lo ignoramos.
            logger.warn({ field: key }, '[super-admin/site-config] field desconocido en body, ignorado');
            continue;
          }
          let value;
          if (JSONB_ARRAY_FIELDS.has(key)) {
            // Arrays: preservar id de items existentes, generar UUID nuevos.
            // Mismo comportamiento que pre-M4c pero ahora aterriza en JSONB.
            value = (req.body[key] || []).map(t => ({
              ...t,
              id: t.id || crypto.randomUUID(),
            }));
          } else {
            value = norm(req.body[key]);
          }
          setDeep(newContent, path, value);
        }

        // UPDATE atómico: solo tocamos content + audit fields. El trigger
        // bidireccional detecta que content cambió → sincroniza cols ← content
        // (para clientes legacy que aún puedan leer cols, hasta el sunset M4d).
        const { rows } = await client.query(
          `UPDATE site_landing_config
              SET content = $1::jsonb,
                  updated_at = NOW(),
                  updated_by = $2
            WHERE id = 1
            RETURNING content, updated_at, updated_by`,
          [JSON.stringify(newContent), req.user.id]
        );
        return rows[0];
      });

      logger.info(
        { super_admin: req.user.id, fields: keys },
        '[super-admin] PATCH /site-config'
      );

      // Response shape flat — matchea lo que el admin (SitioPublico.jsx)
      // espera. Idéntico al GET /site-config de arriba (misma función de
      // decompose, sería DRY-eable a un helper cuando M4c estabilice).
      const c = result?.content || {};
      res.json({
        contact_email:            c.contact?.email             ?? null,
        contact_whatsapp:         c.contact?.whatsapp          ?? null,
        contact_whatsapp_display: c.contact?.whatsapp_display  ?? null,
        contact_address:          c.contact?.address           ?? null,
        contact_instagram_handle: c.contact?.instagram_handle  ?? null,
        contact_instagram_url:    c.contact?.instagram_url     ?? null,
        testimonials: Array.isArray(c.testimonials) ? c.testimonials : [],
        faq:          Array.isArray(c.faq)          ? c.faq          : [],
        hero_headline:    c.hero?.headline    ?? null,
        hero_subheadline: c.hero?.subheadline ?? null,
        hero_blurb:       c.hero?.blurb       ?? null,
        cta_headline:     c.cta?.headline     ?? null,
        cta_body:         c.cta?.body         ?? null,
        google_reviews_enabled: c.features?.google_reviews_enabled ?? true,
        updated_at: result?.updated_at,
        updated_by: result?.updated_by,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// GET /api/super-admin/google-reviews-status
//
// 2026-07-13 (feature): status de la integración con Google Business Profile.
// Usado por la card "Reseñas de Google" del admin — muestra estado + count
// para que Lucas vea si la integración está sana antes de decidir si
// pausarla / activarla.
//
// Devuelve:
//   {
//     enabled: boolean         — flag del toggle admin (columna DB)
//     configured: boolean      — env vars API key + place_id presentes
//     count: number            — total de reseñas en Google (userRatingCount)
//     rating: number|null      — rating agregado del listing
//     reviews_visible: number  — cuántas reseñas devolvió Google (max 5)
//     cached_at: string|null   — ISO timestamp del cache backend
//     place_id: string|null    — el place_id configurado (info, no secret)
//     error: string|undefined  — si el último fetch falló
//   }
//
// Notas de seguridad:
//   · NO expone GOOGLE_PLACES_API_KEY. El place_id es info pública (aparece
//     en URLs de Google Maps), no es un secret.
//   · Consume el mismo cache in-memory que /api/public/google-reviews →
//     no genera llamadas extra a Google.
// ──────────────────────────────────────────────────────────────────────────
router.get('/google-reviews-status', async (_req, res, next) => {
  try {
    // Lee el flag del DB.
    // Sprint 3 M4b (2026-07-20): flag ahora desde content->'features'.
    // Trigger de M4a mantiene JSONB sincronizado; DROP COLUMN pendiente
    // en M4c. `->>` devuelve el bool como text — parseamos en JS.
    const dbRow = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT content->'features'->>'google_reviews_enabled' AS enabled
           FROM site_landing_config WHERE id = 1`
      );
      return rows[0] || null;
    });
    const enabled = dbRow?.enabled !== 'false'; // default true si row missing o null

    // Consume el cache del lib (mismo TTL que el endpoint público — no doble hit).
    const data = await googleReviews.getReviews();

    res.json({
      enabled,
      configured: !!data.configured,
      count: data.count || 0,
      rating: data.rating,
      reviews_visible: Array.isArray(data.reviews) ? data.reviews.length : 0,
      cached_at: data.cachedAt || null,
      // Info pública — aparece en URLs de Google Maps del negocio.
      place_id: process.env.GOOGLE_PLACES_PLACE_ID || null,
      error: data.error,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CLASES DUPLICADAS — detección + merge por tenant.
//
// 2026-07-14 (feature): cliente reportó tabs de categoría duplicadas en
// Inventario (ej. "iPads" + "ipad", "Accesorios" + "Accesorios/Varios").
// La UNIQUE constraint del schema evita duplicados EXACTOS
// (`LOWER(nombre)` case-insensitive por tenant), pero permite near-duplicates
// con distinto casing o palabras similares.
//
// Herramienta admin de 2 endpoints:
//   GET  /tenants/:id/clases-duplicadas  → detecta pares near-duplicate
//   POST /tenants/:id/clases-merge       → consolida 2 clases en 1 (atómico)
//
// Solo super-admin — es una operación correctiva sensible que puede mover
// muchos productos y cambiar la categorización visible del tenant.
// ═══════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────
// GET /tenants/:id/clases-duplicadas
//
// Detecta pares de clases (a, b) del tenant que son near-duplicates via
// `pg_trgm.similarity()` + containment (`LIKE '%X%'`).
//
// Threshold: similarity >= 0.5 OR containment. El score final expuesto al
// frontend es 1.0 si hay containment (alta confianza) o el valor de
// similarity trigram (media confianza).
//
// Response:
//   [
//     {
//       a: { id, nombre, count_productos },
//       b: { id, nombre, count_productos },
//       similarity: 0.73,          // trigram similarity case-insensitive
//       contain_kind: 'A_CONTAINS_B' | 'B_CONTAINS_A' | null,
//       score: 1.0 | similarity,   // 1.0 si hay containment, sino similarity
//       confidence: 'high' | 'medium',  // >= 0.9 → high; sino medium
//       canonica_suggested_id: uuid,    // la de más productos gana (empate → más antigua)
//     },
//     ...
//   ]
//
// pg_trgm ya está habilitado en prod (migration 20260524000006).
// ──────────────────────────────────────────────────────────────────────────
router.get('/tenants/:id/clases-duplicadas', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const rows = await db.adminQuery(async (client) => {
      // Verificar que el tenant existe (evita devolver [] para tenants inexistentes,
      // que sería ambiguo con "no hay duplicados").
      const t = await client.query(
        `SELECT id FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
        [id]
      );
      if (!t.rows[0]) return null;

      const q = await client.query(
        `WITH clases_con_count AS (
           SELECT c.*,
                  COUNT(p.id) FILTER (WHERE p.deleted_at IS NULL)::int AS count_productos
             FROM clases_producto c
             LEFT JOIN productos p ON p.clase_id = c.id
            WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
            GROUP BY c.id
         )
         SELECT
           a.id                AS a_id,
           a.nombre            AS a_nombre,
           a.count_productos   AS a_count,
           a.created_at        AS a_created_at,
           a.es_base           AS a_es_base,
           a.es_sin_categoria  AS a_es_sin_categoria,
           b.id                AS b_id,
           b.nombre            AS b_nombre,
           b.count_productos   AS b_count,
           b.created_at        AS b_created_at,
           b.es_base           AS b_es_base,
           b.es_sin_categoria  AS b_es_sin_categoria,
           similarity(LOWER(a.nombre), LOWER(b.nombre)) AS sim,
           CASE
             WHEN LOWER(a.nombre) LIKE '%' || LOWER(b.nombre) || '%' THEN 'A_CONTAINS_B'
             WHEN LOWER(b.nombre) LIKE '%' || LOWER(a.nombre) || '%' THEN 'B_CONTAINS_A'
             ELSE NULL
           END AS contain_kind
           FROM clases_con_count a
           JOIN clases_con_count b ON b.id < a.id  -- evita pares duplicados (a,b) y (b,a)
          WHERE similarity(LOWER(a.nombre), LOWER(b.nombre)) >= 0.5
             OR LOWER(a.nombre) LIKE '%' || LOWER(b.nombre) || '%'
             OR LOWER(b.nombre) LIKE '%' || LOWER(a.nombre) || '%'
          ORDER BY
            -- containment primero (alta confianza), luego similarity
            (CASE WHEN LOWER(a.nombre) LIKE '%' || LOWER(b.nombre) || '%'
                    OR LOWER(b.nombre) LIKE '%' || LOWER(a.nombre) || '%'
                  THEN 1.0 ELSE similarity(LOWER(a.nombre), LOWER(b.nombre)) END) DESC,
            a.nombre ASC`,
        [id]
      );
      return q.rows;
    });

    if (rows === null) return res.status(404).json({ error: 'Tenant no encontrado' });

    // Post-process: agregar canónica sugerida, score, confidence.
    // Regla de canónica: más productos gana. Empate → más antigua (created_at ASC).
    // Empate total → alfabético (menor). Las clases `es_base` y `es_sin_categoria`
    // se prefieren como canónicas (nunca se van a mergear como "duplicadas").
    const enriched = rows.map(r => {
      const contain = r.contain_kind !== null;
      const score = contain ? 1.0 : Number(r.sim);
      const confidence = score >= 0.9 ? 'high' : 'medium';

      // Elegir canónica.
      const pickCanonica = () => {
        // Nunca mergear una base o sin_categoria (serían la canónica siempre).
        if (r.a_es_base || r.a_es_sin_categoria) return r.a_id;
        if (r.b_es_base || r.b_es_sin_categoria) return r.b_id;
        // Sino, la de más productos.
        if (r.a_count > r.b_count) return r.a_id;
        if (r.b_count > r.a_count) return r.b_id;
        // Empate → la más antigua.
        if (new Date(r.a_created_at) < new Date(r.b_created_at)) return r.a_id;
        if (new Date(r.b_created_at) < new Date(r.a_created_at)) return r.b_id;
        // Empate total → alfabético.
        return r.a_nombre.toLowerCase() <= r.b_nombre.toLowerCase() ? r.a_id : r.b_id;
      };
      const canonica_suggested_id = pickCanonica();
      const duplicada_suggested_id = canonica_suggested_id === r.a_id ? r.b_id : r.a_id;

      return {
        a: {
          id: r.a_id, nombre: r.a_nombre, count_productos: r.a_count,
          es_base: r.a_es_base, es_sin_categoria: r.a_es_sin_categoria,
        },
        b: {
          id: r.b_id, nombre: r.b_nombre, count_productos: r.b_count,
          es_base: r.b_es_base, es_sin_categoria: r.b_es_sin_categoria,
        },
        similarity: Math.round(Number(r.sim) * 100) / 100,
        contain_kind: r.contain_kind,
        score: Math.round(score * 100) / 100,
        confidence,
        canonica_suggested_id,
        duplicada_suggested_id,
      };
    });

    logger.info(
      { super_admin: req.user.id, tenant_id: id, pairs_found: enriched.length },
      '[super-admin] GET /tenants/:id/clases-duplicadas'
    );
    res.json({ tenant_id: id, pairs: enriched });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /tenants/:id/clases-merge
//
// Consolida 2 clases_producto: mueve todos los productos de `duplicada_id`
// a `canonica_id` y soft-deletea la duplicada. Auditado en tenant_admin_actions.
//
// Body: { duplicada_id: UUID, canonica_id: UUID }
//
// Precauciones:
//   - SELECT FOR UPDATE en las 2 clases → serializa contra edits/merges concurrentes.
//   - Verifica que ambas pertenecen al mismo tenant (RLS bypass, así que validación manual).
//   - Rechaza mergear una `es_base` o `es_sin_categoria` como duplicada (serían
//     las canónicas). Si el super-admin realmente quiere hacerlo, tiene que renombrar
//     primero (fuera del scope de este endpoint).
//   - Todo en 1 tx atómica: rollback automático si algo falla.
// ──────────────────────────────────────────────────────────────────────────
router.post('/tenants/:id/clases-merge',
  validate(mergeClasesProductoSchema),
  async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'id inválido' });
      }
      const { duplicada_id, canonica_id } = req.body;

      const result = await db.adminQuery(async (client) => {
        // Todo dentro de una tx explícita para atomicidad + FOR UPDATE lock.
        await client.query('BEGIN');
        try {
          // Lock ambas clases + verifica que pertenezcan al tenant + no estén ya borradas.
          const clases = await client.query(
            `SELECT id, nombre, es_base, es_sin_categoria, tenant_id, deleted_at
               FROM clases_producto
              WHERE id = ANY($1::uuid[])
                AND tenant_id = $2
                AND deleted_at IS NULL
              FOR UPDATE`,
            [[duplicada_id, canonica_id], id]
          );
          if (clases.rows.length !== 2) {
            const err = new Error('Alguna de las 2 clases no existe, ya fue borrada, o no pertenece al tenant');
            err.status = 404;
            throw err;
          }
          const duplicada = clases.rows.find(r => r.id === duplicada_id);
          const canonica = clases.rows.find(r => r.id === canonica_id);
          if (!duplicada || !canonica) {
            const err = new Error('IDs no matchean con las filas encontradas');
            err.status = 500;
            throw err;
          }
          // No permitir borrar una base o sin_categoria como "duplicada"
          // — deben ser la canónica siempre. Super-admin puede renombrar
          // primero si realmente quiere.
          if (duplicada.es_base) {
            const err = new Error('No se puede mergear una categoría base como duplicada');
            err.status = 409;
            err.code = 'duplicada_es_base';
            throw err;
          }
          if (duplicada.es_sin_categoria) {
            const err = new Error('No se puede mergear "Sin categoría" (protegida por sistema)');
            err.status = 409;
            err.code = 'duplicada_es_sin_categoria';
            throw err;
          }

          // Mover productos. Nota: tabla productos NO tiene updated_at, solo
          // created_at (histórico — se pensó como append-mostly con edits vía
          // audit_logs). Por eso NO seteamos updated_at acá.
          const upd = await client.query(
            `UPDATE productos
                SET clase_id = $1
              WHERE clase_id = $2 AND tenant_id = $3`,
            [canonica_id, duplicada_id, id]
          );
          const productos_movidos = upd.rowCount;

          // Soft-delete la duplicada.
          await client.query(
            `UPDATE clases_producto
                SET deleted_at = NOW(), updated_at = NOW()
              WHERE id = $1 AND tenant_id = $2`,
            [duplicada_id, id]
          );

          // Audit trail. Reusa insertAdminAction para consistencia con
          // resto de acciones super-admin. before/after captura info clave
          // para forense + posible rollback manual.
          await insertAdminAction(client, {
            tenantId: id,
            superAdminUserId: req.user.id,
            action: 'clases_merge',
            beforeState: {
              duplicada: { id: duplicada.id, nombre: duplicada.nombre },
              canonica:  { id: canonica.id,  nombre: canonica.nombre  },
            },
            afterState: {
              productos_movidos,
              canonica_final_id: canonica.id,
              canonica_final_nombre: canonica.nombre,
            },
            reason: null,
          });

          await client.query('COMMIT');
          return {
            duplicada_id, canonica_id,
            duplicada_nombre: duplicada.nombre,
            canonica_nombre: canonica.nombre,
            productos_movidos,
          };
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      });

      logger.info(
        { super_admin: req.user.id, tenant_id: id, ...result },
        '[super-admin] POST /tenants/:id/clases-merge'
      );

      // 2026-07-24 (cache audit P2): invalidar INVENTARIO_METRICAS cross-instance.
      // El merge mueve N productos de `duplicada_id` a `canonica_id` (ver UPDATE
      // productos SET clase_id arriba). El cache `inv_por_clase[]` que sirve el
      // Dashboard queda stale (muestra ambas categorías con productos aunque
      // ya se mergearon) hasta el próximo TTL (20s).
      // Fire-and-forget con catch para no bloquear la response — el cache es
      // fail-open by design.
      invalidateMetricas(id).catch(err =>
        logger.warn(
          { err: err.message, tenantId: id, productos_movidos: result.productos_movidos },
          '[super-admin] clases-merge: invalidateMetricas falló'
        )
      );

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// TRUSTED COMPANIES — sección "Empresas que confiaron en Tecny" (CMS Fase 4)
//
// 2026-07-18 (feature): Lucas edita el listado de logos de empresas clientes /
// partners que se muestra en la landing tecnyapp.com. Diseño en el commit
// header de migration 20260718000001_site_landing_companies.js.
//
// Los logos se suben en base64 desde el admin (frontend hace FileReader →
// dataURL → split(',')[1]). El backend delega el almacenamiento a fileStore
// (R2 en prod, columna DB en staging/dev). El endpoint público sirve los
// bytes con Cache-Control 24h.
//
// TENANT_ID = 1 (site-landing es data global de Tecny, no per-tenant; usamos
// el tenant Tecny para satisfacer el requirement de fileStore.put que aísla
// keys por tenant).
// ═══════════════════════════════════════════════════════════════════════════

const SITE_LANDING_TENANT_ID = 1;
const TRUSTED_COMPANIES_LIMIT = 40;

// ──────────────────────────────────────────────────────────────────────────
// GET /api/super-admin/trusted-companies
//
// Lista completa (activas + soft-deleted no incluidas), ordenada por position.
// No incluye logo_data ni logo_key en el payload — el admin renderiza el
// preview via el endpoint público /trusted-companies/:id/logo (mismo image
// tag <img src="/api/public/...">). Ahorra ~2-4MB de payload al listar 40 logos.
// ──────────────────────────────────────────────────────────────────────────
router.get('/trusted-companies', async (_req, res, next) => {
  try {
    const rows = await db.adminQuery(async (client) => {
      const r = await client.query(
        `SELECT id, nombre, logo_nombre, logo_tipo, logo_size, position,
                created_at, updated_at
           FROM site_landing_companies
          WHERE deleted_at IS NULL
          ORDER BY position ASC, created_at ASC`
      );
      return r.rows;
    });
    res.json({ companies: rows, limit: TRUSTED_COMPANIES_LIMIT });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/super-admin/trusted-companies
//
// Crea una empresa nueva. Body:
//   { nombre, logo_data (base64), logo_mime, logo_nombre? }
//
// La position se auto-asigna al final (MAX(position)+1). El admin puede
// reordenar después con PATCH /:id { position }.
//
// Errores esperados:
//   400 — validación (nombre vacío, logo muy pesado, MIME no soportado)
//   409 — nombre duplicado (UNIQUE parcial en LOWER(nombre))
//   422 — límite de 40 empresas alcanzado
// ──────────────────────────────────────────────────────────────────────────
router.post('/trusted-companies',
  validate(createTrustedCompanySchema),
  async (req, res, next) => {
    try {
      const { nombre, logo_data, logo_mime, logo_nombre } = req.body;

      // Validar límite ANTES de subir a R2 (para no dejar objetos huérfanos
      // en el bucket si rebota por count).
      const count = await db.adminQuery(async (client) => {
        const r = await client.query(
          `SELECT COUNT(*)::int AS n FROM site_landing_companies WHERE deleted_at IS NULL`
        );
        return r.rows[0].n;
      });
      if (count >= TRUSTED_COMPANIES_LIMIT) {
        return res.status(422).json({
          error: `Límite de ${TRUSTED_COMPANIES_LIMIT} empresas alcanzado. Eliminá alguna antes de agregar.`,
        });
      }

      // Subir a fileStore. En prod (driver r2) esto hace PUT al bucket y
      // devuelve la key; en dev (driver db) devuelve el base64 passthrough.
      // entity='site-landing' agrupa las keys de este feature en el bucket.
      const stored = await fileStore.put({
        tenantId: SITE_LANDING_TENANT_ID,
        dataBase64: logo_data,
        filename: logo_nombre || null,
        mime: logo_mime,
        entity: 'site-landing',
        subpath: 'companies',
      });

      const result = await db.adminQuery(async (client) => {
        try {
          const r = await client.query(
            `INSERT INTO site_landing_companies
               (nombre, logo_data, logo_key, logo_nombre, logo_tipo, logo_size, position)
             VALUES ($1, $2, $3, $4, $5, $6,
               COALESCE((SELECT MAX(position) + 1 FROM site_landing_companies WHERE deleted_at IS NULL), 0))
             RETURNING id, nombre, logo_nombre, logo_tipo, logo_size, position, created_at`,
            [nombre, stored.data, stored.key, stored.nombre, stored.tipo, stored.size]
          );
          return r.rows[0];
        } catch (e) {
          // Si el INSERT rebotó (23505 unique), limpiamos el objeto que ya
          // subimos a R2 para no dejar huérfanos.
          if (stored.key) {
            await fileStore.remove({ logo_key: stored.key }, { prefix: 'logo' }).catch(() => {});
          }
          throw e;
        }
      });

      logger.info(
        { super_admin: req.user.id, id: result.id, nombre },
        '[super-admin] POST /trusted-companies'
      );
      res.status(201).json(result);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Ya existe una empresa con ese nombre.' });
      }
      next(err);
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// PATCH /api/super-admin/trusted-companies/:id
//
// Edita nombre y/o position. Al menos un campo debe venir.
// El reorder con flechas ↑↓ en el admin envía { position: n } — el frontend
// calcula el nuevo valor swapeando con la fila adyacente.
// ──────────────────────────────────────────────────────────────────────────
router.patch('/trusted-companies/:id',
  validate(updateTrustedCompanySchema),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      // Validación UUID defensiva en el path (no pasa por validate()).
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: 'id inválido (debe ser UUID)' });
      }

      const setPieces = [];
      const values = [];
      if ('nombre' in req.body) {
        setPieces.push(`nombre = $${values.length + 1}`);
        values.push(req.body.nombre);
      }
      if ('position' in req.body) {
        setPieces.push(`position = $${values.length + 1}`);
        values.push(req.body.position);
      }
      setPieces.push('updated_at = NOW()');
      values.push(id);

      const result = await db.adminQuery(async (client) => {
        const r = await client.query(
          `UPDATE site_landing_companies
              SET ${setPieces.join(', ')}
            WHERE id = $${values.length} AND deleted_at IS NULL
            RETURNING id, nombre, logo_nombre, logo_tipo, logo_size, position, updated_at`,
          values
        );
        return r.rows[0];
      });

      if (!result) return res.status(404).json({ error: 'Empresa no encontrada.' });

      logger.info(
        { super_admin: req.user.id, id, fields: Object.keys(req.body) },
        '[super-admin] PATCH /trusted-companies/:id'
      );
      res.json(result);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Ya existe una empresa con ese nombre.' });
      }
      next(err);
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// DELETE /api/super-admin/trusted-companies/:id
//
// Soft-delete + limpieza del bucket R2 (si driver=r2). El objeto se borra
// físicamente para no acumular costos de storage — el soft-delete queda por
// si en el futuro se cambia esa política (por ahora, delete es delete).
// ──────────────────────────────────────────────────────────────────────────
router.delete('/trusted-companies/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'id inválido (debe ser UUID)' });
    }

    const row = await db.adminQuery(async (client) => {
      const r = await client.query(
        `UPDATE site_landing_companies
            SET deleted_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, logo_key, logo_data`,
        [id]
      );
      return r.rows[0];
    });

    if (!row) return res.status(404).json({ error: 'Empresa no encontrada.' });

    // Borrar del bucket. fileStore.remove es idempotente y no-op para driver=db.
    await fileStore.remove({ logo_key: row.logo_key }, { prefix: 'logo' }).catch((e) => {
      // Si R2 rechazó el DELETE (transient error), logueamos pero no fallamos
      // el request — la fila ya está soft-deleted, cleanup del objeto se puede
      // retriar con un job de mantenimiento.
      logger.warn({ err: e.message, id }, '[super-admin] fileStore.remove falló, orphan posible');
    });

    logger.info({ super_admin: req.user.id, id }, '[super-admin] DELETE /trusted-companies/:id');
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Feature Flags per-tenant — F2 (Rec proactiva #3, 2026-07-20)
// ═════════════════════════════════════════════════════════════════════════
//
// Endpoints super-admin para overrides de feature flags. Design doc:
// docs/design/feature-flags-per-tenant.md.
//
// Resolver (`lib/featureFlags.js`) evalúa: tenant > plan > rollout > global.
// Estos endpoints escriben en las tablas que alimentan esa precedencia.
//
// Cache invalidation: cada mutation invalida el key correspondiente en
// Redis. Sin pub-sub cross-instance, el TTL (5min) es el techo de
// staleness. Kill switch efectivo requiere restart de pods o esperar TTL.
//
// Audit log: cada cambio → row en audit_logs vía el helper `audit()`.
// Todos los endpoints usan `requireSuperAdmin` (aplicado a nivel router
// arriba en app.js — este file entero es super-admin-only).

const featureFlagsLib = require('../lib/featureFlags');
const audit = require('../lib/audit');

// GET /api/super-admin/features
//
// Devuelve todos los flags con overrides. 1 query por tabla (3 total).
// No paginado — regla del design: max 15 flags activos.
router.get('/features', async (_req, res, next) => {
  try {
    const rows = await db.adminQuery(async (client) => {
      const { rows: flags } = await client.query(
        `SELECT name, enabled, rollout_pct, description, created_at, updated_at
           FROM feature_flags
          ORDER BY name ASC`
      );
      const { rows: tenantOverrides } = await client.query(
        `SELECT ffo.flag_name, ffo.tenant_id, ffo.enabled, ffo.reason,
                ffo.updated_at, ffo.updated_by, t.nombre AS tenant_nombre
           FROM feature_flags_tenants ffo
           JOIN tenants t ON t.id = ffo.tenant_id
          ORDER BY ffo.updated_at DESC`
      );
      const { rows: planOverrides } = await client.query(
        `SELECT flag_name, plan_id, enabled, updated_at
           FROM feature_flags_plans
          ORDER BY flag_name, plan_id`
      );
      return { flags, tenantOverrides, planOverrides };
    });

    // Agrupar overrides por flag.
    const byFlag = new Map(rows.flags.map((f) => [f.name, {
      ...f,
      tenant_overrides: [],
      plan_overrides: [],
    }]));
    for (const to of rows.tenantOverrides) {
      byFlag.get(to.flag_name)?.tenant_overrides.push({
        tenant_id:     to.tenant_id,
        tenant_nombre: to.tenant_nombre,
        enabled:       to.enabled,
        reason:        to.reason,
        updated_at:    to.updated_at,
        updated_by:    to.updated_by,
      });
    }
    for (const po of rows.planOverrides) {
      byFlag.get(po.flag_name)?.plan_overrides.push({
        plan_id:    po.plan_id,
        enabled:    po.enabled,
        updated_at: po.updated_at,
      });
    }

    res.json({ flags: Array.from(byFlag.values()) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/super-admin/features/:name
//
// Update campos del flag global: enabled, rollout_pct, description.
// El flag debe existir (creación via routes/feature-flags.js del sistema
// original).
router.patch('/features/:name',
  validate(patchFeatureFlagSchema),
  async (req, res, next) => {
    try {
      const { name } = req.params;
      const body = req.body;

      // Build dynamic UPDATE — solo campos que vinieron.
      const setPieces = [];
      const values = [];
      for (const [k, v] of Object.entries(body)) {
        setPieces.push(`${k} = $${values.length + 1}`);
        values.push(v);
      }
      setPieces.push(`updated_at = NOW()`);
      values.push(name); // último param = WHERE name = $N

      const result = await db.adminQuery(async (client) => {
        const { rows: prevRows } = await client.query(
          `SELECT enabled, rollout_pct, description FROM feature_flags WHERE name = $1`,
          [name]
        );
        if (!prevRows[0]) return { notFound: true };
        const prev = prevRows[0];

        const { rows } = await client.query(
          `UPDATE feature_flags
              SET ${setPieces.join(', ')}
            WHERE name = $${values.length}
            RETURNING name, enabled, rollout_pct, description, updated_at`,
          values
        );
        const next = rows[0];

        return { next, prev };
      });

      if (result?.notFound) return res.status(404).json({ error: 'Flag no existe' });

      if (result?.notFound) return res.status(404).json({ error: 'Flag no existe' });

      // Audit sin client (usa pool directo con autocommit). db.adminQuery
      // no wrapea en tx, entonces el SAVEPOINT interno de audit fallaría.
      try {
        await audit('feature_flags', 'UPDATE', null, {
          antes: result.prev,
          despues: result.next,
          user_id: req.user.id,
          extra: { scope: 'global', flag: name },
        });
      } catch (auditErr) {
        logger.warn({ err: auditErr.message }, '[super-admin/features] audit fallo, ignorado');
      }

      logger.info({ super_admin: req.user.id, flag: name, fields: Object.keys(body) },
        '[super-admin] PATCH /features/:name');
      res.json(result.next);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/super-admin/features/:name/tenants/:tenantId
//
// Upsert override por tenant. Invalida cache del (flag, tenant).
router.post('/features/:name/tenants/:tenantId',
  validate(upsertTenantOverrideSchema),
  async (req, res, next) => {
    try {
      const { name } = req.params;
      const tenantId = parseId(req.params.tenantId);
      if (!tenantId) return res.status(400).json({ error: 'tenantId inválido' });

      const { enabled, reason } = req.body;

      const result = await db.adminQuery(async (client) => {
        const { rows: flagRows } = await client.query(
          `SELECT 1 FROM feature_flags WHERE name = $1`, [name]
        );
        if (!flagRows[0]) return { notFound: 'flag' };

        const { rows: tenantRows } = await client.query(
          `SELECT 1 FROM tenants WHERE id = $1 AND deleted_at IS NULL`, [tenantId]
        );
        if (!tenantRows[0]) return { notFound: 'tenant' };

        const { rows: prevRows } = await client.query(
          `SELECT enabled, reason FROM feature_flags_tenants
            WHERE flag_name = $1 AND tenant_id = $2`,
          [name, tenantId]
        );

        const { rows } = await client.query(
          `INSERT INTO feature_flags_tenants (flag_name, tenant_id, enabled, reason, updated_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (flag_name, tenant_id) DO UPDATE
              SET enabled    = EXCLUDED.enabled,
                  reason     = EXCLUDED.reason,
                  updated_at = NOW(),
                  updated_by = EXCLUDED.updated_by
           RETURNING flag_name, tenant_id, enabled, reason, updated_at, updated_by`,
          [name, tenantId, enabled, reason ?? null, req.user.id]
        );

        return { row: rows[0], prev: prevRows[0] || null };
      });

      if (result?.notFound) {
        return res.status(404).json({ error: `${result.notFound} no existe` });
      }

      // Audit fuera de adminQuery (autocommit path — el SAVEPOINT interno
      // no funciona sin tx explícita, ver PATCH /features arriba).
      try {
        await audit('feature_flags_tenants',
          result.prev ? 'UPDATE' : 'INSERT', null, {
            antes: result.prev,
            despues: result.row,
            user_id: req.user.id,
            extra: { scope: 'tenant', flag: name, tenant_id: tenantId },
          });
      } catch (auditErr) {
        logger.warn({ err: auditErr.message }, '[super-admin/features] audit fallo, ignorado');
      }

      await featureFlagsLib.invalidateFeatureCache(name, tenantId);

      logger.info({ super_admin: req.user.id, flag: name, tenant_id: tenantId, enabled },
        '[super-admin] POST /features/:name/tenants/:tenantId');
      res.json(result.row);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/super-admin/features/:name/tenants/:tenantId
router.delete('/features/:name/tenants/:tenantId', async (req, res, next) => {
  try {
    const { name } = req.params;
    const tenantId = parseId(req.params.tenantId);
    if (!tenantId) return res.status(400).json({ error: 'tenantId inválido' });

    const result = await db.adminQuery(async (client) => {
      const { rows: prevRows } = await client.query(
        `DELETE FROM feature_flags_tenants
          WHERE flag_name = $1 AND tenant_id = $2
          RETURNING enabled, reason`,
        [name, tenantId]
      );
      if (!prevRows[0]) return { notFound: true };

      return { prev: prevRows[0] };
    });

    if (result?.notFound) return res.status(404).json({ error: 'Override no existe' });

    try {
      await audit('feature_flags_tenants', 'DELETE', null, {
        antes: result.prev,
        despues: null,
        user_id: req.user.id,
        extra: { scope: 'tenant', flag: name, tenant_id: tenantId },
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr.message }, '[super-admin/features] audit fallo, ignorado');
    }

    await featureFlagsLib.invalidateFeatureCache(name, tenantId);

    logger.info({ super_admin: req.user.id, flag: name, tenant_id: tenantId },
      '[super-admin] DELETE /features/:name/tenants/:tenantId');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/super-admin/features/:name/plans/:planId
//
// Upsert override por plan. Valida planId contra el enum PLANES.
router.post('/features/:name/plans/:planId',
  validate(upsertPlanOverrideSchema),
  async (req, res, next) => {
    try {
      const { name, planId } = req.params;
      if (!PLANES.includes(planId)) {
        return res.status(400).json({ error: `plan_id inválido — debe ser ${PLANES.join('|')}` });
      }

      const { enabled } = req.body;

      const result = await db.adminQuery(async (client) => {
        const { rows: flagRows } = await client.query(
          `SELECT 1 FROM feature_flags WHERE name = $1`, [name]
        );
        if (!flagRows[0]) return { notFound: 'flag' };

        const { rows: prevRows } = await client.query(
          `SELECT enabled FROM feature_flags_plans
            WHERE flag_name = $1 AND plan_id = $2`,
          [name, planId]
        );

        const { rows } = await client.query(
          `INSERT INTO feature_flags_plans (flag_name, plan_id, enabled)
           VALUES ($1, $2, $3)
           ON CONFLICT (flag_name, plan_id) DO UPDATE
              SET enabled = EXCLUDED.enabled, updated_at = NOW()
           RETURNING flag_name, plan_id, enabled, updated_at`,
          [name, planId, enabled]
        );

        return { row: rows[0], prev: prevRows[0] || null };
      });

      if (result?.notFound) {
        return res.status(404).json({ error: `${result.notFound} no existe` });
      }

      try {
        await audit('feature_flags_plans',
          result.prev ? 'UPDATE' : 'INSERT', null, {
            antes: result.prev,
            despues: result.row,
            user_id: req.user.id,
            extra: { scope: 'plan', flag: name, plan_id: planId },
          });
      } catch (auditErr) {
        logger.warn({ err: auditErr.message }, '[super-admin/features] audit fallo, ignorado');
      }

      // No invalidamos cache per-tenant acá — un cambio de plan afecta N
      // tenants. Sin pub-sub cross-instance, aceptamos staleness hasta TTL
      // 5min. Para override urgente, usar override por-tenant.

      logger.info({ super_admin: req.user.id, flag: name, plan_id: planId, enabled },
        '[super-admin] POST /features/:name/plans/:planId');
      res.json(result.row);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/super-admin/features/:name/plans/:planId
router.delete('/features/:name/plans/:planId', async (req, res, next) => {
  try {
    const { name, planId } = req.params;
    if (!PLANES.includes(planId)) {
      return res.status(400).json({ error: `plan_id inválido — debe ser ${PLANES.join('|')}` });
    }

    const result = await db.adminQuery(async (client) => {
      const { rows: prevRows } = await client.query(
        `DELETE FROM feature_flags_plans
          WHERE flag_name = $1 AND plan_id = $2
          RETURNING enabled`,
        [name, planId]
      );
      if (!prevRows[0]) return { notFound: true };
      return { prev: prevRows[0] };
    });

    if (result?.notFound) return res.status(404).json({ error: 'Override no existe' });

    try {
      await audit('feature_flags_plans', 'DELETE', null, {
        antes: result.prev,
        despues: null,
        user_id: req.user.id,
        extra: { scope: 'plan', flag: name, plan_id: planId },
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr.message }, '[super-admin/features] audit fallo, ignorado');
    }

    logger.info({ super_admin: req.user.id, flag: name, plan_id: planId },
      '[super-admin] DELETE /features/:name/plans/:planId');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

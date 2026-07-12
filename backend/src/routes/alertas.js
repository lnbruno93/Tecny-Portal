// Endpoint del módulo Alertas.
// GET  /api/alertas         → todas las alertas activas + su config.
// GET  /api/alertas/config  → solo la config (sin evaluar).
// PUT  /api/alertas/config/:tipo → actualizar activa o parametros.
//
// El evaluador del GET está cacheado (TTL 60s) — los datos del negocio no
// cambian al segundo y las queries pueden ser pesadas (joins sobre toda la
// tabla de productos/movimientos).

const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { createTenantScopedCache } = require('../lib/cacheTtl');
const { evaluarTodas, EVALUADORES, TIPOS_SETTING } = require('../lib/alertas');
const { updateAlertaConfigSchema, validarParametros } = require('../schemas/alertas');
const { ZodError } = require('zod');

// Tipos válidos = evaluables + settings.
function tipoValido(tipo) {
  return EVALUADORES[tipo] !== undefined || TIPOS_SETTING.has(tipo);
}

// 2026-06-20 #343 — fix tenant scope.
//
// Antes este cache usaba `createCachedFetcher('alertas:eval', ...)` — UNA
// sola key in-memory para TODOS los tenants. Si por algún motivo el
// evaluator hubiera devuelto datos (no lo hacía post-RLS strict, pero
// hipotéticamente), el primer tenant que pegaba al endpoint warmaba la
// cache y todos los demás veían SU data → leak garantizado.
//
// Ahora usamos `createTenantScopedCache` que crea una cache por tenant
// vía Redis con key `alertas:eval:t{tenantId}` (cross-instance, anti-
// stale-write tombstone, single-flight dedup local). Mismo TTL 5 min.
const alertasCache = createTenantScopedCache({
  keyPrefix: 'cache:alertas:eval:t',
  ttlMs: 5 * 60_000,
  maxFetchers: 64, // ~64 tenants concurrentes activos antes de evicción LRU
  fetcher: async (tenantIdStr) => {
    const tenantId = Number(tenantIdStr);
    const grupos = await evaluarTodas({ tenantId });
    const total_alertas = grupos.reduce((acc, g) => acc + (g.count || 0), 0);
    return { grupos, total_alertas, generado_en: new Date().toISOString() };
  },
});

router.get('/', async (req, res, next) => {
  try {
    if (!Number.isInteger(req.tenantId) || req.tenantId <= 0) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    const data = await alertasCache.get(req.tenantId);
    res.json(data);
  } catch (err) { next(err); }
});

router.get('/config', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT tipo, activa, parametros, updated_at FROM alertas_config ORDER BY tipo'
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.put('/config/:tipo', validate(updateAlertaConfigSchema), async (req, res, next) => {
  const tipo = String(req.params.tipo);
  if (!tipoValido(tipo)) return res.status(400).json({ error: `Tipo de alerta desconocido: ${tipo}` });

  // 2026-06-20 TANDA 0 fix #341 P2-hardening: validar tenantId antes de
  // interpolar en SQL (`SET LOCAL`). El middleware auth ya garantiza un
  // número finito pero defendemos contra cambios futuros / JWT raros.
  // `db.withTenant` ya hace este check, pero acá no lo usamos porque
  // necesitamos llamar `audit()` adentro y tenemos manejo manual de tx.
  if (!Number.isInteger(req.tenantId) || req.tenantId <= 0) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const { rows: before } = await client.query(
      'SELECT tipo, activa, parametros FROM alertas_config WHERE tipo = $1', [tipo]
    );
    if (!before[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `No hay config para el tipo "${tipo}"` });
    }

    const sets = [];
    const params = [];
    if (req.body.activa !== undefined) {
      params.push(req.body.activa);
      sets.push(`activa = $${params.length}`);
    }
    if (req.body.parametros !== undefined) {
      // Validación per-tipo: rechaza claves desconocidas (prototype pollution
      // defense: __proto__, constructor) y valores fuera de rango. El schema
      // libre del validate() global solo verifica que los valores sean number
      // /string/boolean — pero no que las CLAVES correspondan al tipo.
      let parametrosValidados;
      try {
        parametrosValidados = validarParametros(tipo, req.body.parametros);
      } catch (zerr) {
        await client.query('ROLLBACK');
        const msg = (zerr instanceof ZodError)
          ? zerr.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
          : (zerr.message || 'Parametros inválidos');
        return res.status(400).json({ error: `Parametros inválidos para "${tipo}": ${msg}` });
      }
      // Merge con los parametros existentes (validados) para no perder claves no enviadas.
      const merged = { ...(before[0].parametros || {}), ...parametrosValidados };
      params.push(merged);
      sets.push(`parametros = $${params.length}::jsonb`);
    }
    sets.push(`updated_at = NOW()`);
    params.push(tipo);
    const { rows } = await client.query(
      `UPDATE alertas_config SET ${sets.join(', ')} WHERE tipo = $${params.length} RETURNING *`,
      params
    );

    await audit(client, 'alertas_config', 'UPDATE', rows[0].id,
                { antes: before[0], despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');

    // 2026-06-20 #343: invalidar cache del tenant — un toggle activa/desactiva
    // o cambio de parámetros (ej. umbral_unidades) impacta inmediatamente la
    // próxima evaluación. Cross-instance via Redis DEL + tombstone.
    // Fire-and-forget: si falla, el cache vence solo a los 5 min.
    // 2026-07-12 (auditoría TOTAL Plataforma P1-4): logging explícito en el
    // .catch — antes silence total, ahora warn con contexto.
    alertasCache.invalidate(req.tenantId).catch((err) => require('../lib/logger').warn({ err: err.message, tenantId: req.tenantId }, '[alertas] cache.invalidate post-write falló — otras réplicas verán stale hasta TTL 5min'));

    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

module.exports = router;

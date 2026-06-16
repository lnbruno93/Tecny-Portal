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
const { createCachedFetcher } = require('../lib/cacheTtl');
const { evaluarTodas, EVALUADORES, TIPOS_SETTING } = require('../lib/alertas');
const { updateAlertaConfigSchema, validarParametros } = require('../schemas/alertas');
const { ZodError } = require('zod');

// Tipos válidos = evaluables + settings.
function tipoValido(tipo) {
  return EVALUADORES[tipo] !== undefined || TIPOS_SETTING.has(tipo);
}

// Caché del evaluador completo. TTL 5 min — los datos del negocio (stock,
// saldos, CC) no cambian en ese plazo a un ritmo que el usuario perciba.
// Antes era 60s, pero las queries son pesadas (joins sobre productos +
// movimientos_cc + proveedor_movimientos) y el badge se refresca cada 2min
// desde el frontend, así que la mayoría de los hits caen en el caché.
// El usuario refresca a mano si quiere forzar un re-eval.
const fetchAlertas = createCachedFetcher('alertas:eval', 5 * 60_000, async () => {
  const grupos = await evaluarTodas();
  const total_alertas = grupos.reduce((acc, g) => acc + (g.count || 0), 0);
  return { grupos, total_alertas, generado_en: new Date().toISOString() };
});

router.get('/', async (_req, res, next) => {
  try {
    const data = await fetchAlertas();
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
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

module.exports = router;

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
const { updateAlertaConfigSchema } = require('../schemas/alertas');

// Tipos válidos = evaluables + settings.
function tipoValido(tipo) {
  return EVALUADORES[tipo] !== undefined || TIPOS_SETTING.has(tipo);
}

// Caché del evaluador completo. Cada PUT a /config invalida el caché
// implícitamente (siguiente GET dentro de 60s puede devolver stale, pero
// es aceptable: el usuario refresca a mano si quiere ver el cambio).
const fetchAlertas = createCachedFetcher('alertas:eval', 60_000, async () => {
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

router.get('/config', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT tipo, activa, parametros, updated_at FROM alertas_config ORDER BY tipo'
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.put('/config/:tipo', validate(updateAlertaConfigSchema), async (req, res, next) => {
  const tipo = String(req.params.tipo);
  if (!tipoValido(tipo)) return res.status(400).json({ error: `Tipo de alerta desconocido: ${tipo}` });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
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
      // Merge con los parametros existentes para no perder claves no enviadas.
      const merged = { ...(before[0].parametros || {}), ...req.body.parametros };
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

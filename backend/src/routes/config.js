const router = require('express').Router();
const db = require('../config/database');
const adminOnly = require('../middleware/adminOnly');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { updateConfigSchema } = require('../schemas/config');
const { getSystemLimits } = require('../lib/systemLimits');


// GET /api/config/system-limits — lista informativa para Config.jsx (#443).
// Antes el frontend tenía un SYSTEM_LIMITS hardcoded que se había desincronizado
// de la realidad (decía 10 OCR/hora, son 60). Lo centralizamos acá.
// No requiere adminOnly: todo user logueado debería poder ver los límites
// operacionales del sistema (es información compartida, no sensible).
router.get('/system-limits', (req, res) => {
  res.json({ limits: getSystemLimits() });
});

// GET /api/config/last-tc — último TC usado por el tenant (#445).
// Sirve como default sensato para el Cotizador. Antes estaba hardcoded
// a 1400 ARS, que es un valor "razonable pero estancado" que se desactualiza
// mes a mes.
//
// Heurística: tomamos el TC de la venta más reciente en últimos 90 días
// que tenga tc_venta NOT NULL. Si no hay (tenant nuevo, sin ventas con TC),
// fallback a 1400.
//
// Por qué 90 días: TC se mueve mucho — un TC de hace 6 meses sería peor
// default que el hardcoded. 90 días balancea "tener algo" vs "que sea
// reciente".
//
// Devuelve: { tc, source, computed_at }
//   · source = 'venta'    cuando viene de una venta
//   · source = 'fallback' cuando se usa el default
router.get('/last-tc', async (req, res, next) => {
  try {
    const tc = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT tc_venta
           FROM ventas
          WHERE tc_venta IS NOT NULL
            AND deleted_at IS NULL
            AND created_at >= NOW() - INTERVAL '90 days'
          ORDER BY created_at DESC
          LIMIT 1`
      );
      return rows[0]?.tc_venta || null;
    });

    if (tc != null) {
      return res.json({
        tc: Number(tc),
        source: 'venta',
        computed_at: new Date().toISOString(),
      });
    }
    // Fallback. 1400 es el valor histórico que estaba hardcoded. Mantenerlo
    // como fallback significa que si por algún motivo este endpoint falla
    // o devuelve algo raro, el frontend sigue pudiendo usarlo de la misma
    // forma que antes (sin downgrade visible al user).
    res.json({
      tc: 1400,
      source: 'fallback',
      computed_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query('SELECT * FROM config LIMIT 1');
      return rows;
    });
    res.json(rows[0] || {});
  } catch (err) {
    next(err);
  }
});

// Solo admins pueden cambiar la configuración global
router.put('/', adminOnly, validate(updateConfigSchema), async (req, res, next) => {
  try {
    const { pct_financiera } = req.body;
    // 2026-06-15 multi-tenant PR 1: la PK de config es (tenant_id, id).
    // El INSERT no especifica tenant_id — depende del DEFAULT dinámico
    // (current_setting('app.current_tenant')::int con fallback a 1).
    // Combinado con SET LOCAL adentro de withTenant, persiste la fila al
    // tenant correcto. Lo que ASEGURA que esta fila siempre exista para
    // tenants nuevos es el seed inicial en signup.js §5d (2026-06-25 Bug #2).
    // Tenants legacy creados antes de ese fix necesitan SQL manual de seed
    // — ver hot-fix instrucciones en docs/.
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO config (id, pct_financiera) VALUES (1, $1)
         ON CONFLICT (tenant_id, id) DO UPDATE SET pct_financiera = $1, updated_at = NOW()
         RETURNING *`,
        [pct_financiera]
      );
      await audit(client, 'config', 'UPDATE', 1, { despues: rows[0], user_id: req.user.id });
      return rows;
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

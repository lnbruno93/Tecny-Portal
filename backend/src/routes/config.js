const router = require('express').Router();
const db = require('../config/database');
const adminOnly = require('../middleware/adminOnly');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { updateConfigSchema } = require('../schemas/config');


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
    // 2026-06-15 multi-tenant PR 1: la PK de config pasó a ser (tenant_id, id).
    // El INSERT acá no especifica tenant_id porque la columna tiene DEFAULT 1
    // (cubre el caso single-tenant actual). El ON CONFLICT necesita reflejar
    // la nueva PK compuesta. En PR 4 reemplazamos por tenant_id explícito del
    // request scope.
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

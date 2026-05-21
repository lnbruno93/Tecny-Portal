const router = require('express').Router();
const { z } = require('zod');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const validate = require('../lib/validate');

const updateConfigSchema = z.object({
  pct_financiera: z.number().min(0, 'No puede ser negativo').max(100, 'No puede superar 100'),
});

router.use(requireAuth);

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM config LIMIT 1');
    res.json(rows[0] || {});
  } catch (err) {
    next(err);
  }
});

// Solo admins pueden cambiar la configuración global
router.put('/', adminOnly, validate(updateConfigSchema), async (req, res, next) => {
  try {
    const { pct_financiera } = req.body;
    const { rows } = await db.query(
      `INSERT INTO config (id, pct_financiera) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET pct_financiera = $1, updated_at = NOW()
       RETURNING *`,
      [pct_financiera]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');

router.use(requireAuth);

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM config LIMIT 1');
    res.json(rows[0] || {});
  } catch (err) {
    next(err);
  }
});

router.put('/', async (req, res, next) => {
  try {
    const { pct_financiera } = req.body;
    const { rows } = await db.query(
      `INSERT INTO config (id, pct_financiera) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET pct_financiera = $1 RETURNING *`,
      [pct_financiera]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

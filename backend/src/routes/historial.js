const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');

router.use(requireAuth);

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM historial ORDER BY created_at DESC LIMIT 200');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

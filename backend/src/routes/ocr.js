const router = require('express').Router();
const requireAuth = require('../middleware/auth');

router.use(requireAuth);

router.post('/', async (req, res, next) => {
  try {
    const { imageData, mediaType } = req.body;
    if (!imageData) return res.status(400).json({ error: 'imageData requerido' });

    // TODO: integrar con Anthropic Vision API u otro proveedor OCR
    // Por ahora devuelve placeholder para no romper el frontend
    res.json({ text: '', fields: {} });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

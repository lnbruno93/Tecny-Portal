const router = require('express').Router();
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');

// 10 llamadas OCR por usuario por hora — protege costos de API de visión
const ocrLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de OCR alcanzado. Intentá de nuevo en 1 hora.' },
});

// Base64 de imagen — max ~7MB después de encoding (≈5MB de imagen real)
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const ocrSchema = z.object({
  imageData: z.string()
    .min(1, 'imageData requerido')
    .max(MAX_IMAGE_BYTES, 'Imagen demasiado grande (máx. 5MB)'),
  mediaType: z.enum(ALLOWED_MEDIA_TYPES, {
    errorMap: () => ({ message: 'Tipo de imagen no permitido. Usar JPEG, PNG, WEBP o GIF' }),
  }),
});

router.use(requireAuth);

router.post('/', ocrLimiter, validate(ocrSchema), async (req, res, next) => {
  try {
    const { imageData, mediaType } = req.body;  // eslint-disable-line no-unused-vars

    // TODO: integrar con Anthropic Vision API u otro proveedor OCR
    res.json({ text: '', fields: {} });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

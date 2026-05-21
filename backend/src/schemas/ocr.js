const { z } = require('zod');

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

module.exports = { ocrSchema, ALLOWED_MEDIA_TYPES, MAX_IMAGE_BYTES };

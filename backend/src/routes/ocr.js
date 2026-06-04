const router      = require('express').Router();
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const Anthropic   = require('@anthropic-ai/sdk');
const validate    = require('../lib/validate');
const logger      = require('../lib/logger');
const { ocrSchema } = require('../schemas/ocr');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });


// 60 llamadas OCR por usuario por hora — limita por user_id (no por IP).
// Así un NAT compartido no afecta a otros usuarios, y cambiar de IP no evita
// el límite. Antes era 10/hora (#74 op feedback: 10 era muy bajo para sesiones
// reales de carga de 40+ comprobantes). 60/hora = 1 por minuto sostenido,
// suficiente para 6-8h de carga ininterrumpida sin reabrir ventana. Sigue
// cortando abuso si alguien intenta usarlo en bucle automático.
const ocrLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user?.id != null ? String(req.user.id) : ipKeyGenerator(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Pasaste el límite de OCR (60/hora). Esperá hasta que se libere la ventana y mientras cargá los montos a mano.' },
});

router.post('/', ocrLimiter, validate(ocrSchema), async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'OCR no configurado (falta ANTHROPIC_API_KEY)' });
    }

    const { imageData, mediaType } = req.body;

    // Extraer solo el contenido base64 (sin el prefijo "data:image/...;base64,")
    const base64 = imageData.includes(',') ? imageData.split(',')[1] : imageData;

    // PDF → bloque 'document'; imagen → bloque 'image'. Claude procesa ambos nativamente.
    const fileBlock = mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType, data: base64 } };

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            fileBlock,
            {
              type: 'text',
              text: `Analizá este comprobante/factura y extraé el monto total a pagar o cobrar.
Respondé ÚNICAMENTE con el número, sin símbolos de moneda, sin puntos de miles, usando punto como separador decimal si corresponde.
Ejemplos de respuesta válida: 15000 | 1500.50 | 230000
Si no podés determinar el monto con certeza, respondé exactamente: null`,
            },
          ],
        },
      ],
    });

    const raw = message.content[0]?.text?.trim() ?? 'null';
    logger.info({ raw }, 'OCR response');

    // Validar que la respuesta sea un número válido o null
    const monto = raw === 'null' || raw === '' ? null : raw.replace(/[^\d.]/g, '');

    res.json({ monto: monto || null });
  } catch (err) {
    // No filtrar el error crudo del proveedor (Anthropic) al cliente: se loguea
    // completo del lado servidor pero se responde con un mensaje genérico.
    logger.error({ err }, 'OCR error');
    next(Object.assign(new Error('No se pudo procesar el comprobante. Probá con otra imagen o cargá el monto a mano.'), { status: 502 }));
  }
});

module.exports = router;

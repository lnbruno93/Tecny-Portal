const { z } = require('zod');

const createPagoSchema = z.object({
  fecha:      z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  monto:      z.number().positive('Monto debe ser positivo'),
  referencia: z.string().trim().max(500).optional().nullable(),
});

module.exports = { createPagoSchema };

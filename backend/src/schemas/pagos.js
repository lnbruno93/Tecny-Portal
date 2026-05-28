const { z } = require('zod');

const createPagoSchema = z.object({
  fecha:      z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  monto:      z.number().positive('Monto debe ser positivo'),
  referencia: z.string().trim().max(500).optional().nullable(),
}).strict();

const queryPagosSchema = z.object({
  desde:      z.string().date().optional(),
  hasta:      z.string().date().optional(),
  buscar:     z.string().max(200).optional(),
  page:       z.coerce.number().int().positive().optional(),
  per_page:   z.coerce.number().int().positive().max(500).optional(),
  limit:      z.coerce.number().int().positive().max(500).optional(),
  offset:     z.coerce.number().int().min(0).optional(),
});

module.exports = { createPagoSchema, queryPagosSchema };

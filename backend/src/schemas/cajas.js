const { z } = require('zod');

// ─── DEUDAS ─────────────────────────────────────────────────

const createDeudaSchema = z.object({
  fecha:       z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  contacto_id: z.number().int().positive('contacto_id inválido'),
  tipo:        z.enum(['debe','pago'], { error: 'tipo debe ser: debe, pago' }),
  monto_ars:   z.number().min(0).default(0),
  monto_usd:   z.number().min(0).default(0),
  concepto:    z.string().trim().max(500).optional().nullable(),
}).refine(d => d.monto_ars > 0 || d.monto_usd > 0, {
  message: 'Al menos monto_ars o monto_usd debe ser mayor a 0',
  path: ['monto_ars'],
});

const queryDeudasSchema = z.object({
  contacto_id: z.coerce.number().int().positive().optional(),
  page:        z.coerce.number().int().positive().optional(),
  limit:       z.coerce.number().int().positive().max(200).optional(),
});

// ─── INVERSIONES ────────────────────────────────────────────

const createInversionSchema = z.object({
  fecha:       z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  contacto_id: z.number().int().positive('contacto_id inválido'),
  monto:       z.number().positive('Monto debe ser positivo'),
  tasa:        z.string().trim().max(50).optional().nullable(),
});

const queryInversionesSchema = z.object({
  contacto_id: z.coerce.number().int().positive().optional(),
  page:        z.coerce.number().int().positive().optional(),
  limit:       z.coerce.number().int().positive().max(200).optional(),
});

module.exports = {
  createDeudaSchema,
  queryDeudasSchema,
  createInversionSchema,
  queryInversionesSchema,
};

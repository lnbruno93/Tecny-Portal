const { z } = require('zod');

const baseComprobante = z.object({
  fecha:            z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  cliente:          z.string().trim().min(1, 'Cliente requerido').max(200),
  vendedor_id:      z.number().int().positive().optional().nullable(),
  monto:            z.number().positive('Monto debe ser positivo'),
  monto_financiera: z.number().min(0).default(0),
  monto_neto:       z.number().min(0).optional(),
  referencia:       z.string().trim().max(500).optional().nullable(),
  // Base64 de archivo adjunto — max ~7MB de string (≈5MB real)
  archivo_data:     z.string().max(7 * 1024 * 1024, 'Archivo demasiado grande (máx. 5MB)').optional().nullable(),
  archivo_nombre:   z.string().trim().max(255).optional().nullable(),
  archivo_tipo:     z.enum(['image/jpeg','image/png','image/webp','application/pdf']).optional().nullable(),
}).strict();

const createComprobanteSchema = baseComprobante;

const queryComprobantesSchema = z.object({
  desde:    z.string().date().optional(),
  hasta:    z.string().date().optional(),
  vendedor: z.string().trim().optional(),
  buscar:   z.string().trim().max(200).optional(),
  page:     z.coerce.number().int().positive().optional(),
  limit:    z.coerce.number().int().positive().max(200).optional(),
});

module.exports = { createComprobanteSchema, queryComprobantesSchema };

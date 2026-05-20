const { z } = require('zod');

const baseComprobante = z.object({
  fecha:            z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  cliente:          z.string().trim().min(1, 'Cliente requerido').max(200),
  vendedor_id:      z.number().int().positive().optional().nullable(),
  monto:            z.number().positive('Monto debe ser positivo'),
  monto_financiera: z.number().min(0).default(0),
  monto_neto:       z.number().min(0).optional(),
  referencia:       z.string().trim().max(500).optional().nullable(),
  archivo_data:     z.string().optional().nullable(),
  archivo_nombre:   z.string().trim().max(255).optional().nullable(),
  archivo_tipo:     z.string().trim().max(100).optional().nullable(),
});

const createComprobanteSchema = baseComprobante;

const queryComprobantesSchema = z.object({
  desde:    z.string().date().optional(),
  hasta:    z.string().date().optional(),
  vendedor: z.string().trim().optional(),
  buscar:   z.string().trim().max(200).optional(),
});

module.exports = { createComprobanteSchema, queryComprobantesSchema };

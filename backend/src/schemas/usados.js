const { z } = require('zod/v4');

const createUsadoSchema = z.object({
  equipo:      z.string().min(1).max(150),
  capacidad:   z.string().max(50).optional(),
  pct_bateria: z.string().max(50).optional(),
  precio_usd:  z.number({ coerce: true }).nonnegative(),
  comentarios: z.string().max(500).optional(),
});

const updateUsadoSchema = createUsadoSchema.partial().refine(
  data => Object.keys(data).length > 0,
  { message: 'Se requiere al menos un campo para actualizar' }
);

// Bulk update: array de { id, precio_usd, comentarios }
const bulkUpdateItemSchema = z.object({
  id:          z.number({ coerce: true }).int().positive(),
  precio_usd:  z.number({ coerce: true }).nonnegative(),
  comentarios: z.string().max(500).nullable().optional(),
});

const bulkUpdateUsadosSchema = z.object({
  updates: z.array(bulkUpdateItemSchema).min(1).max(500),
});

module.exports = { createUsadoSchema, updateUsadoSchema, bulkUpdateUsadosSchema };

const { z } = require('zod/v4');

const createUsadoSchema = z.object({
  equipo:      z.string().min(1).max(150),
  capacidad:   z.string().max(50).optional(),
  pct_bateria: z.string().max(50).optional(),
  // 2026-07-12 (auditoría TOTAL Stock P2-7): positive() en vez de
  // nonnegative(). Un equipo con precio_usd=0 en el catálogo cotizador es
  // inútil operativamente. Análogo al Red B2B P1-1.
  precio_usd:  z.number({ coerce: true }).positive(),
  comentarios: z.string().max(500).optional(),
}).strict();

const updateUsadoSchema = createUsadoSchema.partial().refine(
  data => Object.keys(data).length > 0,
  { message: 'Se requiere al menos un campo para actualizar' }
);

// Bulk update: array de { id, precio_usd, comentarios }
const bulkUpdateItemSchema = z.object({
  id:          z.number({ coerce: true }).int().positive(),
  // 2026-07-12 (auditoría TOTAL Stock P2-7): positive() en vez de
  // nonnegative(). Un equipo con precio_usd=0 en el catálogo cotizador es
  // inútil operativamente. Análogo al Red B2B P1-1.
  precio_usd:  z.number({ coerce: true }).positive(),
  comentarios: z.string().max(500).nullable().optional(),
});

const bulkUpdateUsadosSchema = z.object({
  updates: z.array(bulkUpdateItemSchema).min(1).max(500),
}).strict();

module.exports = { createUsadoSchema, updateUsadoSchema, bulkUpdateUsadosSchema };

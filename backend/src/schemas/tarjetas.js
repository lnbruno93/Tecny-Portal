const { z } = require('zod');

const fecha = z.string().date('Fecha inválida (YYYY-MM-DD)').refine(d => d >= '2000-01-01', 'Fecha anterior al año 2000');
const MONEDAS = ['USD', 'ARS', 'USDT'];

const createEntidadSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(120),
  activo: z.boolean().optional().default(true),
});
const updateEntidadSchema = createEntidadSchema.partial().refine(
  d => Object.values(d).some(v => v !== undefined), { message: 'Al menos un campo es requerido' }
);

const createPlanSchema = z.object({
  entidad_id: z.coerce.number().int().positive('entidad_id requerido'),
  nombre:     z.string().trim().min(1, 'Nombre requerido').max(60),
  pct:        z.coerce.number().min(0).max(100).default(0),
  activo:     z.boolean().optional().default(true),
});
const updatePlanSchema = z.object({
  nombre: z.string().trim().min(1).max(60).optional(),
  pct:    z.coerce.number().min(0).max(100).optional(),
  activo: z.boolean().optional(),
}).refine(d => Object.values(d).some(v => v !== undefined), { message: 'Al menos un campo es requerido' });

// Cobro manual (cargado a mano, no desde una venta).
const createCobroSchema = z.object({
  entidad_id:  z.coerce.number().int().positive('entidad_id requerido'),
  plan_id:     z.coerce.number().int().positive().optional().nullable(),
  fecha,
  moneda:      z.enum(MONEDAS).default('ARS'),
  monto_bruto: z.coerce.number().positive('El monto bruto debe ser mayor a 0'),
  pct:         z.coerce.number().min(0).max(100).optional().nullable(), // override; si no, usa el del plan
  comentarios: z.string().trim().max(1000).optional().nullable(),
});

// Liquidación: el procesador nos deposita el neto → ingreso a una caja.
const createLiquidacionSchema = z.object({
  entidad_id:  z.coerce.number().int().positive('entidad_id requerido'),
  fecha,
  monto:       z.coerce.number().positive('El monto debe ser mayor a 0'),
  caja_id:     z.coerce.number().int().positive('Elegí la caja'),
  comentarios: z.string().trim().max(1000).optional().nullable(),
});

module.exports = {
  createEntidadSchema, updateEntidadSchema,
  createPlanSchema, updatePlanSchema,
  createCobroSchema, createLiquidacionSchema,
};

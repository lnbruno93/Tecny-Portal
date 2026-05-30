const { z } = require('zod');

// Comparación date-only (lexical sobre strings ISO) — sin parsear con new Date()
// en la TZ local, para no arrastrar el bug de zona horaria. z.string().date()
// valida que sea una fecha de calendario real (YYYY-MM-DD).
const fecha = z.string()
  .date('Fecha inválida (YYYY-MM-DD)')
  .refine(d => d >= '2000-01-01', 'Fecha anterior al año 2000');

const createProyectoSchema = z.object({
  nombre:         z.string().trim().min(1, 'Nombre requerido').max(150),
  objetivo:       z.string().trim().max(2000).optional().nullable(),
  fecha_creacion: fecha.optional(),
  participantes:  z.array(z.coerce.number().int().positive()).max(50).optional().default([]),
}).strict();

const updateProyectoSchema = z.object({
  nombre:         z.string().trim().min(1).max(150).optional(),
  objetivo:       z.string().trim().max(2000).optional().nullable(),
  fecha_creacion: fecha.optional(),
  participantes:  z.array(z.coerce.number().int().positive()).max(50).optional(),
}).strict().refine(d => Object.values(d).some(v => v !== undefined), {
  message: 'Al menos un campo es requerido para actualizar',
});

// Movimiento de la hoja del proyecto. monto = $ ARS; monto_usd se calcula con tc.
//
// Si `caja_id` viene: el movimiento postea al ledger de esa caja. Para eso
// `tipo` es obligatorio (ingreso o egreso) y el monto correspondiente a la
// moneda de la caja debe ser > 0. La regla "qué monto usar":
//   - Caja ARS → monto (ARS) > 0.
//   - Caja USD / USDT → monto_usd > 0 (o monto + tc para convertir).
// El backend valida la coherencia con la moneda de la caja en runtime
// (acá el schema no conoce la moneda; solo valida formato).
const createMovimientoProyectoSchema = z.object({
  proyecto_id:          z.coerce.number().int().positive('proyecto_id requerido'),
  fecha,
  detalle:              z.string().trim().max(500).optional().nullable(),
  categoria:            z.string().trim().max(100).optional().nullable(),
  monto:                z.coerce.number().min(0).optional().default(0),       // $ ARS
  tc:                   z.coerce.number().positive().optional().nullable(),
  monto_usd:            z.coerce.number().min(0).optional().nullable(),       // directo, si no hay $/tc
  inversor_contacto_id: z.coerce.number().int().positive().optional().nullable(),
  comentarios:          z.string().trim().max(1000).optional().nullable(),
  // Nuevos (impacto en caja):
  caja_id:              z.coerce.number().int().positive().optional().nullable(),
  tipo:                 z.enum(['ingreso', 'egreso']).optional(),
}).strict()
  .refine(d => (Number(d.monto) > 0) || (Number(d.monto_usd) > 0) || (d.detalle && d.detalle.trim()), {
    message: 'Cargá al menos un monto ($ o USD) o un detalle',
  })
  // Si querés impactar caja, el tipo y un monto > 0 son obligatorios.
  .refine(d => !d.caja_id || d.tipo, {
    message: 'Indicá el tipo (ingreso/egreso) cuando elegís una caja',
    path: ['tipo'],
  })
  .refine(d => !d.caja_id || Number(d.monto) > 0 || Number(d.monto_usd) > 0, {
    message: 'Para impactar en caja necesitás un monto > 0',
    path: ['monto'],
  });

module.exports = { createProyectoSchema, updateProyectoSchema, createMovimientoProyectoSchema };

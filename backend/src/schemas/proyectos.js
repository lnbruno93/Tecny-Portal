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
});

const updateProyectoSchema = z.object({
  nombre:         z.string().trim().min(1).max(150).optional(),
  objetivo:       z.string().trim().max(2000).optional().nullable(),
  fecha_creacion: fecha.optional(),
  participantes:  z.array(z.coerce.number().int().positive()).max(50).optional(),
}).refine(d => Object.values(d).some(v => v !== undefined), {
  message: 'Al menos un campo es requerido para actualizar',
});

// Movimiento de la hoja del proyecto. monto = $ ARS; monto_usd se calcula con tc.
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
}).refine(d => (Number(d.monto) > 0) || (Number(d.monto_usd) > 0) || (d.detalle && d.detalle.trim()), {
  message: 'Cargá al menos un monto ($ o USD) o un detalle',
});

module.exports = { createProyectoSchema, updateProyectoSchema, createMovimientoProyectoSchema };

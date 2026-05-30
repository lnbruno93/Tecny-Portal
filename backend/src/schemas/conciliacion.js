const { z } = require('zod');

const fecha = z.string().date('Fecha inválida (YYYY-MM-DD)');

// Línea individual del extracto. monto > 0 = ingreso (crédito), < 0 = egreso (débito).
const lineaSchema = z.object({
  fecha,
  monto:       z.coerce.number().refine(n => !Number.isNaN(n) && Math.abs(n) > 0, 'Monto inválido'),
  descripcion: z.string().trim().max(500).optional().nullable(),
}).strict();

// Crear conciliación a partir de un extracto ya parseado por el front.
// El front envía las líneas como JSON; el backend hace auto-match.
const createConciliacionSchema = z.object({
  caja_id:         z.coerce.number().int().positive('Caja requerida'),
  fecha_desde:     fecha,
  fecha_hasta:     fecha,
  archivo_nombre:  z.string().trim().max(200).optional().nullable(),
  archivo_hash:    z.string().trim().max(64).optional().nullable(),
  // Auto-match: tolerancia en días para considerar "misma fecha".
  // 0 = exacto; default 2 (banco a veces toma 1-2 días en debitar).
  tolerancia_dias: z.coerce.number().int().min(0).max(30).optional().default(2),
  lineas:          z.array(lineaSchema).min(1, 'Cargá al menos 1 línea').max(1000, 'Máximo 1000 líneas por conciliación'),
}).strict()
  .refine(d => d.fecha_desde <= d.fecha_hasta, {
    message: 'fecha_desde debe ser menor o igual a fecha_hasta',
    path: ['fecha_hasta'],
  });

// Actualizar una línea: match con caja_mov, unmatch, ignorar, nota.
// Solo se permite UNA acción por request (los 3 son mutuamente excluyentes).
const updateLineaSchema = z.object({
  matched_caja_mov_id: z.coerce.number().int().positive().nullable().optional(),
  ignorada:            z.boolean().optional(),
  nota:                z.string().trim().max(500).nullable().optional(),
}).strict().refine(d => Object.keys(d).length > 0, {
  message: 'Indicá qué actualizar',
});

module.exports = { createConciliacionSchema, updateLineaSchema };

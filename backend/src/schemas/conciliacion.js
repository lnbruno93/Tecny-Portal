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
// Una línea no puede estar `ignorada=true` y matcheada a la vez — semánticamente
// contradictorio (si la ignorás, no la imputás al ledger). El refine de abajo
// asegura ese invariante a nivel API.
const updateLineaSchema = z.object({
  matched_caja_mov_id: z.coerce.number().int().positive().nullable().optional(),
  ignorada:            z.boolean().optional(),
  nota:                z.string().trim().max(500).nullable().optional(),
}).strict()
  .refine(d => Object.keys(d).length > 0, {
    message: 'Indicá qué actualizar',
  })
  .refine(
    d => !(d.ignorada === true && d.matched_caja_mov_id != null),
    {
      message: 'Una línea ignorada no puede estar matcheada a un movimiento',
      path: ['ignorada'],
    }
  );

module.exports = { createConciliacionSchema, updateLineaSchema };

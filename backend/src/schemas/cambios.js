const { z } = require('zod');
const { fechaNoFutura } = require('./_common');

// 2026-06-11 S-18: reusar el helper fechaNoFutura compartido. Antes el schema
// permitía fechas futuras (solo bloqueaba <2000), que el operador podía meter
// por accidente y afectar KPIs proyectados/saldos cronológicos.
const fecha = fechaNoFutura;

const createEntidadSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(120),
  activo: z.boolean().optional().default(true),
}).strict();
const updateEntidadSchema = createEntidadSchema.partial().refine(
  d => Object.values(d).some(v => v !== undefined), { message: 'Al menos un campo es requerido' }
);

// Movimiento. Según el tipo se exige un set distinto de campos:
//  - entrega_ars: monto_ars > 0 y tc > 0 (USD equiv = monto_ars / tc) → egreso de una caja ARS.
//  - recibo_usd:  monto_usd > 0 → ingreso a una caja USD.
// En ambos la caja es obligatoria (integrado al ledger).
const createMovimientoSchema = z.object({
  entidad_id:  z.coerce.number().int().positive('entidad_id requerido'),
  fecha,
  tipo:        z.enum(['entrega_ars', 'recibo_usd']),
  monto_ars:   z.coerce.number().min(0).optional().default(0),
  tc:          z.coerce.number().positive().optional().nullable(),
  monto_usd:   z.coerce.number().min(0).optional().default(0),
  caja_id:     z.coerce.number().int().positive('Elegí la caja'),
  comentarios: z.string().trim().max(1000).optional().nullable(),
}).strict().superRefine((d, ctx) => {
  if (d.tipo === 'entrega_ars') {
    if (!(d.monto_ars > 0)) ctx.addIssue({ code: 'custom', path: ['monto_ars'], message: 'El monto en $ debe ser mayor a 0' });
    if (!(d.tc > 0))        ctx.addIssue({ code: 'custom', path: ['tc'], message: 'El tipo de cambio es requerido' });
  } else { // recibo_usd
    if (!(d.monto_usd > 0)) ctx.addIssue({ code: 'custom', path: ['monto_usd'], message: 'El monto en USD debe ser mayor a 0' });
  }
});

module.exports = { createEntidadSchema, updateEntidadSchema, createMovimientoSchema };

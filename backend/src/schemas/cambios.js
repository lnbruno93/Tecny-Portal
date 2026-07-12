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
//  - entrega_ars:   monto_ars > 0 y tc > 0 (USD equiv = monto_ars / tc)   → egreso caja ARS.
//  - entrega_uyu:   monto_ars > 0 y tc > 0 (USD equiv = monto_ars / tc)   → egreso caja UYU.
//                   (`monto_ars` es alias legacy — en filas UYU contiene monto UYU;
//                    ver migration 20260706000003_cambio_mov_uyu_types.js para el rationale)
//  - recibo_usd:    monto_usd > 0                                          → ingreso caja USD (par ARS/USD).
//  - recibo_usd_uy: monto_usd > 0                                          → ingreso caja USD (par UYU/USD).
// En todos la caja es obligatoria (integrado al ledger).
//
// 2026-07-12 (auditoría TOTAL Financiero P2-6, Pattern B multi-país UYU):
// Antes el enum era ['entrega_ars', 'recibo_usd'] — un tenant UY no podía
// crear movimientos en Cambios desde la UI single-tenant (los tipos UYU
// SOLO se usaban desde Red B2B via crossTenantPagos.js). Fix: agregar los
// 2 tipos UYU al enum + logic del route. Frontend UY-aware queda como
// follow-up (Cambios.jsx hoy hardcodea "ARS" en labels).
const createMovimientoSchema = z.object({
  entidad_id:  z.coerce.number().int().positive('entidad_id requerido'),
  fecha,
  tipo:        z.enum(['entrega_ars', 'recibo_usd', 'entrega_uyu', 'recibo_usd_uy']),
  monto_ars:   z.coerce.number().min(0).optional().default(0),
  tc:          z.coerce.number().positive().optional().nullable(),
  monto_usd:   z.coerce.number().min(0).optional().default(0),
  caja_id:     z.coerce.number().int().positive('Elegí la caja'),
  comentarios: z.string().trim().max(1000).optional().nullable(),
}).strict().superRefine((d, ctx) => {
  // entrega_ars y entrega_uyu comparten schema: requieren monto local + tc.
  if (d.tipo === 'entrega_ars' || d.tipo === 'entrega_uyu') {
    if (!(d.monto_ars > 0)) ctx.addIssue({ code: 'custom', path: ['monto_ars'], message: 'El monto local debe ser mayor a 0' });
    if (!(d.tc > 0))        ctx.addIssue({ code: 'custom', path: ['tc'], message: 'El tipo de cambio es requerido' });
  } else { // recibo_usd o recibo_usd_uy
    if (!(d.monto_usd > 0)) ctx.addIssue({ code: 'custom', path: ['monto_usd'], message: 'El monto en USD debe ser mayor a 0' });
  }
});

module.exports = { createEntidadSchema, updateEntidadSchema, createMovimientoSchema };

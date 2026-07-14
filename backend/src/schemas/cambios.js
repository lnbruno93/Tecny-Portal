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

// Movimiento. Según el tipo se exige un set distinto de campos. Los 8 tipos
// cubren las 2 direcciones (le doy X → me deben Y, y su inversa):
//
// Dirección A — "les doy pesos, me devuelven USD":
//  - entrega_ars:   monto_ars > 0 y tc > 0 (USD equiv = monto_ars / tc)   → egreso caja ARS.
//  - entrega_uyu:   monto_ars > 0 y tc > 0 (USD equiv = monto_ars / tc)   → egreso caja UYU.
//                   (`monto_ars` es alias legacy — en filas UYU contiene monto UYU;
//                    ver migration 20260706000003_cambio_mov_uyu_types.js para el rationale)
//  - recibo_usd:    monto_usd > 0                                          → ingreso caja USD (par ARS/USD).
//  - recibo_usd_uy: monto_usd > 0                                          → ingreso caja USD (par UYU/USD).
//
// Dirección B — "les doy USD, me devuelven pesos" (2026-07-14):
//  - entrega_usd_por_ars: monto_usd > 0 y tc > 0                            → egreso caja USD.
//                         La financiera queda debiendo ARS = monto_usd × tc.
//  - entrega_usd_por_uyu: monto_usd > 0 y tc > 0                            → egreso caja USD.
//                         La financiera queda debiendo UYU = monto_usd × tc.
//  - recibo_ars:          monto_ars > 0 (moneda ARS)                        → ingreso caja ARS.
//  - recibo_uyu:          monto_ars > 0 (contiene monto UYU por alias legacy) → ingreso caja UYU.
//
// En todos la caja es obligatoria (integrado al ledger).
const TIPOS_ENTREGA_LOCAL = ['entrega_ars', 'entrega_uyu'];
const TIPOS_ENTREGA_USD   = ['entrega_usd_por_ars', 'entrega_usd_por_uyu'];
const TIPOS_RECIBO_USD    = ['recibo_usd', 'recibo_usd_uy'];
const TIPOS_RECIBO_LOCAL  = ['recibo_ars', 'recibo_uyu'];
const TIPOS_TODOS = [
  ...TIPOS_ENTREGA_LOCAL,
  ...TIPOS_ENTREGA_USD,
  ...TIPOS_RECIBO_USD,
  ...TIPOS_RECIBO_LOCAL,
];

const createMovimientoSchema = z.object({
  entidad_id:  z.coerce.number().int().positive('entidad_id requerido'),
  fecha,
  tipo:        z.enum(TIPOS_TODOS),
  monto_ars:   z.coerce.number().min(0).optional().default(0),
  tc:          z.coerce.number().positive().optional().nullable(),
  monto_usd:   z.coerce.number().min(0).optional().default(0),
  caja_id:     z.coerce.number().int().positive('Elegí la caja'),
  comentarios: z.string().trim().max(1000).optional().nullable(),
}).strict().superRefine((d, ctx) => {
  // Dirección A entrega local: monto local + tc.
  if (TIPOS_ENTREGA_LOCAL.includes(d.tipo)) {
    if (!(d.monto_ars > 0)) ctx.addIssue({ code: 'custom', path: ['monto_ars'], message: 'El monto local debe ser mayor a 0' });
    if (!(d.tc > 0))        ctx.addIssue({ code: 'custom', path: ['tc'], message: 'El tipo de cambio es requerido' });
    return;
  }
  // Dirección B entrega USD: monto USD + tc (para calcular deuda local).
  if (TIPOS_ENTREGA_USD.includes(d.tipo)) {
    if (!(d.monto_usd > 0)) ctx.addIssue({ code: 'custom', path: ['monto_usd'], message: 'El monto en USD debe ser mayor a 0' });
    if (!(d.tc > 0))        ctx.addIssue({ code: 'custom', path: ['tc'], message: 'El tipo de cambio es requerido' });
    return;
  }
  // Dirección A recibo USD: monto USD (sin tc, es simple ingreso).
  if (TIPOS_RECIBO_USD.includes(d.tipo)) {
    if (!(d.monto_usd > 0)) ctx.addIssue({ code: 'custom', path: ['monto_usd'], message: 'El monto en USD debe ser mayor a 0' });
    return;
  }
  // Dirección B recibo local: monto local (sin tc).
  if (TIPOS_RECIBO_LOCAL.includes(d.tipo)) {
    if (!(d.monto_ars > 0)) ctx.addIssue({ code: 'custom', path: ['monto_ars'], message: 'El monto local debe ser mayor a 0' });
    return;
  }
});

module.exports = { createEntidadSchema, updateEntidadSchema, createMovimientoSchema };

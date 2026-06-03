const { z } = require('zod');
const { fechaNoFutura } = require('./_common');

// Usamos `fechaNoFutura` del módulo compartido — antes el local `fecha` permitía
// fechas futuras (solo validaba >= 2000-01-01), incluyendo año 2099. Para
// liquidaciones/cobros/edits eso no tiene sentido: la fecha es siempre del
// pasado o presente (no se "agendan" cobros futuros desde acá).
const fecha = fechaNoFutura;

// Liquidación: el procesador deposita lo que nos debe → ingreso a una caja real.
// Resta del saldo pendiente del método de pago tarjeta.
const createLiquidacionSchema = z.object({
  metodo_pago_id: z.coerce.number().int().positive('Elegí la tarjeta'),
  fecha,
  monto:          z.coerce.number().positive('El monto debe ser mayor a 0'),
  caja_id:        z.coerce.number().int().positive('Elegí la caja donde entra'),
  comentarios:    z.string().trim().max(1000).optional().nullable(),
}).strict();

// Cobro inicial / previo (junio 2026): para cargar saldos pendientes de ventas
// anteriores al sistema. Se crea un movimiento tipo='cobro' con venta_id=NULL
// (marker de "manual/inicial" — no viene de una venta registrada en el sistema).
// El neto se calcula server-side: bruto * (1 - pct/100). El `pct` es opcional;
// si no se manda, se usa el comision_pct del método de pago.
const createCobroInicialSchema = z.object({
  metodo_pago_id: z.coerce.number().int().positive('Elegí la tarjeta'),
  fecha,
  monto_bruto:    z.coerce.number().positive('El bruto debe ser mayor a 0'),
  pct:            z.coerce.number().min(0).max(100).optional().nullable(),
  comentarios:    z.string().trim().max(1000).optional().nullable(),
}).strict();

// Editar un movimiento existente. El handler valida según el tipo:
//   - cobro previo (venta_id IS NULL): usa fecha, monto_bruto, pct, comentarios
//   - liquidación: usa fecha, monto, caja_id, comentarios (revierte caja + repone)
//   - cobro de venta (venta_id != NULL): se rechaza (se ajusta editando la venta)
// Schema laxo a propósito — el dispatch real está en el route handler.
const updateMovimientoSchema = z.object({
  fecha:        fecha.optional(),
  monto_bruto:  z.coerce.number().positive('El bruto debe ser mayor a 0').optional(),
  pct:          z.coerce.number().min(0).max(100).optional().nullable(),
  monto:        z.coerce.number().positive('El monto debe ser mayor a 0').optional(),
  caja_id:      z.coerce.number().int().positive('Elegí la caja donde entra').optional(),
  comentarios:  z.string().trim().max(1000).optional().nullable(),
}).strict().refine(
  // TANDA 3 post-auditoría: rechazar PATCH con body vacío {}. Antes hacía 200
  // con un UPDATE no-op + un audit ruidoso. Patrón consistente con el resto
  // del repo (schemas/cajas.js updateCajaSchema, schemas/contactos.js, etc.).
  (d) => Object.keys(d).some(k => d[k] !== undefined),
  { message: 'Al menos un campo es requerido para actualizar' }
);

module.exports = { createLiquidacionSchema, createCobroInicialSchema, updateMovimientoSchema };

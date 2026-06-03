const { z } = require('zod');

const fecha = z.string().date('Fecha inválida (YYYY-MM-DD)').refine(d => d >= '2000-01-01', 'Fecha anterior al año 2000');

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

module.exports = { createLiquidacionSchema, createCobroInicialSchema };

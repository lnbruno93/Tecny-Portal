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
});

module.exports = { createLiquidacionSchema };

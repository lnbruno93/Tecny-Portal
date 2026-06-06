const { z } = require('zod');

// Pago de financiera (junio 2026): además del monto ARS que descuenta del
// saldo pendiente, el operador elige una caja destino real y opcionalmente
// convierte a USD (cuando la financiera deposita en USD a un TC del día).
//
// Validaciones cruzadas vía .refine() — Zod no permite expresarlas en el
// shape básico:
//   · caja_id es obligatorio para pagos nuevos (los legacy ya están en BD).
//   · Si convertir_usd: tc y monto_usd son obligatorios.
//   · tc y monto_usd no aplican si convertir_usd=false (defensa contra
//     payload ruidoso desde el frontend).
const createPagoSchema = z.object({
  fecha:         z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  monto:         z.number().positive('Monto ARS debe ser positivo'),
  referencia:    z.string().trim().max(500).optional().nullable(),
  caja_id:       z.coerce.number().int().positive('Elegí la caja destino'),
  // No usamos z.coerce.boolean() acá — coerce hace Boolean(v), que para el
  // string "false" devuelve true (string no vacío). Eso es bug latente: un
  // POST con { convertir_usd: "false" } (curl, n8n, otro cliente) terminaría
  // convirtiendo a USD aunque el operador NO lo quiso. Aceptamos boolean
  // nativo o los strings literales 'true'/'false' y normalizamos.
  convertir_usd: z.union([
    z.boolean(),
    z.enum(['true', 'false']).transform(v => v === 'true'),
  ]).optional().default(false),
  tc:            z.coerce.number().positive('TC debe ser mayor a 0').optional(),
  monto_usd:     z.coerce.number().positive('USD recibido debe ser > 0').optional(),
}).strict().refine(
  (d) => !d.convertir_usd || (typeof d.tc === 'number' && d.tc > 0),
  { message: 'Si convertís a USD, el TC del día es obligatorio', path: ['tc'] }
).refine(
  (d) => !d.convertir_usd || (typeof d.monto_usd === 'number' && d.monto_usd > 0),
  { message: 'Si convertís a USD, el monto USD recibido es obligatorio', path: ['monto_usd'] }
).refine(
  (d) => d.convertir_usd || d.tc === undefined,
  { message: 'El TC solo aplica si convertís a USD', path: ['tc'] }
).refine(
  (d) => d.convertir_usd || d.monto_usd === undefined,
  { message: 'El monto USD solo aplica si convertís a USD', path: ['monto_usd'] }
);

const queryPagosSchema = z.object({
  desde:      z.string().date().optional(),
  hasta:      z.string().date().optional(),
  buscar:     z.string().max(200).optional(),
  page:       z.coerce.number().int().positive().optional(),
  per_page:   z.coerce.number().int().positive().max(500).optional(),
  limit:      z.coerce.number().int().positive().max(500).optional(),
  offset:     z.coerce.number().int().min(0).optional(),
});

module.exports = { createPagoSchema, queryPagosSchema };

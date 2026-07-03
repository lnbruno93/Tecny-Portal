// Zod schemas para el módulo Movimientos de Caja (transferencias entre cajas
// propias del negocio). Diseño en el header de la migration
// 20260704000001_caja_transferencias.js. Feature #505.

const { z } = require('zod');
const { fechaNoFutura } = require('./_common');

// Body para POST /api/caja-transferencias.
//  - caja_origen_id != caja_destino_id (superRefine, además del CHECK a nivel DB).
//  - monto > 0 (aceptamos con centavos porque las cajas guardan NUMERIC(14,2)).
//  - costo >= 0 y opcional. Es una comisión que sale de la caja origen ADEMÁS
//    del monto. Default 0 si no viene.
//  - moneda: mismo enum que las cajas. La validación de "coincide con moneda
//    de la caja" la hace el handler leyendo la caja de la DB (más robusto que
//    confiar en el input del cliente).
//  - descripcion opcional (max 1000). Útil para "Retiro banco Galicia 04/07".
//  - Fecha no futura (mismo helper que Cambios, Egresos, etc.).
const createTransferenciaSchema = z.object({
  fecha:            fechaNoFutura,
  caja_origen_id:   z.coerce.number().int().positive('Elegí la caja de origen'),
  caja_destino_id:  z.coerce.number().int().positive('Elegí la caja de destino'),
  moneda:           z.enum(['ARS', 'USD', 'USDT', 'UYU']),
  monto:            z.coerce.number().positive('El monto debe ser mayor a 0'),
  costo:            z.coerce.number().min(0, 'El costo no puede ser negativo').optional().default(0),
  descripcion:      z.string().trim().max(1000).optional().nullable(),
}).strict().superRefine((d, ctx) => {
  if (d.caja_origen_id === d.caja_destino_id) {
    ctx.addIssue({
      code: 'custom',
      path: ['caja_destino_id'],
      message: 'La caja de destino debe ser distinta a la de origen',
    });
  }
});

module.exports = { createTransferenciaSchema };

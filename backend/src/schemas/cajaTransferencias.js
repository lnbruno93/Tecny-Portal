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
  // 2026-07-13 (feature cross-currency): campos opcionales para transferencias
  // entre cajas de distinta moneda. El operador tipea el TC y el monto que
  // efectivamente entra en la caja destino (auto-calculado del TC en el
  // frontend, editable por redondeo).
  //
  //   Ejemplo: ARS 1.500.000 → USD 1.500 con TC=1000.
  //     - moneda: 'ARS' (origen)
  //     - monto: 1500000
  //     - moneda_destino: 'USD'
  //     - monto_destino: 1500
  //     - tc: 1000
  //
  // Same-currency: los 3 campos NULL/undefined. El backend infiere
  // moneda_destino = moneda y monto_destino = monto.
  //
  // Todo-o-nada: si viene uno, deben venir los 3. El refine lo enforcea con
  // mensaje amigable — el CHECK en DB es defensa en profundidad.
  moneda_destino:   z.enum(['ARS', 'USD', 'USDT', 'UYU']).optional().nullable(),
  monto_destino:    z.coerce.number().positive('El monto destino debe ser mayor a 0').optional().nullable(),
  tc:               z.coerce.number().positive('El TC debe ser mayor a 0').optional().nullable(),
}).strict().superRefine((d, ctx) => {
  if (d.caja_origen_id === d.caja_destino_id) {
    ctx.addIssue({
      code: 'custom',
      path: ['caja_destino_id'],
      message: 'La caja de destino debe ser distinta a la de origen',
    });
  }
  // Todo-o-nada de los 3 campos cross-currency.
  const setCount = [d.moneda_destino, d.monto_destino, d.tc].filter(x => x != null).length;
  if (setCount > 0 && setCount < 3) {
    ctx.addIssue({
      code: 'custom',
      path: ['tc'],
      message: 'Para cambio de moneda, cargá los 3 campos: moneda destino, monto destino y TC',
    });
  }
  // Sanity: si es cross-currency, moneda != moneda_destino (sino no tiene sentido usarlo).
  if (setCount === 3 && d.moneda === d.moneda_destino) {
    ctx.addIssue({
      code: 'custom',
      path: ['moneda_destino'],
      message: 'La moneda destino debe ser distinta a la de origen para usar TC',
    });
  }
});

module.exports = { createTransferenciaSchema };

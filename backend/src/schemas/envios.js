const { z } = require('zod');
// Multi-país F2: enum compartido (acepta UYU). País-aware en el handler.
const { MonedaEnum } = require('./_common');

const envioItemSchema = z.object({
  tipo:        z.enum(['producto','pago'], { error: 'tipo de item debe ser: producto, pago' }),
  descripcion: z.string().trim().max(300).optional().nullable(),
  monto:       z.number().min(0).default(0),
  metodo_pago: z.string().trim().max(100).optional().nullable(),
  // Caja donde ingresa el cobro de un item 'pago' (cualquier moneda; el frontend
  // excluye financieras y tarjetas).
  metodo_pago_id: z.coerce.number().int().positive().optional().nullable(),
  // Moneda del pago (debe coincidir con el grupo de la caja: ARS o USD/USDT).
  // El frontend la infiere de la caja elegida; default 'ARS' para compat.
  moneda: MonedaEnum.optional().default('ARS'),
  // TC opcional — necesario para items en ARS si querés monto_usd preciso.
  tc: z.number().positive().optional().nullable(),
  // Producto linkeado (para items 'producto'): si se setea + registrar_venta=true,
  // la venta auto-creada descuenta stock real de ese producto.
  producto_id: z.coerce.number().int().positive().optional().nullable(),
  // Cuenta corriente: cuando es true, este pago genera deuda en movimientos_cc
  // (a través de la venta auto-creada). Requiere envío.cliente_cc_id y registrar_venta.
  es_cuenta_corriente: z.boolean().optional().default(false),
});

const baseEnvio = z.object({
  fecha:         z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  cliente:       z.string().trim().min(1, 'Cliente requerido').max(200),
  telefono:      z.string().trim().max(30).optional().nullable(),
  direccion:     z.string().trim().min(1, 'Dirección requerida').max(300),
  barrio:        z.string().trim().max(100).optional().nullable(),
  costo_envio:   z.number().min(0).default(0),
  total_cobrado: z.number().min(0).default(0),
  horario:       z.string().trim().max(100).optional().nullable(),
  operador:      z.string().trim().max(100).optional().nullable(),
  notas:         z.string().trim().max(1000).optional().nullable(),
  estado:        z.enum(['Pendiente','En camino','Entregado','Cancelado']).default('Pendiente'),
  prioridad:     z.enum(['Alta','Media','Baja']).optional().nullable(),
  // Tipo de cambio del envío. Usado para calcular total_usd de la venta auto-creada
  // cuando los items son en ARS. Opcional: si no viene, la venta queda con total_usd=0.
  tc:            z.number().positive().optional().nullable(),
  // Cliente de cuenta corriente B2B vinculado al envío. Requerido si algún item
  // 'pago' es es_cuenta_corriente=true (para asociar la deuda con un cliente).
  cliente_cc_id: z.coerce.number().int().positive().optional().nullable(),
  items:         z.array(envioItemSchema).max(100, 'Máximo 100 items por envío').default([]),
  registrar_venta: z.boolean().optional().default(false), // crear venta asociada con los productos del envío
  // 2026-07-13 (feature vuelto Fase 2): cambio dado al cliente. Solo aplica
  // cuando `registrar_venta=true` — el egreso a caja se persiste a través
  // de la venta que crea el envío (usa las columnas `ventas.vuelto_*`).
  // Si registrar_venta=false, un vuelto sería "suelto" (sin venta madre),
  // no lo soportamos por ahora. El handler valida esta coherencia y devuelve
  // 400 explícito si el operador manda vuelto sin registrar_venta.
  //
  // 2026-07-14 (bug reportado por Lucas): agregado `vuelto_tc` — obligatorio
  // cuando la moneda del vuelto es ARS/UYU (necesario para restar el vuelto
  // convertido a USD de la ganancia_usd de la venta).
  vuelto_monto:   z.number().positive('El vuelto debe ser mayor a 0').optional().nullable(),
  vuelto_moneda:  MonedaEnum.optional().nullable(),
  vuelto_caja_id: z.coerce.number().int().positive().optional().nullable(),
  vuelto_tc:      z.coerce.number().positive('El TC del vuelto debe ser mayor a 0').optional().nullable(),
});

// Helper: valida "todo o nada" para los 3 campos de vuelto core (monto/moneda/
// caja). Idéntico al refine de `schemas/ventas.js` — mantenemos duplicado a
// propósito porque las condiciones downstream difieren (acá también se valida
// contra `registrar_venta`).
function refineVueltoTodoONada(d) {
  const set = [d.vuelto_monto, d.vuelto_moneda, d.vuelto_caja_id].filter(x => x != null).length;
  return set === 0 || set === 3;
}
const vueltoTodoONadaMsg = 'Vuelto: si cargás uno de los 3 campos (monto/moneda/caja), los 3 son obligatorios';

// 2026-07-14: si el vuelto es en moneda local (ARS/UYU), el TC es REQUERIDO.
function refineVueltoTcRequerido(d) {
  if (d.vuelto_moneda === 'ARS' || d.vuelto_moneda === 'UYU') {
    return d.vuelto_tc != null && d.vuelto_tc > 0;
  }
  return true;
}
const vueltoTcRequeridoMsg = 'Vuelto: si la moneda es ARS o UYU, el TC del vuelto es obligatorio';

// .strict(): un campo extra en POST/PUT da 400 (defensa contra typos del cliente)
const createEnvioSchema = baseEnvio.strict()
  .refine(refineVueltoTodoONada, { message: vueltoTodoONadaMsg, path: ['vuelto_monto'] })
  .refine(refineVueltoTcRequerido, { message: vueltoTcRequeridoMsg, path: ['vuelto_tc'] })
  .refine(
    // Solo permitimos vuelto cuando `registrar_venta=true`. El egreso a caja
    // se hace vía la venta que crea el envío — sin venta no hay row donde
    // persistir el vuelto ni ancla para revertir al cancelar.
    (d) => !d.vuelto_monto || d.registrar_venta === true,
    { message: 'Para cargar vuelto activá "Registrar venta"', path: ['vuelto_monto'] }
  );

// PUT — todo opcional. items sin default para que undefined signifique "no tocar"
const updateEnvioSchema = baseEnvio.omit({ items: true }).strict().partial().extend({
  items: z.array(envioItemSchema).max(100, 'Máximo 100 items por envío').optional(),
}).refine(refineVueltoTodoONada, { message: vueltoTodoONadaMsg, path: ['vuelto_monto'] })
  .refine(refineVueltoTcRequerido, { message: vueltoTcRequeridoMsg, path: ['vuelto_tc'] });

const queryEnviosSchema = z.object({
  estado: z.enum(['Pendiente','En camino','Entregado','Cancelado']).optional(),
  buscar: z.string().trim().max(200).optional(),
  desde:  z.string().date().optional(),
  hasta:  z.string().date().optional(),
  page:   z.coerce.number().int().positive().optional(),
  limit:  z.coerce.number().int().positive().max(200).optional(),
});

module.exports = { createEnvioSchema, updateEnvioSchema, queryEnviosSchema };

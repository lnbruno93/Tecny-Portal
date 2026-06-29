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
});

// .strict(): un campo extra en POST/PUT da 400 (defensa contra typos del cliente)
const createEnvioSchema = baseEnvio.strict();

// PUT — todo opcional. items sin default para que undefined signifique "no tocar"
const updateEnvioSchema = baseEnvio.omit({ items: true }).strict().partial().extend({
  items: z.array(envioItemSchema).max(100, 'Máximo 100 items por envío').optional(),
});

const queryEnviosSchema = z.object({
  estado: z.enum(['Pendiente','En camino','Entregado','Cancelado']).optional(),
  buscar: z.string().trim().max(200).optional(),
  desde:  z.string().date().optional(),
  hasta:  z.string().date().optional(),
  page:   z.coerce.number().int().positive().optional(),
  limit:  z.coerce.number().int().positive().max(200).optional(),
});

module.exports = { createEnvioSchema, updateEnvioSchema, queryEnviosSchema };

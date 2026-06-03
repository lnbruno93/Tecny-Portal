const { z } = require('zod');
const { TIPOS_CONTACTO, ORIGENES } = require('./contactos');

// Mega-form (PR #78 + post-auditoría TANDA 0): el frontend de Inversión/Deuda
// permite crear contacto y movimiento en un solo step. Antes hacía 2 requests
// HTTP separados — si el segundo fallaba, quedaba contacto huérfano. Ahora se
// puede mandar `contacto_nuevo` en lugar de `contacto_id` y el backend crea
// ambos en la misma tx. Schema reusado por createDeudaSchema y createInversionSchema.
const contactoNuevoSchema = z.object({
  nombre:   z.string().trim().min(1, 'Nombre requerido').max(100),
  apellido: z.string().trim().max(100).optional().nullable(),
  tipo:     z.enum(TIPOS_CONTACTO).optional(),
}).strict();

// XOR refinement: o contacto_id o contacto_nuevo, exactamente uno. Si el
// frontend manda los dos, error claro; si no manda ninguno, también error.
function refineContactoXor(d) {
  return (!!d.contacto_id) !== (!!d.contacto_nuevo);
}
const xorMessage = { message: 'Enviá contacto_id (existente) o contacto_nuevo (a crear), exactamente uno', path: ['contacto_id'] };

// ─── DEUDAS ─────────────────────────────────────────────────

const createDeudaSchema = z.object({
  fecha:          z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  // contacto_id Y contacto_nuevo son opcionales individualmente; el refine de
  // abajo garantiza que se mande exactamente uno.
  contacto_id:    z.number().int().positive('contacto_id inválido').optional(),
  contacto_nuevo: contactoNuevoSchema.optional(),
  tipo:           z.enum(['debe','pago'], { error: 'tipo debe ser: debe, pago' }),
  monto_ars:      z.number().min(0).default(0),
  monto_usd:      z.number().min(0).default(0),
  concepto:       z.string().trim().max(500).optional().nullable(),
}).strict().refine(d => d.monto_ars > 0 || d.monto_usd > 0, {
  message: 'Al menos monto_ars o monto_usd debe ser mayor a 0',
  path: ['monto_ars'],
}).refine(refineContactoXor, xorMessage);

const queryDeudasSchema = z.object({
  contacto_id: z.coerce.number().int().positive().optional(),
  page:        z.coerce.number().int().positive().optional(),
  // El frontend pide limit=500 para traer el ledger completo de un solo golpe
  // (el listado se agrupa por contacto en memoria). max(200) rompía la pantalla
  // de Deudas a cobrar con 400 "Datos inválidos" → KPIs en 0 sin pista visible.
  limit:       z.coerce.number().int().positive().max(500).optional(),
});

// ─── INVERSIONES ────────────────────────────────────────────

const createInversionSchema = z.object({
  fecha:          z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  contacto_id:    z.number().int().positive('contacto_id inválido').optional(),
  contacto_nuevo: contactoNuevoSchema.optional(),
  monto:          z.number().positive('Monto debe ser positivo'),
  tasa:           z.string().trim().max(50).optional().nullable(),
}).strict().refine(refineContactoXor, xorMessage);

const queryInversionesSchema = z.object({
  contacto_id: z.coerce.number().int().positive().optional(),
  page:        z.coerce.number().int().positive().optional(),
  // Mismo motivo que queryDeudasSchema: el frontend pide limit=500.
  limit:       z.coerce.number().int().positive().max(500).optional(),
});

// ─── CAJAS (cuentas de dinero = metodos_pago) ───────────────
// Las cajas son las cuentas donde caen los pagos (USD Efectivo, Banco, Mercado Pago…).
// Se gestionan desde la hoja "Config Cajas" del módulo Cajas.

const cajaSchema = z.object({
  nombre:        z.string().trim().min(1, 'Nombre requerido').max(80),
  moneda:        z.enum(['USD', 'ARS', 'USDT'], { error: 'moneda debe ser: USD, ARS, USDT' }).default('ARS'),
  activo:        z.boolean().optional(),
  orden:         z.coerce.number().int().min(0).optional(),
  saldo_inicial: z.coerce.number().min(0, 'El saldo inicial no puede ser negativo').optional(),  // saldo de apertura (en la moneda de la caja)
  es_financiera: z.boolean().optional(),         // marca esta caja como "la financiera"
  es_tarjeta:    z.boolean().optional(),         // marca este método como tarjeta (cobro automático desde Ventas)
  comision_pct:  z.coerce.number().min(0).max(100).optional().nullable(), // % que retiene la financiera
}).strict();

const updateCajaSchema = z.object({
  nombre:        z.string().trim().min(1).max(80).optional(),
  moneda:        z.enum(['USD', 'ARS', 'USDT']).optional(),
  activo:        z.boolean().optional(),
  orden:         z.coerce.number().int().min(0).optional(),
  saldo_inicial: z.coerce.number().min(0, 'El saldo inicial no puede ser negativo').optional(),
  es_financiera: z.boolean().optional(),
  es_tarjeta:    z.boolean().optional(),
  comision_pct:  z.coerce.number().min(0).max(100).optional().nullable(),
}).strict().refine(d => Object.values(d).some(v => v !== undefined), {
  message: 'Al menos un campo es requerido para actualizar',
});

// Ajuste manual de caja (ingreso/egreso suelto, origen 'ajuste')
const cajaAjusteSchema = z.object({
  fecha:    z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  tipo:     z.enum(['ingreso', 'egreso'], { error: 'tipo debe ser: ingreso, egreso' }),
  monto:    z.coerce.number().positive('El monto debe ser mayor a 0'),
  tc:       z.coerce.number().positive().optional().nullable(),  // requerido si la caja es ARS
  concepto: z.string().trim().max(300).optional().nullable(),
}).strict();

// Ledger global: movimientos de todas las cajas con filtros (vista dedicada)
const ORIGENES_CAJA = ['venta', 'b2b', 'financiera', 'envio', 'egreso', 'proveedor', 'transferencia', 'ajuste', 'cambio', 'tarjeta'];
const queryLedgerSchema = z.object({
  caja_id: z.coerce.number().int().positive().optional(),
  desde:   z.string().date().optional(),
  hasta:   z.string().date().optional(),
  origen:  z.enum(ORIGENES_CAJA).optional(),
  tipo:    z.enum(['ingreso', 'egreso']).optional(),
  page:    z.coerce.number().int().positive().optional(),
  limit:   z.coerce.number().int().positive().max(200).optional(),
});

module.exports = {
  createDeudaSchema,
  queryDeudasSchema,
  createInversionSchema,
  queryInversionesSchema,
  cajaSchema,
  updateCajaSchema,
  cajaAjusteSchema,
  queryLedgerSchema,
};

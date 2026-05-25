const { z } = require('zod');

const createProveedorSchema = z.object({
  nombre:            z.string().trim().min(1, 'Nombre del proveedor requerido').max(120),
  contacto_nombre:   z.string().trim().max(80).optional().nullable(),
  contacto_apellido: z.string().trim().max(80).optional().nullable(),
  whatsapp:          z.string().trim().max(40).optional().nullable(),
  ubicacion:         z.string().trim().max(200).optional().nullable(),
  notas:             z.string().trim().max(2000).optional().nullable(),
  // Saldo inicial en USD (lo que ya le debemos al arrancar la cuenta). Opcional.
  saldo_inicial:     z.coerce.number().min(0).optional().nullable(),
});

// Para actualizar NO se permite saldo_inicial (es solo de apertura)
const updateProveedorSchema = createProveedorSchema.omit({ saldo_inicial: true }).partial().refine(
  d => Object.values(d).some(v => v !== undefined),
  { message: 'Al menos un campo es requerido para actualizar' }
);

// Ítem de una compra (productos comprados) — espejo de items_movimiento_cc (B2B)
const itemProveedorSchema = z.object({
  producto:    z.string().trim().max(100).optional().nullable(),
  modelo:      z.string().trim().max(100).optional().nullable(),
  tamano:      z.string().trim().max(50).optional().nullable(),
  color:       z.string().trim().max(50).optional().nullable(),
  imei_serial: z.string().trim().max(100).optional().nullable(),
  valor:       z.coerce.number().nonnegative('Valor no puede ser negativo').optional().nullable(),
  verificado:  z.boolean().optional().default(false),
  notas:       z.string().trim().max(500).optional().nullable(),
});

const createMovimientoProveedorSchema = z.object({
  proveedor_id: z.coerce.number().int().positive('proveedor_id inválido'),
  fecha:        z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  tipo:         z.enum(['compra', 'pago'], { error: 'tipo debe ser: compra, pago' }),
  descripcion:  z.string().trim().max(500).optional().nullable(),
  monto:        z.coerce.number().min(0).default(0),
  moneda:       z.enum(['USD', 'ARS', 'USDT']).default('USD'),
  tc:           z.coerce.number().positive().optional().nullable(),
  caja_id:      z.coerce.number().int().positive().optional().nullable(),
  notas:        z.string().trim().max(1000).optional().nullable(),
  // items solo aplica a 'compra' (productos comprados); la ruta los ignora en 'pago'
  items:        z.array(itemProveedorSchema).max(200, 'Máximo 200 ítems por compra').optional().default([]),
}).refine(d => d.moneda !== 'ARS' || (d.tc && d.tc > 0), {
  message: 'Para montos en ARS se requiere el tipo de cambio (tc)',
  path: ['tc'],
});

module.exports = {
  createProveedorSchema,
  updateProveedorSchema,
  createMovimientoProveedorSchema,
};

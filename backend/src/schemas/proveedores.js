const { z } = require('zod');
const { baseProducto } = require('./inventario');

const createProveedorSchema = z.object({
  nombre:            z.string().trim().min(1, 'Nombre del proveedor requerido').max(120),
  contacto_nombre:   z.string().trim().max(80).optional().nullable(),
  contacto_apellido: z.string().trim().max(80).optional().nullable(),
  whatsapp:          z.string().trim().max(40).optional().nullable(),
  ubicacion:         z.string().trim().max(200).optional().nullable(),
  notas:             z.string().trim().max(2000).optional().nullable(),
  // Saldo inicial en USD (lo que ya le debemos al arrancar la cuenta). Opcional.
  saldo_inicial:     z.coerce.number().min(0).optional().nullable(),
}).strict();

// Al actualizar también se puede ajustar el saldo inicial (movimiento de apertura)
const updateProveedorSchema = createProveedorSchema.partial().refine(
  d => Object.values(d).some(v => v !== undefined),
  { message: 'Al menos un campo es requerido para actualizar' }
);

// Sub-objeto opcional para crear producto en Inventario cuando se carga una
// compra. Reutiliza el mismo schema de Inventario (sin foto, sin estado: la
// carga arranca como 'disponible' por default de DB). Si no se incluye, el
// item queda sólo como log de la compra (caso: gasto / flete / servicio).
const productoEnCompraSchema = baseProducto
  .omit({ foto_data: true, foto_nombre: true, foto_tipo: true })
  .strict()
  // Reglas de coherencia: las mismas que el create normal del Inventario.
  .refine(p => !(p.clase === 'celular' && p.tipo_carga === 'unitario' && p.cantidad !== 1),
    { message: 'Un celular unitario debe tener cantidad = 1', path: ['cantidad'] })
  .refine(p => p.categoria_id != null && Number(p.categoria_id) > 0,
    { message: 'La categoría es obligatoria para crear el producto en stock',
      path: ['categoria_id'] });

// Ítem de una compra (productos comprados) — espejo de items_movimiento_cc (B2B)
// Si viene `producto_stock`, la ruta crea además el producto en Inventario.
const itemProveedorSchema = z.object({
  producto:    z.string().trim().max(100).optional().nullable(),
  modelo:      z.string().trim().max(100).optional().nullable(),
  tamano:      z.string().trim().max(50).optional().nullable(),
  color:       z.string().trim().max(50).optional().nullable(),
  imei_serial: z.string().trim().max(100).optional().nullable(),
  valor:       z.coerce.number().nonnegative('Valor no puede ser negativo').optional().nullable(),
  verificado:  z.boolean().optional().default(false),
  notas:       z.string().trim().max(500).optional().nullable(),
  // Opcional. Si se envía, además de loguear el item, la ruta INSERT-a el
  // producto en `productos`. El proveedor del producto se llena auto con
  // el nombre del proveedor de la compra (#H-06, no se acepta override).
  producto_stock: productoEnCompraSchema.optional().nullable(),
}).strict(); // #H-08 — rechaza campos extra para defense-in-depth

const createMovimientoProveedorSchema = z.object({
  proveedor_id: z.coerce.number().int().positive('proveedor_id inválido'),
  // Fecha: misma regla que cuentas — no futura, no anterior al 2000
  // (auditoría #B-08 — antes proveedores aceptaba 2099).
  fecha:        z.string().date('Fecha inválida — usar YYYY-MM-DD').refine(d => {
    const todayUTC = new Date().toISOString().split('T')[0];
    return d >= '2000-01-01' && d <= todayUTC;
  }, 'La fecha no puede ser futura ni anterior al año 2000'),
  tipo:         z.enum(['compra', 'pago'], { error: 'tipo debe ser: compra, pago' }),
  descripcion:  z.string().trim().max(500).optional().nullable(),
  // Hard cap: 10M USD por movimiento (auditoría #B-04).
  monto:        z.coerce.number().min(0).max(10_000_000, 'Monto excede el máximo (10M)').default(0),
  moneda:       z.enum(['USD', 'ARS', 'USDT']).default('USD'),
  tc:           z.coerce.number().positive().optional().nullable(),
  caja_id:      z.coerce.number().int().positive().optional().nullable(),
  notas:        z.string().trim().max(1000).optional().nullable(),
  // items solo aplica a 'compra' (productos comprados); la ruta los ignora en 'pago'
  items:        z.array(itemProveedorSchema).max(200, 'Máximo 200 ítems por compra').optional().default([]),
}).strict().refine(d => d.moneda !== 'ARS' || (d.tc && d.tc > 0), {
  message: 'Para montos en ARS se requiere el tipo de cambio (tc)',
  path: ['tc'],
});

module.exports = {
  createProveedorSchema,
  updateProveedorSchema,
  createMovimientoProveedorSchema,
};

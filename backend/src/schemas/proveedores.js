const { z } = require('zod');
const { baseProducto } = require('./inventario');
const { fechaNoFutura, MonedaEnum, requiereTc } = require('./_common');

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
//
// F3.d-3 (2026-07-09): la regla `unitarioCoherente` se removió del schema
// (necesitaba `p.clase` del body, dropeado en la serie F3). El handler de
// routes/proveedores.js valida coherencia unitario ↔ cantidad tras el
// derive del slug_legacy desde clase_id, mismo patrón que routes/inventario.js.
//
// 2026-07-11: categoria_id pasó a opcional (coherente con schemas/inventario.js).
// Ver comentario allí sobre el sunset gradual de la dimensión "Colección".
const productoEnCompraSchema = baseProducto
  .omit({ foto_data: true, foto_nombre: true, foto_tipo: true })
  .strict();

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
  // Fecha con validación compartida (M-07): no futura, no antes del 2000.
  fecha:        fechaNoFutura,
  tipo:         z.enum(['compra', 'pago'], { error: 'tipo debe ser: compra, pago' }),
  descripcion:  z.string().trim().max(500).optional().nullable(),
  // Hard cap: 10M USD por movimiento (auditoría #B-04).
  monto:        z.coerce.number().min(0).max(10_000_000, 'Monto excede el máximo (10M)').default(0),
  moneda:       MonedaEnum.default('USD'),
  tc:           z.coerce.number().positive().optional().nullable(),
  caja_id:      z.coerce.number().int().positive().optional().nullable(),
  notas:        z.string().trim().max(1000).optional().nullable(),
  // items solo aplica a 'compra' (productos comprados); la ruta los ignora en 'pago'
  items:        z.array(itemProveedorSchema).max(200, 'Máximo 200 ítems por compra').optional().default([]),
}).strict()
  // 2026-07-08 Multi-país F2 backfill: antes solo cubría ARS; UYU tenía el
  // mismo bug (`toUsd(m,'UYU',null)=0` → saldo del proveedor corrupto).
  .refine(d => !requiereTc(d.moneda) || (d.tc && d.tc > 0), {
    message: 'Para montos en ARS o UYU se requiere el tipo de cambio (tc)',
    path: ['tc'],
  })
  // #M-02: si la compra crea productos, el monto debe ser > 0 (antes se
  // podía mandar monto=0 con producto_stock → producto "gratis" sin
  // auditoría de caja).
  .refine(d => {
    if (d.tipo !== 'compra') return true;
    const tieneStock = (d.items || []).some(it => it.producto_stock);
    if (!tieneStock) return true;
    return Number(d.monto) > 0;
  }, {
    message: 'Una compra que crea productos en Inventario debe tener monto > 0',
    path: ['monto'],
  });

// Resolve-or-create bulk de proveedores — usado por el import de stock.
// Solo recibe `nombres` (no contacto/ubicación/etc) porque el flow de import
// solo necesita sembrar la tabla para autocomplete en futuras compras.
const nombresBulkProveedoresSchema = z.object({
  nombres: z.array(z.string().trim().min(1).max(200)).max(500, 'Máximo 500 nombres por lote'),
}).strict();

// Bulk multi-proveedor (2026-06-14) — usado por el import XLSX cuando el archivo
// trae productos de distintos proveedores en una sola carga.
//
// Cada elemento del array es un movimiento completo (mismo shape que el POST
// single). El backend procesa TODOS en una sola transacción: si cualquiera
// falla (IMEI duplicado, monto inválido, proveedor inexistente, etc.), NINGUNO
// se persiste. Esto evita estados intermedios donde unos productos quedaron
// cargados y otros no.
//
// El límite (50 movimientos × 200 items c/u = 10K items) cubre cómodamente
// cualquier import realista de un solo XLSX. Si llega a hacer falta más, ver
// performance del UNNEST + memoria de la transacción antes de subirlo.
const bulkCreateMovimientosProveedorSchema = z.object({
  movimientos: z.array(createMovimientoProveedorSchema)
    .min(1, 'Al menos 1 movimiento es requerido')
    .max(50, 'Máximo 50 movimientos por bulk (uno por proveedor en el XLSX)'),
}).strict();

module.exports = {
  createProveedorSchema,
  updateProveedorSchema,
  createMovimientoProveedorSchema,
  bulkCreateMovimientosProveedorSchema,
  nombresBulkProveedoresSchema,
};

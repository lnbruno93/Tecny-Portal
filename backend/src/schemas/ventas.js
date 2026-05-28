const { z } = require('zod');

const HORA_RE = /^\d{2}:\d{2}(:\d{2})?$/;

/* ── Sub-objetos de una venta ── */
const ventaItemSchema = z.object({
  producto_id:     z.coerce.number().int().positive().optional().nullable(),
  vendedor_id:     z.coerce.number().int().positive().optional().nullable(),
  descripcion:     z.string().trim().min(1, 'Descripción requerida').max(300),
  imei:            z.string().trim().max(50).optional().nullable(),
  cantidad:        z.coerce.number().int().positive().default(1),
  precio_vendido:  z.coerce.number().min(0).default(0),
  precio_original: z.coerce.number().min(0).optional().nullable(),
  costo:           z.coerce.number().min(0).default(0),
  moneda:          z.enum(['USD', 'ARS']).default('USD'),
  comision:        z.coerce.number().min(0).default(0),
});

const ventaPagoSchema = z.object({
  metodo_pago_id:      z.coerce.number().int().positive().optional().nullable(),
  metodo_nombre:       z.string().trim().min(1, 'Método requerido').max(120),
  monto:               z.coerce.number().min(0).default(0),
  moneda:              z.enum(['USD', 'ARS', 'USDT']).default('ARS'),
  tc:                  z.coerce.number().positive().optional().nullable(),
  es_cuenta_corriente: z.boolean().default(false),
});

const canjeSchema = z.object({
  descripcion:   z.string().trim().min(1, 'Descripción del canje requerida').max(300),
  imei:          z.string().trim().max(50).optional().nullable(),
  gb:            z.string().trim().max(20).optional().nullable(),
  color:         z.string().trim().max(60).optional().nullable(),
  bateria:       z.coerce.number().int().min(0).max(100).optional().nullable(),
  valor_toma:    z.coerce.number().min(0).default(0),
  moneda:        z.enum(['USD', 'ARS']).default('USD'),
  agregar_stock: z.boolean().default(false),
});

/* ── Venta ── */
const createVentaSchema = z.object({
  fecha:          z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  hora:           z.string().regex(HORA_RE, 'Hora inválida').optional().nullable(),
  cliente_id:     z.coerce.number().int().positive().optional().nullable(),
  cliente_cc_id:  z.coerce.number().int().positive().optional().nullable(),
  cliente_nombre: z.string().trim().max(200).optional().nullable(),
  etiqueta_id:    z.coerce.number().int().positive().optional().nullable(),
  estado:         z.enum(['acreditado', 'pendiente', 'cancelado']).default('pendiente'),
  tc_venta:       z.coerce.number().positive().optional().nullable(),
  tc_compra:      z.coerce.number().positive().optional().nullable(),
  garantia_id:    z.coerce.number().int().positive().optional().nullable(),
  notas:          z.string().trim().max(1000).optional().nullable(),
  items:          z.array(ventaItemSchema).min(1, 'Agregá al menos un producto'),
  pagos:          z.array(ventaPagoSchema).default([]),
  canjes:         z.array(canjeSchema).default([]),
}).strict();

// Edición de metadatos (no se editan items/pagos para no descuadrar el stock).
const updateVentaSchema = z.object({
  estado:         z.enum(['acreditado', 'pendiente', 'cancelado']).optional(),
  etiqueta_id:    z.coerce.number().int().positive().optional().nullable(),
  garantia_id:    z.coerce.number().int().positive().optional().nullable(),
  cliente_id:     z.coerce.number().int().positive().optional().nullable(),
  cliente_cc_id:  z.coerce.number().int().positive().optional().nullable(),
  cliente_nombre: z.string().trim().max(200).optional().nullable(),
  notas:          z.string().trim().max(1000).optional().nullable(),
  // Edición completa (opcional): si se envían items, se recalculan totales y stock.
  hora:           z.string().regex(HORA_RE, 'Hora inválida').optional().nullable(),
  tc_venta:       z.coerce.number().positive().optional().nullable(),
  items:          z.array(ventaItemSchema).min(1, 'Agregá al menos un producto').optional(),
  pagos:          z.array(ventaPagoSchema).optional(),
  canjes:         z.array(canjeSchema).optional(),
}).strict();

/* ── Plantillas de garantía ── */
const garantiaSchema = z.object({
  nombre:     z.string().trim().min(1, 'Nombre requerido').max(80),
  texto:      z.string().trim().min(1, 'Texto requerido').max(4000),
  es_default: z.boolean().optional(),
});

const updateGarantiaSchema = z.object({
  nombre:     z.string().trim().min(1).max(80).optional(),
  texto:      z.string().trim().min(1).max(4000).optional(),
  es_default: z.boolean().optional(),
});

const queryVentasSchema = z.object({
  desde:       z.string().date().optional(),
  hasta:       z.string().date().optional(),
  estado:      z.enum(['acreditado', 'pendiente', 'cancelado']).optional(),
  etiqueta_id: z.coerce.number().int().positive().optional(),
  buscar:      z.string().trim().max(200).optional(),
  page:        z.coerce.number().int().positive().optional(),
  limit:       z.coerce.number().int().positive().max(200).optional(),
});

/* ── Comprobantes de venta ── */
// archivo_tipo se restringe a un enum acotado para evitar XSS al renderizar
// el comprobante en una ventana nueva (el visor inserta `data:<tipo>;base64,...`).
const comprobanteVentaSchema = z.object({
  archivo_data:   z.string().min(1, 'Archivo requerido').max(9_000_000, 'Archivo demasiado grande')
                   // base64, con prefijo data-URL opcional (el frontend lo manda via FileReader.readAsDataURL).
                   .regex(/^(data:[a-z0-9/+.-]+;base64,)?[A-Za-z0-9+/=\s]+$/i, 'Archivo inválido (debe ser base64)'),
  archivo_nombre: z.string().trim().max(255).optional().nullable(),
  archivo_tipo:   z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], {
                   error: 'Tipo de archivo no permitido (solo jpg/png/webp/pdf)'
                 }).optional().nullable(),
});

/* ── Etiquetas ── */
const etiquetaSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(80),
  color:  z.string().trim().max(20).optional().nullable(),
});

/* ── Egresos ── */
const createEgresoSchema = z.object({
  fecha:          z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  concepto:       z.string().trim().min(1, 'Concepto requerido').max(300),
  monto:          z.coerce.number().min(0).default(0),
  moneda:         z.enum(['USD', 'ARS', 'USDT']).default('USD'),
  tc:             z.coerce.number().positive().optional().nullable(),
  metodo_pago_id: z.coerce.number().int().positive().optional().nullable(),
  notas:          z.string().trim().max(500).optional().nullable(),
});

const queryEgresosSchema = z.object({
  desde: z.string().date().optional(),
  hasta: z.string().date().optional(),
  page:  z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const queryDashboardSchema = z.object({
  desde: z.string().date().optional(),
  hasta: z.string().date().optional(),
});

/* ── Ventas rápidas ── */
const createVentaRapidaSchema = z.object({
  vendedor_id:     z.coerce.number().int().positive().optional().nullable(),
  vendedor_nombre: z.string().trim().max(120).optional().nullable(),
  cliente_texto:   z.string().trim().max(200).optional().nullable(),
  detalle:         z.string().trim().min(1, 'Detalle requerido').max(2000),
  fecha:           z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  hora:            z.string().regex(HORA_RE, 'Hora inválida').optional().nullable(),
});

const updateVentaRapidaSchema = z.object({
  detalle:         z.string().trim().min(1).max(2000).optional(),
  cliente_texto:   z.string().trim().max(200).optional().nullable(),
  vendedor_nombre: z.string().trim().max(120).optional().nullable(),
  estado:          z.enum(['pendiente', 'procesada']).optional(),
  venta_id:        z.coerce.number().int().positive().optional().nullable(),
});

module.exports = {
  createVentaSchema, updateVentaSchema, queryVentasSchema,
  etiquetaSchema,
  garantiaSchema, updateGarantiaSchema,
  comprobanteVentaSchema,
  createEgresoSchema, queryEgresosSchema, queryDashboardSchema,
  createVentaRapidaSchema, updateVentaRapidaSchema,
};

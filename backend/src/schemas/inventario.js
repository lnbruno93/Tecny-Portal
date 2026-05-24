const { z } = require('zod');

// --- Catálogos simples ---
const nombreSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(120),
});

// --- Productos ---
const baseProducto = z.object({
  tipo_carga:     z.enum(['unitario', 'lote']).default('unitario'),
  clase:          z.enum(['celular', 'accesorio']).default('celular'),
  nombre:         z.string().trim().min(1, 'Nombre requerido').max(200),
  imei:           z.string().trim().max(50).optional().nullable(),
  gb:             z.string().trim().max(20).optional().nullable(),
  color:          z.string().trim().max(60).optional().nullable(),
  bateria:        z.coerce.number().int().min(0).max(100).optional().nullable(),
  categoria_id:   z.coerce.number().int().positive().optional().nullable(),
  deposito_id:    z.coerce.number().int().positive().optional().nullable(),
  proveedor:      z.string().trim().max(200).optional().nullable(),
  costo:          z.coerce.number().min(0).default(0),
  costo_moneda:   z.enum(['USD', 'ARS']).default('USD'),
  precio_venta:   z.coerce.number().min(0).default(0),
  precio_moneda:  z.enum(['USD', 'ARS']).default('USD'),
  trackear_stock: z.boolean().default(true),
  cantidad:       z.coerce.number().int().min(0).default(1),
  estado:         z.enum(['disponible', 'vendido', 'en_tecnico', 'reservado']).default('disponible'),
  foto_data:      z.string().max(10_000_000).optional().nullable(),
  foto_nombre:    z.string().trim().max(255).optional().nullable(),
  foto_tipo:      z.string().trim().max(100).optional().nullable(),
  observaciones:  z.string().trim().max(1000).optional().nullable(),
});

const createProductoSchema = baseProducto;

const updateProductoSchema = baseProducto.partial();

// Carga masiva: array de productos (sin foto para mantener el payload acotado)
const bulkProductoSchema = z.object({
  productos: z.array(baseProducto.omit({ foto_data: true, foto_nombre: true, foto_tipo: true }))
    .min(1, 'Al menos un producto')
    .max(500, 'Máximo 500 productos por carga'),
});

const queryProductosSchema = z.object({
  buscar:       z.string().trim().max(200).optional(),
  clase:        z.enum(['celular', 'accesorio']).optional(),
  estado:       z.enum(['disponible', 'vendido', 'en_tecnico', 'reservado']).optional(),
  categoria_id: z.coerce.number().int().positive().optional(),
  deposito_id:  z.coerce.number().int().positive().optional(),
  solo_stock:   z.coerce.boolean().optional(),
  page:         z.coerce.number().int().positive().optional(),
  limit:        z.coerce.number().int().positive().max(200).optional(),
});

module.exports = {
  nombreSchema,
  createProductoSchema,
  updateProductoSchema,
  bulkProductoSchema,
  queryProductosSchema,
};

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
  // Enum cerrado: la auditoría detectó que un user con permiso `inventario`
  // podía cargar foto_tipo='image/svg+xml' con un SVG malicioso (XSS al render).
  // CSP del frontend bloquea scripts inline, pero SVG inline puede ejecutar
  // JS dentro del <svg> propio. Cerramos el enum para defense in depth.
  // Mismo set que `comprobantes`/`venta_comprobantes`.
  foto_tipo:      z.enum(['image/jpeg', 'image/png', 'image/webp']).optional().nullable(),
  observaciones:  z.string().trim().max(1000).optional().nullable(),
});

// Regla de coherencia: celular unitario => cantidad = 1.
const unitarioCoherente = (p) => !(p.clase === 'celular' && p.tipo_carga === 'unitario' && p.cantidad !== 1);
const unitarioMsg = { message: 'Un celular unitario debe tener cantidad = 1', path: ['cantidad'] };

// Categoría obligatoria al crear/cargar bulk (para que el inventario sea analizable).
// En UPDATE queda opcional: los productos legacy sin categoría se pueden editar
// (asignándoles una en ese momento) sin que el backend bloquee otros cambios.
const categoriaRequerida = (p) => p.categoria_id != null && Number(p.categoria_id) > 0;
const categoriaMsg = { message: 'La categoría es obligatoria', path: ['categoria_id'] };

// .strict(): un campo extra (typo del cliente, JS field leak) da 400 explícito
// en vez de pasar silencioso y persistirse sin querer / ser ignorado.
const createProductoSchema = baseProducto.strict()
  .refine(unitarioCoherente, unitarioMsg)
  .refine(categoriaRequerida, categoriaMsg);

const updateProductoSchema = baseProducto.strict().partial(); // partial → coherencia se chequea al leer DB

// Carga masiva: array de productos (sin foto para mantener el payload acotado).
// Refines: coherencia unitario por item + sin IMEIs duplicados dentro del lote (no hay UNIQUE en DB todavía).
const productoEnBulk = baseProducto.omit({ foto_data: true, foto_nombre: true, foto_tipo: true }).strict()
  .refine(unitarioCoherente, unitarioMsg)
  .refine(categoriaRequerida, categoriaMsg);
const bulkProductoSchema = z.object({
  productos: z.array(productoEnBulk)
    .min(1, 'Al menos un producto')
    .max(500, 'Máximo 500 productos por carga')
    .refine((arr) => {
      const vistos = new Set();
      for (const p of arr) {
        const i = (p.imei || '').trim();
        if (!i) continue;
        if (vistos.has(i)) return false;
        vistos.add(i);
      }
      return true;
    }, { message: 'Hay IMEIs duplicados en el lote' }),
});

const queryProductosSchema = z.object({
  buscar:       z.string().trim().max(200).optional(),
  clase:        z.enum(['celular', 'accesorio']).optional(),
  estado:       z.enum(['disponible', 'vendido', 'en_tecnico', 'reservado']).optional(),
  categoria_id: z.coerce.number().int().positive().optional(),
  deposito_id:  z.coerce.number().int().positive().optional(),
  // Filtros EXACTOS (igualdad). Útiles para drill-down desde Desglose 360
  // — distintos de `buscar` que es ILIKE sobre múltiples columnas.
  nombre:       z.string().trim().max(200).optional(),
  proveedor:    z.string().trim().max(200).optional(),
  gb:           z.string().trim().max(20).optional(),
  color:        z.string().trim().max(60).optional(),
  solo_stock:   z.coerce.boolean().optional(),
  page:         z.coerce.number().int().positive().optional(),
  limit:        z.coerce.number().int().positive().max(200).optional(),
});

// Desglose 360: agrupar el inventario por una dimensión y aplicar filtros.
// Las 7 dimensiones expuestas se mapean a una expresión SQL segura en el
// router (no se concatena input del cliente al SQL).
const DIMENSIONES_DESGLOSE = ['categoria', 'proveedor', 'modelo', 'estado', 'deposito', 'gb', 'color'];
const queryDesgloseSchema = z.object({
  por:          z.enum(DIMENSIONES_DESGLOSE),
  clase:        z.enum(['celular', 'accesorio']).optional(),
  estado:       z.enum(['disponible', 'vendido', 'en_tecnico', 'reservado']).optional(),
  categoria_id: z.coerce.number().int().positive().optional(),
  deposito_id:  z.coerce.number().int().positive().optional(),
  proveedor:    z.string().trim().max(200).optional(),
  solo_stock:   z.coerce.boolean().optional(),
  buscar:       z.string().trim().max(200).optional(),
});

module.exports = {
  nombreSchema,
  createProductoSchema,
  updateProductoSchema,
  bulkProductoSchema,
  queryProductosSchema,
  queryDesgloseSchema,
  DIMENSIONES_DESGLOSE,
};

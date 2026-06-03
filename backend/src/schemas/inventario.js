const { z } = require('zod');

// --- Catálogos simples ---
const nombreSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(120),
});

// Resolve-or-create bulk de catálogos (categorías, depósitos) — usado por el
// import de stock para no hacer N round-trips HTTP. El backend dedup + ON CONFLICT.
const nombresBulkSchema = z.object({
  nombres: z.array(z.string().trim().min(1).max(120)).max(500, 'Máximo 500 nombres por lote'),
}).strict();

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
  // Nuevos ejes de organización del inventario (mayo-2026):
  //   - `condicion`: ortogonal a la categoría. Permite distinguir Nuevo / Usado
  //     sin duplicar el árbol de categorías y habilita el tab "Usados" en la UI.
  //   - `oculto`: sacar de la vista por defecto sin borrar; útil para limpiar
  //     la grilla manteniendo histórico de productos descontinuados.
  //
  // Importante: NO usamos `.default()` acá porque al hacer `.partial()` para
  // el UPDATE, Zod popularía estos campos cuando el cliente no los manda y
  // romperíamos el patrón `COALESCE($i, col)` (siempre sobrescribiría). Los
  // defaults reales viven en la columna DB (DEFAULT 'nuevo' / DEFAULT false)
  // y se inyectan en el POST a mano (req.body.condicion ?? 'nuevo', etc).
  condicion:      z.enum(['nuevo', 'usado']).optional(),
  oculto:         z.boolean().optional(),
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

// Vistas predefinidas para la grilla del inventario. Encapsulan la combinación
// de filtros (estado + oculto) que el PO quiere ver con un sólo selector.
// El default se aplica en el router (no acá) para que la ausencia del query
// param signifique "vista por defecto" y no rompa endpoints legacy.
const VISTAS_INVENTARIO = [
  'no_vendidos',           // estado != vendido  AND oculto = false  ← default
  'no_vendidos_ocultos',   // estado != vendido  AND oculto = true
  'ocultos',               //                       oculto = true   (cualquier estado)
  'vendidos',              // estado = vendido   AND oculto = false
  'todos_visibles',        //                       oculto = false  (cualquier estado)
  'todos_ocultos',         //                       (sin filtro: vendidos + ocultos + lo demás)
];

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
  // Filtros nuevos:
  vista:        z.enum(VISTAS_INVENTARIO).optional(),
  condicion:    z.enum(['nuevo', 'usado']).optional(),
  // Legacy (compat): `solo_stock=true` se mapea a vista='no_vendidos' si no se
  // pasó `vista` explícita. El router resuelve la prioridad.
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
  nombresBulkSchema,
  baseProducto,                // se reutiliza desde proveedores (compra crea stock)
  createProductoSchema,
  updateProductoSchema,
  bulkProductoSchema,
  queryProductosSchema,
  queryDesgloseSchema,
  DIMENSIONES_DESGLOSE,
  VISTAS_INVENTARIO,
};

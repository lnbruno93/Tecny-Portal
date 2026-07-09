const { z } = require('zod');
// Multi-país F2: enum compartido (acepta UYU). País-aware en el handler.
const { MonedaEnum } = require('./_common');
// Categorías reales F1 (2026-07-08): 9 categorías en vez de celular/accesorio.
const { CLASES_PRODUCTO, CLASE_DEFAULT } = require('../lib/clasesProducto');

// --- Catálogos simples ---
// 2026-06-11 T-06: .strict() añadido — antes aceptaba campos extra silenciosamente.
const nombreSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(120),
}).strict();

// Resolve-or-create bulk de catálogos (categorías, depósitos) — usado por el
// import de stock para no hacer N round-trips HTTP. El backend dedup + ON CONFLICT.
const nombresBulkSchema = z.object({
  nombres: z.array(z.string().trim().min(1).max(120)).max(500, 'Máximo 500 nombres por lote'),
}).strict();

// --- Productos ---
// UUID loose regex — coherente con schemas/clasesProducto.js (F3.a).
const uuidLoose = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'clase_id inválido'
);

const baseProducto = z.object({
  tipo_carga:     z.enum(['unitario', 'lote']).default('unitario'),
  // F1: enum legacy — sigue existiendo hasta F3.d cleanup. El handler
  // sincroniza `clase` ↔ `clase_id` en cada POST/PUT (derive bidireccional).
  clase:          z.enum(CLASES_PRODUCTO).default(CLASE_DEFAULT),
  // F3.c (2026-07-08): FK a `clases_producto` (categoría editable por tenant).
  // Opcional en el shape para no romper clientes viejos que solo mandan `clase`.
  // El handler resuelve la falta con `slug_legacy` = clase; y si el frontend
  // manda solo `clase_id`, deriva `clase` desde `slug_legacy`.
  clase_id:       uuidLoose.optional().nullable(),
  nombre:         z.string().trim().min(1, 'Nombre requerido').max(200),
  imei:           z.string().trim().max(50).optional().nullable(),
  gb:             z.string().trim().max(20).optional().nullable(),
  color:          z.string().trim().max(60).optional().nullable(),
  bateria:        z.coerce.number().int().min(0).max(100).optional().nullable(),
  categoria_id:   z.coerce.number().int().positive().optional().nullable(),
  deposito_id:    z.coerce.number().int().positive().optional().nullable(),
  proveedor:      z.string().trim().max(200).optional().nullable(),
  costo:          z.coerce.number().min(0).default(0),
  costo_moneda:   MonedaEnum.default('USD'),
  precio_venta:   z.coerce.number().min(0).default(0),
  precio_moneda:  MonedaEnum.default('USD'),
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

// Regla de coherencia: unitario (celular sellado/usado + ipads) => cantidad = 1.
// Los otros 6 slugs (watch, auriculares, consolas, computadoras, cargadores,
// accesorios_varios) son "por lote" y aceptan cualquier cantidad.
const CLASES_UNITARIAS = new Set(['celular_sellado', 'celular_usado', 'ipads']);
const unitarioCoherente = (p) => !(CLASES_UNITARIAS.has(p.clase) && p.tipo_carga === 'unitario' && p.cantidad !== 1);
const unitarioMsg = { message: 'Un producto unitario debe tener cantidad = 1', path: ['cantidad'] };

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
  clase:        z.enum(CLASES_PRODUCTO).optional(),
  // F3.c: filtro por FK a clases_producto (nueva categoría por tenant).
  // Los tabs del frontend enviarán `clase_id` en vez de `clase` a partir
  // de F3.c-2. Los dos pueden coexistir durante la transición (se aplican
  // con AND si ambos vienen, aunque el frontend nuevo usa solo uno).
  clase_id:     uuidLoose.optional(),
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
  // No usamos z.coerce.boolean() — convierte el string "false" a true
  // (Boolean(str-no-vacío) === true). Mismo bug latente que se arregló en
  // schemas/pagos.js y schemas/tarjetas.js (TANDA 1 sprint USD). Aceptamos
  // boolean nativo o los literales 'true'/'false' y normalizamos.
  // Auditoría 2026-06-06 Sol H2 / Sec M1.
  solo_stock:   z.union([z.boolean(), z.enum(['true','false']).transform(v => v === 'true')]).optional(),
  // 2026-07-04 (#507): filtro por fecha de venta cuando vista='vendidos'.
  // Los strings van en formato YYYY-MM-DD (ISO). El router los aplica a
  // ventas.fecha (retail) y movimientos_cc.fecha (B2B). Si vienen con otra
  // vista, se ignoran (no crashea).
  desde:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD').optional(),
  hasta:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD').optional(),
  page:         z.coerce.number().int().positive().optional(),
  limit:        z.coerce.number().int().positive().max(200).optional(),
});

// Desglose 360: agrupar el inventario por una dimensión y aplicar filtros.
// Las 7 dimensiones expuestas se mapean a una expresión SQL segura en el
// router (no se concatena input del cliente al SQL).
const DIMENSIONES_DESGLOSE = ['categoria', 'proveedor', 'modelo', 'estado', 'deposito', 'gb', 'color'];
const queryDesgloseSchema = z.object({
  por:          z.enum(DIMENSIONES_DESGLOSE),
  clase:        z.enum(CLASES_PRODUCTO).optional(),
  estado:       z.enum(['disponible', 'vendido', 'en_tecnico', 'reservado']).optional(),
  categoria_id: z.coerce.number().int().positive().optional(),
  deposito_id:  z.coerce.number().int().positive().optional(),
  proveedor:    z.string().trim().max(200).optional(),
  // No usamos z.coerce.boolean() — convierte el string "false" a true
  // (Boolean(str-no-vacío) === true). Mismo bug latente que se arregló en
  // schemas/pagos.js y schemas/tarjetas.js (TANDA 1 sprint USD). Aceptamos
  // boolean nativo o los literales 'true'/'false' y normalizamos.
  // Auditoría 2026-06-06 Sol H2 / Sec M1.
  solo_stock:   z.union([z.boolean(), z.enum(['true','false']).transform(v => v === 'true')]).optional(),
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

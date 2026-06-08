const router = require('express').Router();
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { createCachedFetcher } = require('../lib/cacheTtl');

// Rate-limit específico para carga masiva: 20 req / 15 min por usuario autenticado
// (la key cae a IP si por algún motivo no hay user). El bulk es write-heavy y
// merece su propio carril para evitar que un usuario o un script accidental llene
// la tabla productos en minutos.
const bulkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id != null
    ? `bulk:${req.user.id}`
    : `bulk:ip:${ipKeyGenerator(req)}`,
  message: { error: 'Demasiadas cargas masivas. Probá de nuevo en unos minutos.' },
});
const {
  nombreSchema,
  nombresBulkSchema,
  createProductoSchema,
  updateProductoSchema,
  bulkProductoSchema,
  queryProductosSchema,
  queryDesgloseSchema,
} = require('../schemas/inventario');

router.use(requireAuth);

/* ───────────────────────── Catálogos: categorías ───────────────────────── */

// Listado de categorías con conteo de productos activos por categoría.
// Útil para el panel de catálogos (visualizar distribución del inventario)
// y como insumo del Data Science a futuro. LEFT JOIN para incluir
// categorías recién creadas que aún no tienen productos (count = 0).
router.get('/categorias', async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT c.*,
             COUNT(p.id) FILTER (WHERE p.deleted_at IS NULL)::int AS productos_count,
             COALESCE(SUM(p.cantidad) FILTER (WHERE p.deleted_at IS NULL AND p.estado = 'disponible'), 0)::int AS stock_disponible
        FROM categorias c
        LEFT JOIN productos p ON p.categoria_id = c.id
       WHERE c.deleted_at IS NULL
       GROUP BY c.id
       ORDER BY c.nombre
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/categorias', validate(nombreSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'INSERT INTO categorias (nombre) VALUES ($1) RETURNING *', [req.body.nombre]
    );
    await audit('categorias', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    next(err);
  }
});

// Bulk resolve-or-create de categorías — usado por el import de stock
// (Inventario.jsx confirmImport). Antes hacía N round-trips HTTP secuenciales
// para crear cada categoría nueva (60 categorías × 150ms RTT = ~9s + 47% del
// rate-limit). Ahora: 1 sola request que inserta con ON CONFLICT y devuelve
// el mapping completo lower(nombre) → id (incluyendo las ya existentes).
router.post('/categorias/bulk', validate(nombresBulkSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    // Deduplicar case-insensitive + descartar vacíos.
    const inputDedup = [...new Map(
      req.body.nombres.map(n => [String(n).trim().toLowerCase(), String(n).trim()])
    ).values()].filter(Boolean);
    if (inputDedup.length === 0) return res.json({ map: {} });

    await client.query('BEGIN');
    // ON CONFLICT con el índice parcial idx_categorias_nombre (LOWER(nombre) WHERE
    // deleted_at IS NULL). Para evitar el límite de la inferencia con predicado
    // — algunas versiones requieren WHERE — usamos el constraint inference por
    // expresión. Los nombres que ya existen se ignoran (DO NOTHING).
    await client.query(
      `INSERT INTO categorias (nombre)
       SELECT unnest($1::text[])
       ON CONFLICT (LOWER(nombre)) WHERE deleted_at IS NULL DO NOTHING`,
      [inputDedup]
    );
    // SELECT para obtener id de TODOS (recién creados + ya existentes).
    const lowers = inputDedup.map(n => n.toLowerCase());
    const { rows } = await client.query(
      `SELECT id, nombre FROM categorias
        WHERE LOWER(nombre) = ANY($1::text[]) AND deleted_at IS NULL`,
      [lowers]
    );
    // Audit: 1 entry agregada por la operación bulk (con la lista de nombres input).
    // No registramos uno por cada (audit_logs explotaría con imports grandes).
    await audit(client, 'categorias', 'INSERT', 0, {
      tipo: 'bulk_resolve_or_create_categorias', nombres: inputDedup, user_id: req.user.id,
    });
    await client.query('COMMIT');
    const map = {};
    for (const r of rows) map[r.nombre.toLowerCase()] = r.id;
    res.json({ map });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/categorias/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE categorias SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    await audit('categorias', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ───────────────────────── Catálogos: depósitos ───────────────────────── */

router.get('/depositos', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM depositos WHERE deleted_at IS NULL ORDER BY nombre'
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/depositos', validate(nombreSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'INSERT INTO depositos (nombre) VALUES ($1) RETURNING *', [req.body.nombre]
    );
    await audit('depositos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un depósito con ese nombre' });
    next(err);
  }
});

router.delete('/depositos/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE depositos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Depósito no encontrado' });
    await audit('depositos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ───────────────────────── Métricas de inventario ───────────────────────── */

// Métricas globales: SUM full-table. Cacheado 20s para no escanear `productos`
// en cada apertura del Dashboard / Capital. Ventana corta para que las cargas
// de stock se reflejen rápido.
const fetchMetricas = createCachedFetcher('inv:metricas', 20_000, async () => {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)                          FILTER (WHERE estado = 'en_tecnico')                                          AS en_tecnico_count,
      COALESCE(SUM(costo)               FILTER (WHERE estado = 'en_tecnico' AND costo_moneda = 'USD'), 0)             AS en_tecnico_usd,
      COALESCE(SUM(costo)               FILTER (WHERE estado = 'en_tecnico' AND costo_moneda = 'ARS'), 0)             AS en_tecnico_ars,
      COALESCE(SUM(cantidad)            FILTER (WHERE estado = 'disponible'), 0)                                      AS stock_disponible,
      COALESCE(SUM(costo * cantidad)    FILTER (WHERE clase = 'celular'   AND estado = 'disponible' AND costo_moneda = 'USD'), 0) AS inv_equipos_usd,
      COALESCE(SUM(costo * cantidad)    FILTER (WHERE clase = 'celular'   AND estado = 'disponible' AND costo_moneda = 'ARS'), 0) AS inv_equipos_ars,
      COALESCE(SUM(cantidad)            FILTER (WHERE clase = 'celular'   AND estado = 'disponible'), 0)              AS equipos_count,
      COALESCE(SUM(costo * cantidad)    FILTER (WHERE clase = 'accesorio' AND estado = 'disponible' AND costo_moneda = 'USD'), 0) AS inv_accesorios_usd,
      COALESCE(SUM(costo * cantidad)    FILTER (WHERE clase = 'accesorio' AND estado = 'disponible' AND costo_moneda = 'ARS'), 0) AS inv_accesorios_ars,
      COALESCE(SUM(cantidad)            FILTER (WHERE clase = 'accesorio' AND estado = 'disponible'), 0)              AS accesorios_count
    FROM productos
    WHERE deleted_at IS NULL
  `);
  return rows[0];
});

router.get('/productos/metricas', async (_req, res, next) => {
  try { res.json(await fetchMetricas()); } catch (err) { next(err); }
});

// Proveedores únicos vistos en productos vivos. Insumo del combo de edición
// inline (Inventario): no tenemos tabla de proveedores como FK, así que esto
// es la mejor fuente de verdad para autocompletar. DISTINCT chico (≤cientos
// en cualquier escenario realista) → query sin paginación.
router.get('/productos/proveedores', async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT DISTINCT TRIM(proveedor) AS proveedor
        FROM productos
       WHERE deleted_at IS NULL
         AND proveedor IS NOT NULL
         AND TRIM(proveedor) <> ''
       ORDER BY proveedor
    `);
    res.json(rows.map(r => r.proveedor));
  } catch (err) { next(err); }
});

/* ───────────────────────── Desglose 360 ───────────────────────── */

// Mapeo de dimensión → expresiones SQL. NO se concatena input del usuario:
// el enum se valida con Zod (queryDesgloseSchema) y la clave se usa para
// indexar este objeto, no para armar SQL. La etiqueta `valor_id` es para
// drill-down: si la dimensión tiene FK (categoría/depósito), devolvemos el
// id; para texto libre (proveedor/modelo/gb/color) o enum (estado),
// devolvemos string vacío y el frontend filtra por nombre/valor.
const DIM_CONFIG = {
  categoria: {
    select: `c.id::text AS valor_id, COALESCE(c.nombre, 'Sin categoría') AS valor`,
    join:   `LEFT JOIN categorias c ON c.id = p.categoria_id AND c.deleted_at IS NULL`,
    group:  `c.id, c.nombre`,
    order:  `COALESCE(c.nombre, 'Sin categoría')`,
  },
  proveedor: {
    select: `'' AS valor_id, COALESCE(NULLIF(TRIM(p.proveedor), ''), 'Sin proveedor') AS valor`,
    join:   ``,
    group:  `COALESCE(NULLIF(TRIM(p.proveedor), ''), 'Sin proveedor')`,
    order:  `COALESCE(NULLIF(TRIM(p.proveedor), ''), 'Sin proveedor')`,
  },
  modelo: {
    select: `'' AS valor_id, p.nombre AS valor`,
    join:   ``,
    group:  `p.nombre`,
    order:  `p.nombre`,
  },
  estado: {
    select: `'' AS valor_id, p.estado AS valor`,
    join:   ``,
    group:  `p.estado`,
    order:  `p.estado`,
  },
  deposito: {
    select: `d.id::text AS valor_id, COALESCE(d.nombre, 'Sin depósito') AS valor`,
    join:   `LEFT JOIN depositos d ON d.id = p.deposito_id AND d.deleted_at IS NULL`,
    group:  `d.id, d.nombre`,
    order:  `COALESCE(d.nombre, 'Sin depósito')`,
  },
  gb: {
    select: `'' AS valor_id, COALESCE(NULLIF(TRIM(p.gb), ''), '(sin GB)') AS valor`,
    join:   ``,
    group:  `COALESCE(NULLIF(TRIM(p.gb), ''), '(sin GB)')`,
    order:  `COALESCE(NULLIF(TRIM(p.gb), ''), '(sin GB)')`,
  },
  color: {
    select: `'' AS valor_id, COALESCE(NULLIF(TRIM(p.color), ''), '(sin color)') AS valor`,
    join:   ``,
    group:  `COALESCE(NULLIF(TRIM(p.color), ''), '(sin color)')`,
    order:  `COALESCE(NULLIF(TRIM(p.color), ''), '(sin color)')`,
  },
};

// Devuelve { totales, filas } agrupando el inventario por la dimensión pedida
// con los filtros aplicados. Una sola pasada por `productos` (INNER GROUP)
// más una totales en paralelo. Sin cache: los filtros son combinatorios y
// la query es chica (SUM/COUNT con índices).
//
// Métricas devueltas por fila (y totales):
//   productos       = COUNT(*) de filas que matchearon (no de unidades)
//   stock           = SUM(cantidad) (unidades reales)
//   inv_usd/ars     = SUM(costo * cantidad) split por moneda de costo
//   valorizado_*    = SUM(precio_venta * cantidad) split por moneda de venta
//   margen_usd/ars  = valorizado - inversión (sólo informativo dentro de
//                     cada moneda; no hace conversión cruzada)
router.get('/desglose', validate(queryDesgloseSchema, 'query'), async (req, res, next) => {
  try {
    const { por, clase, estado, categoria_id, deposito_id, proveedor, solo_stock, buscar } = req.query;
    const dim = DIM_CONFIG[por];
    if (!dim) return res.status(400).json({ error: 'Dimensión inválida' });

    const conditions = ['p.deleted_at IS NULL'];
    const params = [];
    if (clase)        { params.push(clase);        conditions.push(`p.clase = $${params.length}`); }
    if (estado)       { params.push(estado);       conditions.push(`p.estado = $${params.length}`); }
    if (categoria_id) { params.push(categoria_id); conditions.push(`p.categoria_id = $${params.length}`); }
    if (deposito_id)  { params.push(deposito_id);  conditions.push(`p.deposito_id = $${params.length}`); }
    if (proveedor)    { params.push(proveedor);    conditions.push(`TRIM(COALESCE(p.proveedor, '')) = $${params.length}`); }
    if (solo_stock)   { conditions.push(`p.estado = 'disponible' AND p.cantidad > 0`); }
    if (buscar) {
      params.push(`%${buscar}%`);
      conditions.push(`(p.nombre ILIKE $${params.length} OR p.imei ILIKE $${params.length}
                        OR p.color ILIKE $${params.length} OR p.gb ILIKE $${params.length})`);
    }
    const where = conditions.join(' AND ');

    const aggSelect = `
        COUNT(*)::int AS productos,
        COALESCE(SUM(p.cantidad), 0)::int AS stock,
        COALESCE(SUM(p.costo * p.cantidad)        FILTER (WHERE p.costo_moneda  = 'USD'), 0)::float AS inv_usd,
        COALESCE(SUM(p.costo * p.cantidad)        FILTER (WHERE p.costo_moneda  = 'ARS'), 0)::float AS inv_ars,
        COALESCE(SUM(p.precio_venta * p.cantidad) FILTER (WHERE p.precio_moneda = 'USD'), 0)::float AS valorizado_usd,
        COALESCE(SUM(p.precio_venta * p.cantidad) FILTER (WHERE p.precio_moneda = 'ARS'), 0)::float AS valorizado_ars
    `;

    const filasQuery = `
      SELECT ${dim.select},
             ${aggSelect}
        FROM productos p
        ${dim.join}
       WHERE ${where}
       GROUP BY ${dim.group}
       ORDER BY ${dim.order}
    `;
    const totalQuery = `
      SELECT ${aggSelect}
        FROM productos p
       WHERE ${where}
    `;

    const [filasRes, totalRes] = await Promise.all([
      db.query(filasQuery, params),
      db.query(totalQuery, params),
    ]);

    const tot = totalRes.rows[0] || {};
    res.json({
      por,
      totales: {
        productos: Number(tot.productos || 0),
        stock: Number(tot.stock || 0),
        inv_usd: Number(tot.inv_usd || 0),
        inv_ars: Number(tot.inv_ars || 0),
        valorizado_usd: Number(tot.valorizado_usd || 0),
        valorizado_ars: Number(tot.valorizado_ars || 0),
        margen_usd: Number(tot.valorizado_usd || 0) - Number(tot.inv_usd || 0),
        margen_ars: Number(tot.valorizado_ars || 0) - Number(tot.inv_ars || 0),
      },
      filas: filasRes.rows.map(r => ({
        valor: r.valor,
        valor_id: r.valor_id || null,
        productos: Number(r.productos),
        stock: Number(r.stock),
        inv_usd: Number(r.inv_usd),
        inv_ars: Number(r.inv_ars),
        valorizado_usd: Number(r.valorizado_usd),
        valorizado_ars: Number(r.valorizado_ars),
        margen_usd: Number(r.valorizado_usd) - Number(r.inv_usd),
        margen_ars: Number(r.valorizado_ars) - Number(r.inv_ars),
      })),
    });
  } catch (err) { next(err); }
});

/* ───────────────────────── Productos ───────────────────────── */

router.get('/productos', validate(queryProductosSchema, 'query'), async (req, res, next) => {
  try {
    const { buscar, clase, estado, categoria_id, deposito_id, solo_stock,
            nombre, proveedor, gb, color, vista, condicion } = req.query;

    const conditions = ['p.deleted_at IS NULL'];
    const params = [];
    if (clase)        { params.push(clase);        conditions.push(`p.clase = $${params.length}`); }
    if (estado)       { params.push(estado);       conditions.push(`p.estado = $${params.length}`); }
    if (categoria_id) { params.push(categoria_id); conditions.push(`p.categoria_id = $${params.length}`); }
    if (deposito_id)  { params.push(deposito_id);  conditions.push(`p.deposito_id = $${params.length}`); }
    if (condicion)    { params.push(condicion);    conditions.push(`p.condicion = $${params.length}`); }

    // Resolución de "vista":
    //   - Si vino `vista`, gana.
    //   - Si NO vino `vista` pero sí `solo_stock=true` (clientes legacy), se mapea
    //     a 'no_vendidos' para preservar el comportamiento previo.
    //   - Si no vino ni vista ni solo_stock, NO se aplica filtro implícito: el
    //     cliente verá lo que pase los demás filtros (compat con drill-down
    //     existente desde Desglose 360, que NO quiere el filtro por defecto).
    const vistaEfectiva = vista || (solo_stock ? 'no_vendidos' : null);
    if (vistaEfectiva === 'no_vendidos') {
      conditions.push(`p.estado <> 'vendido' AND p.cantidad > 0 AND p.oculto = false`);
    } else if (vistaEfectiva === 'no_vendidos_ocultos') {
      conditions.push(`p.estado <> 'vendido' AND p.cantidad > 0 AND p.oculto = true`);
    } else if (vistaEfectiva === 'ocultos') {
      conditions.push(`p.oculto = true`);
    } else if (vistaEfectiva === 'vendidos') {
      conditions.push(`p.estado = 'vendido' AND p.oculto = false`);
    } else if (vistaEfectiva === 'todos_visibles') {
      conditions.push(`p.oculto = false`);
    }
    // 'todos_ocultos' → sin filtro extra: ve todo.

    // Igualdades exactas — drill-down desde Desglose 360.
    if (nombre)    { params.push(nombre);    conditions.push(`p.nombre = $${params.length}`); }
    if (proveedor) { params.push(proveedor); conditions.push(`TRIM(COALESCE(p.proveedor, '')) = $${params.length}`); }
    if (gb)        { params.push(gb);        conditions.push(`TRIM(COALESCE(p.gb, '')) = $${params.length}`); }
    if (color)     { params.push(color);     conditions.push(`TRIM(COALESCE(p.color, '')) = $${params.length}`); }
    if (buscar) {
      params.push(`%${buscar}%`);
      conditions.push(`(p.nombre ILIKE $${params.length} OR p.imei ILIKE $${params.length}
                        OR p.color ILIKE $${params.length} OR p.gb ILIKE $${params.length})`);
    }
    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });

    const countQuery = `SELECT COUNT(*) FROM productos p WHERE ${where}`;
    const dataQuery = `
      SELECT p.id, p.tipo_carga, p.clase, p.nombre, p.imei, p.gb, p.color, p.bateria,
             p.categoria_id, p.deposito_id, p.proveedor, p.costo, p.costo_moneda,
             p.precio_venta, p.precio_moneda, p.trackear_stock, p.cantidad, p.estado,
             p.observaciones, p.condicion, p.oculto, p.created_at,
             (p.foto_data IS NOT NULL) AS tiene_foto, p.foto_nombre, p.foto_tipo,
             c.nombre AS categoria_nombre, d.nombre AS deposito_nombre
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN depositos  d ON d.id = p.deposito_id
      WHERE ${where}
      ORDER BY p.nombre, p.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const [countRes, dataRes] = await Promise.all([
      db.query(countQuery, params),
      db.query(dataQuery, [...params, limit, offset]),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

// Foto on-demand: el blob NO viaja en el listado (evita transferir base64 en cada query)
router.get('/productos/:id/foto', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'SELECT foto_data, foto_nombre, foto_tipo FROM productos WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!rows[0] || !rows[0].foto_data) return res.status(404).json({ error: 'Sin foto' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

const PRODUCTO_COLS = [
  'tipo_carga', 'clase', 'nombre', 'imei', 'gb', 'color', 'bateria',
  'categoria_id', 'deposito_id', 'proveedor', 'costo', 'costo_moneda',
  'precio_venta', 'precio_moneda', 'trackear_stock', 'cantidad', 'estado',
  'foto_data', 'foto_nombre', 'foto_tipo', 'observaciones',
  'condicion', 'oculto',
];

router.post('/productos', validate(createProductoSchema), async (req, res, next) => {
  try {
    // Defaults JS para columnas NOT NULL nuevas (la migración tiene DEFAULT,
    // pero como el INSERT lista todas las columnas explícitamente pasaríamos
    // NULL si el cliente no las manda → NOT NULL violation). Defaultear acá
    // es más simple que ramificar el SQL.
    const b = {
      ...req.body,
      condicion: req.body.condicion ?? 'nuevo',
      oculto:    req.body.oculto    ?? false,
    };
    const values = PRODUCTO_COLS.map(c => b[c] ?? null);
    const placeholders = PRODUCTO_COLS.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await db.query(
      `INSERT INTO productos (${PRODUCTO_COLS.join(',')}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    await audit('productos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/productos/:id', validate(updateProductoSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows: before } = await db.query(
      'SELECT * FROM productos WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!before[0]) return res.status(404).json({ error: 'Producto no encontrado' });

    // COALESCE por columna: solo actualiza lo que vino en el body
    const sets = PRODUCTO_COLS.map((c, i) => `${c} = COALESCE($${i + 1}, ${c})`).join(', ');
    const values = PRODUCTO_COLS.map(c => (c in req.body ? req.body[c] : null));
    const { rows } = await db.query(
      `UPDATE productos SET ${sets} WHERE id = $${PRODUCTO_COLS.length + 1} RETURNING *`,
      [...values, id]
    );
    await audit('productos', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/productos/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE productos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
    await audit('productos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /productos/bulk-delete-disponibles
//
// Soft-delete masivo de todos los productos en estado 'disponible'. Útil cuando
// el operador quiere vaciar el stock libre (ej. después de un import fallido o
// reset operativo) sin perder histórico de vendidos / equipos en service /
// reservados.
//
// Mantiene intencionalmente:
//   · 'vendido'    — atado a ventas históricas, no se puede borrar sin romper
//                    referencias en venta_items.producto_id
//   · 'en_tecnico' — físicamente en stock pero en service (el operador lo
//                    necesita para devolver el equipo cuando vuelve)
//   · 'reservado'  — apartado para un cliente, no se borra a la ligera
//
// Reversible: como todo en iPro, es soft-delete (deleted_at = NOW()).
// Para recuperar, hay que correr SQL directo en DB (no hay UI de undelete).
router.post('/productos/bulk-delete-disponibles', bulkLimiter, async (req, res, next) => {
  // Auditoría 2026-06-03: cambios respecto a la versión original:
  //
  // 1) Tx + audit-in-tx: antes UPDATE y audit eran queries separadas con el pool
  //    global — si crasheaba entre ambos, había productos borrados sin traza.
  //
  // 2) Guarda contra envíos en curso: si un envío Pendiente/En camino apunta a
  //    un producto 'disponible' (caso real: envío cargado anticipado, venta sin
  //    registrar todavía), borrar el producto deja el envío con referencia rota.
  //    Bloqueamos con 409 + detalle para que el operador resuelva primero.
  //
  // 3) Audit lean: antes guardaba `ids: [...]` (puede ser ~40KB de JSONB con
  //    miles de productos, anti-patrón sobre audit_logs que tiene retención).
  //    Ahora solo `borrados: N`. La trazabilidad real está en productos.deleted_at:
  //    `SELECT id FROM productos WHERE deleted_at = '...' AND estado='disponible'`.
  //
  // 4) bulkLimiter: endpoint destructivo masivo merece su carril propio. Sin
  //    esto un script accidental podía pegarlo en loop dentro del 300/15min global.
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Validación: ¿hay envíos en curso apuntando a productos disponibles?
    // Estados 'Entregado' y 'Cancelado' son terminales — borrar el producto no
    // afecta esos envíos (la referencia queda como "producto borrado" pero el
    // envío ya cerró). 'Pendiente'/'En camino' son los que importan.
    const enUso = await client.query(
      `SELECT ei.envio_id, e.cliente, e.estado, ei.producto_id, p.nombre AS producto_nombre
         FROM envio_items ei
         JOIN envios   e ON e.id = ei.envio_id
         JOIN productos p ON p.id = ei.producto_id
        WHERE e.estado IN ('Pendiente', 'En camino')
          AND p.estado = 'disponible'
          AND p.deleted_at IS NULL
          AND ei.producto_id IS NOT NULL
        LIMIT 10`
    );
    if (enUso.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `No se puede vaciar: hay ${enUso.rows.length === 10 ? '10+' : enUso.rows.length} envíos en curso con productos disponibles referenciados. Resolvé esos envíos primero (marcar como Entregado o Cancelar).`,
        envios_bloqueantes: enUso.rows,
      });
    }

    const { rows } = await client.query(
      `UPDATE productos
          SET deleted_at = NOW()
        WHERE deleted_at IS NULL
          AND estado = 'disponible'
        RETURNING id`
    );
    const borrados = rows.length;
    if (borrados > 0) {
      // registro_id=0 sentinel (la columna admite NULL pero un literal queda
      // más explícito para queries de búsqueda en audit). accion='DELETE'
      // requerido por el CHECK constraint; el detalle 'bulk_delete_disponibles'
      // va en datos_despues.tipo para filtrar después.
      await audit(client, 'productos', 'DELETE', 0, {
        tipo: 'bulk_delete_disponibles',
        borrados,
        user_id: req.user.id,
      });
    }
    await client.query('COMMIT');
    res.json({ borrados });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.post('/productos/bulk', bulkLimiter, validate(bulkProductoSchema), async (req, res, next) => {
  const productos = req.body.productos;

  // Revalidamos FKs ANTES de empezar a insertar: si alguna categoría/depósito no existe,
  // devolvemos 400 listando las filas inválidas en vez de que muera con un 23503 opaco
  // y un ROLLBACK que tira las 499 filas válidas. Una sola query por catálogo.
  const catIds = [...new Set(productos.map(p => p.categoria_id).filter(Boolean))];
  const depIds = [...new Set(productos.map(p => p.deposito_id).filter(Boolean))];
  const [catValid, depValid] = await Promise.all([
    catIds.length ? db.query('SELECT id FROM categorias WHERE id = ANY($1::int[]) AND deleted_at IS NULL', [catIds]) : { rows: [] },
    depIds.length ? db.query('SELECT id FROM depositos  WHERE id = ANY($1::int[]) AND deleted_at IS NULL', [depIds]) : { rows: [] },
  ]);
  const okCats = new Set(catValid.rows.map(r => r.id));
  const okDeps = new Set(depValid.rows.map(r => r.id));
  const filasInvalidas = [];
  productos.forEach((p, i) => {
    if (p.categoria_id != null && !okCats.has(p.categoria_id)) filasInvalidas.push({ fila: i + 1, error: `categoria_id ${p.categoria_id} no existe` });
    if (p.deposito_id != null && !okDeps.has(p.deposito_id))  filasInvalidas.push({ fila: i + 1, error: `deposito_id ${p.deposito_id} no existe` });
  });
  if (filasInvalidas.length) return res.status(400).json({ error: 'Referencias inválidas en el lote', detalles: filasInvalidas });

  // Feature recepción móvil (junio 2026): rechazar IMEIs que ya existen en
  // productos activos. Antes el import XLSX podía crear duplicados silenciosos
  // si el operador re-importaba la misma planilla por error. Una sola query
  // con ANY($1::text[]) — barata gracias al índice idx_productos_imei.
  const imeisDelLote = productos.map(p => (p.imei || '').trim()).filter(Boolean);
  if (imeisDelLote.length) {
    const { rows: yaExisten } = await db.query(
      `SELECT imei FROM productos
        WHERE imei = ANY($1::text[]) AND deleted_at IS NULL`,
      [imeisDelLote]
    );
    if (yaExisten.length) {
      return res.status(409).json({
        error: 'Hay IMEIs que ya existen en inventario',
        duplicados: yaExisten.map(r => r.imei),
      });
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cols = PRODUCTO_COLS.filter(c => !c.startsWith('foto_'));

    // Mismo default explícito que en el POST simple: columnas NOT NULL nuevas.
    const buf = productos.map(p => ({
      ...p,
      condicion: p.condicion ?? 'nuevo',
      oculto:    p.oculto    ?? false,
    }));

    // Perf H2 auditoría 2026-06-06: bulk INSERT con UNNEST en una sola query.
    // Antes hacíamos un INSERT por producto dentro del for → 500 productos =
    // 500 round-trips a PG (latencia se acumulaba a varios segundos). Con
    // UNNEST le mandamos arrays paralelos y PG arma todas las filas en una
    // sola pasada; ~25× más rápido en lotes grandes.
    //
    // El mapeo columna→tipo PG está alineado con migración 20260524000001
    // (tabla productos). Si se agrega una columna a productos, actualizar
    // PG_TYPES acá. Mismo patrón que items_movimiento_cc en cuentas.js:470.
    const PG_TYPES = {
      tipo_carga:    'text',    clase:         'text',
      nombre:        'text',    imei:          'text',
      gb:            'text',    color:         'text',
      bateria:       'smallint', categoria_id: 'int',
      deposito_id:   'int',     proveedor:     'text',
      costo:         'numeric', costo_moneda:  'text',
      precio_venta:  'numeric', precio_moneda: 'text',
      trackear_stock:'boolean', cantidad:      'int',
      estado:        'text',    observaciones: 'text',
      condicion:     'text',    oculto:        'boolean',
    };
    const unnestArgs = cols.map((c, i) => `$${i + 1}::${PG_TYPES[c]}[]`).join(', ');
    const arrays     = cols.map(c => buf.map(b => b[c] ?? null));

    // WITH ORDINALITY + ORDER BY ord: garantiza que las filas se inserten en
    // el orden del input, así RETURNING id devuelve ids alineados con
    // productos[i] para el audit posterior (que asume creados[i] ↔ productos[i]).
    const colList = cols.join(', ');
    const { rows } = await client.query(
      `INSERT INTO productos (${colList})
       SELECT ${colList}
         FROM UNNEST(${unnestArgs}) WITH ORDINALITY AS u(${colList}, ord)
        ORDER BY ord
       RETURNING id`,
      arrays
    );
    const creados = rows.map(r => r.id);
    await client.query('COMMIT');
    // Un audit por producto (registro_id != null) — así el historial filtrable por producto los muestra.
    await Promise.all(creados.map((id, i) =>
      audit('productos', 'INSERT', id, { despues: { ...productos[i], id, _bulk: true }, user_id: req.user.id })
    ));
    res.status(201).json({ ok: true, creados: creados.length });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;

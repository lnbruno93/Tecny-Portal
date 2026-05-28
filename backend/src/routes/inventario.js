const router = require('express').Router();
const rateLimit = require('express-rate-limit');
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
  keyGenerator: (req) => `bulk:${req.user?.id || req.ip}`,
  message: { error: 'Demasiadas cargas masivas. Probá de nuevo en unos minutos.' },
});
const {
  nombreSchema,
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
            nombre, proveedor, gb, color } = req.query;

    const conditions = ['p.deleted_at IS NULL'];
    const params = [];
    if (clase)        { params.push(clase);        conditions.push(`p.clase = $${params.length}`); }
    if (estado)       { params.push(estado);       conditions.push(`p.estado = $${params.length}`); }
    if (categoria_id) { params.push(categoria_id); conditions.push(`p.categoria_id = $${params.length}`); }
    if (deposito_id)  { params.push(deposito_id);  conditions.push(`p.deposito_id = $${params.length}`); }
    if (solo_stock)   { conditions.push(`p.estado = 'disponible' AND p.cantidad > 0`); }
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
             p.observaciones, p.created_at,
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
];

router.post('/productos', validate(createProductoSchema), async (req, res, next) => {
  try {
    const b = req.body;
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

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cols = PRODUCTO_COLS.filter(c => !c.startsWith('foto_'));
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const creados = [];
    for (const p of productos) {
      const values = cols.map(c => p[c] ?? null);
      const { rows } = await client.query(
        `INSERT INTO productos (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`, values
      );
      creados.push(rows[0].id);
    }
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

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');

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
} = require('../schemas/inventario');

router.use(requireAuth);

/* ───────────────────────── Catálogos: categorías ───────────────────────── */

router.get('/categorias', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM categorias WHERE deleted_at IS NULL ORDER BY nombre'
    );
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

router.get('/productos/metricas', async (_req, res, next) => {
  try {
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
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ───────────────────────── Productos ───────────────────────── */

router.get('/productos', validate(queryProductosSchema, 'query'), async (req, res, next) => {
  try {
    const { buscar, clase, estado, categoria_id, deposito_id, solo_stock } = req.query;

    const conditions = ['p.deleted_at IS NULL'];
    const params = [];
    if (clase)        { params.push(clase);        conditions.push(`p.clase = $${params.length}`); }
    if (estado)       { params.push(estado);       conditions.push(`p.estado = $${params.length}`); }
    if (categoria_id) { params.push(categoria_id); conditions.push(`p.categoria_id = $${params.length}`); }
    if (deposito_id)  { params.push(deposito_id);  conditions.push(`p.deposito_id = $${params.length}`); }
    if (solo_stock)   { conditions.push(`p.estado = 'disponible' AND p.cantidad > 0`); }
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

const router = require('express').Router();
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const requireCapability = require('../middleware/requireCapability');
// hasCapability se usa en handlers para redactar campos sensibles
// (response shaping post-F5b). El módulo expone ambos.
const { hasCapability } = require('../middleware/requireCapability');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const fileStore = require('../lib/fileStore');
const storageFlags = require('../lib/storageFlags');
const adminOnly = require('../middleware/adminOnly');
const { reverseCajaMovimientos } = require('../lib/cajaLedger');
const { invalidateCajas } = require('../lib/cajasCache');
// Multi-país F2: validación país-aware en endpoints de escritura.
const { assertMonedaValidaParaPais } = require('../lib/money');

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
  queryUsadosSchema,         // 2026-07-11: tab "Equipos usados" en Inventario
  queryDesgloseSchema,
  SLUGS_UNITARIOS,           // F3.d-3: para validarUnitarioCoherente post-derive
} = require('../schemas/inventario');
// F3.a — CRUD de categorías (clases_producto) por tenant. Ver design doc:
// `docs/design/categorias-crud-tenant-f3.md`.
const {
  createClaseProductoSchema,
  updateClaseProductoSchema,
  reorderClasesProductoSchema,
} = require('../schemas/clasesProducto');

/**
 * buildSearchClause — construye clause SQL tokenizado para búsqueda multi-campo.
 *
 * 2026-07-14 (feature): antes usábamos un solo ILIKE con la query completa
 * (ej. `%iPhone 17%`). Requería que la frase EXACTA aparezca en algún campo,
 * lo cual dependía del orden y forma del texto en `nombre`. Cliente reportó
 * que "iPhone 17" a veces no matcheaba productos que sí eran iPhone 17
 * (nombre = "Apple iPhone 17 Pro Max 256GB" → sí matchea, pero "17 iPhone Pro"
 * → no matcheaba).
 *
 * Ahora tokenizamos por whitespace y hacemos AND entre tokens: cada token
 * debe aparecer en ALGÚN campo, sin importar orden. Precisión:
 *   · "iPhone 17"   → producto debe tener "iPhone" AND "17" en algún campo
 *   · "17 iPhone"   → mismo resultado (orden no importa)
 *   · "Blue 128"    → producto debe tener "Blue" AND "128" (color=Blue + gb=128 ok)
 *   · Un iPad "iPad A16 2025" con IMEI "SG942P321XL":
 *     - Con query "iPhone 17": "iPhone" no está en NINGÚN campo → NO matchea ✅
 *     - Con query "17": "17" no está en NINGÚN campo → NO matchea ✅
 *
 * Cap de 5 tokens para prevenir queries maliciosas con muchos términos
 * (cada token agrega N sub-clauses OR, con 5 tokens y 4 campos = 20 ILIKE).
 * En la práctica, nadie busca con más de 3-4 palabras.
 *
 * @param {string|null|undefined} buscar - raw query del usuario
 * @param {string[]} fields - columnas SQL a buscar (ej. ['p.nombre', 'p.imei', 'p.color', 'p.gb'])
 * @param {any[]} params - array de parámetros (se MUTATE con push)
 * @returns {string|null} clause SQL para agregar a WHERE, o null si no hay tokens
 */
function buildSearchClause(buscar, fields, params) {
  if (!buscar || typeof buscar !== 'string') return null;
  const tokens = buscar.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (tokens.length === 0) return null;
  const tokenClauses = tokens.map(token => {
    params.push(`%${token}%`);
    const paramIdx = params.length;
    const fieldConditions = fields.map(f => `${f} ILIKE $${paramIdx}`).join(' OR ');
    return `(${fieldConditions})`;
  });
  return `(${tokenClauses.join(' AND ')})`;
}

/**
 * buildSearchWithRanking — v2 del search: agrega ranking por relevancia.
 *
 * 2026-07-14 (feedback Lucas, follow-up del tokenización PR #615):
 *   Cuando hay varios matches, mostrar arriba los que matchean en `nombre`
 *   sobre los que solo matchean en IMEI/color/gb. Además usar `similarity()`
 *   de pg_trgm como boost adicional al ranking (misma info que reordena
 *   matches muy parecidos).
 *
 * Nota importante — NO metemos fuzzy en el WHERE. Evaluamos primero (2026-07-14):
 * el approach original agregaba una vía fuzzy `similarity(nombre, query) >= 0.35`
 * en el WHERE para tolerar typos. Pero pg_trgm devuelve similarity ~0.5 para
 * "iPhone 15 Pro" vs "iPhone 17" (comparten trigramas iph/pho/hon/one/_17),
 * lo que metía "iPhone 15" al buscar "iPhone 17" — falso positivo grave.
 *
 * Trade-off elegido: precisión estricta en WHERE (nada de fuzzy) + ranking por
 * similarity como tie-breaker. Si el user busca "iphon 17" (typo real) NO va
 * a matchear nada — mejor que meter ruido. Si en el futuro necesitamos typo
 * tolerance real, usaríamos autocompletado (endpoint separado con sugerencias).
 *
 * Solo se usa en /productos (donde reporta Lucas la fricción de UX). Los
 * endpoints /desglose y /vendidos siguen usando `buildSearchClause` legacy
 * porque son drill-downs analíticos donde el orden por relevancia no aplica.
 *
 * @returns {{where: string|null, orderBy: string|null, orderByParams: any[]}}
 *   - where: cláusula WHERE (tokens AND). null si no hay `buscar`.
 *   - orderBy: expresión de scoring para ORDER BY. null si no hay `buscar`.
 *   - orderByParams: params extra que el ORDER BY necesita (a agregar SOLO
 *     al dataQuery, NO al countQuery — el count no usa ORDER BY). Los índices
 *     de estos params en el ORDER BY están calculados asumiendo que se
 *     appendan a `params` DESPUÉS del where.
 */
function buildSearchWithRanking(buscar, params) {
  if (!buscar || typeof buscar !== 'string') return { where: null, orderBy: null, orderByParams: [] };
  const rawQuery = buscar.trim();
  if (!rawQuery) return { where: null, orderBy: null, orderByParams: [] };
  const tokens = rawQuery.split(/\s+/).filter(Boolean).slice(0, 5);
  if (tokens.length === 0) return { where: null, orderBy: null, orderByParams: [] };

  const fields = ['p.nombre', 'p.imei', 'p.color', 'p.gb'];

  // Push cada token UNA vez a `params` (usados por WHERE). Reusamos esos
  // índices también en el ORDER BY.
  const tokenParamIdxs = tokens.map(token => {
    params.push(`%${token}%`);
    return params.length;
  });

  // WHERE: tokens AND estricto sobre CUALQUIER campo (mismo que buildSearchClause).
  const strictClause = '(' + tokenParamIdxs.map(idx =>
    `(${fields.map(f => `${f} ILIKE $${idx}`).join(' OR ')})`
  ).join(' AND ') + ')';

  // ORDER BY: score compuesto por relevancia.
  //   +100 si TODOS los tokens matchean en NOMBRE (match perfecto texto)
  //   +similarity(nombre, rawQuery) * 10 → 0-10 como tie-breaker fino
  //     (rescata "iPhone 17 Pro Max 256GB" sobre "iPhone 17 Base" cuando ambos
  //      matchean todos los tokens; el primero tiene similarity mayor con la
  //      query completa "iPhone 17").
  //
  // El `rawQuery` para similarity() NO se puede pushear a `params` porque
  // countQuery (que reusa `params`) NO tiene ORDER BY y se rompería con
  // "bind message supplies N params, but prepared statement requires N-1".
  // Devolvemos por separado en `orderByParams` y el caller lo appenda solo
  // al dataQuery. El placeholder del rawQuery queda como $ (params.length + 1).
  const scoreNombreExact = tokenParamIdxs.map(idx => `p.nombre ILIKE $${idx}`).join(' AND ');
  const rawParamIdx = params.length + 1; // primer slot después del último WHERE param
  const orderBy = `(
    CASE WHEN ${scoreNombreExact} THEN 100 ELSE 0 END
    + (similarity(LOWER(p.nombre), LOWER($${rawParamIdx})) * 10)
  ) DESC`;

  return { where: strictClause, orderBy, orderByParams: [rawQuery] };
}

router.use(requireAuth);

/* ───────────────────────── Catálogos: categorías ───────────────────────── */

// Listado de categorías con conteo de productos activos por categoría.
// Útil para el panel de catálogos (visualizar distribución del inventario)
// y como insumo del Data Science a futuro. LEFT JOIN para incluir
// categorías recién creadas que aún no tienen productos (count = 0).
//
// 2026-06-15 multi-tenant PR 4.0: PRIMER endpoint refactoreado para usar
// db.withTenant. Establece el patrón canonical que se replicará en todos los
// endpoints en PRs siguientes. La policy RLS de PR 2 garantiza que aunque la
// query no tenga WHERE tenant_id explícito, Postgres filtra automáticamente.
router.get('/categorias', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(`
        SELECT c.*,
               COUNT(p.id) FILTER (WHERE p.deleted_at IS NULL)::int AS productos_count,
               COALESCE(SUM(p.cantidad) FILTER (WHERE p.deleted_at IS NULL AND p.estado = 'disponible'), 0)::int AS stock_disponible
          FROM categorias c
          LEFT JOIN productos p ON p.categoria_id = c.id
         WHERE c.deleted_at IS NULL
         GROUP BY c.id
         ORDER BY c.nombre
      `);
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/categorias', validate(nombreSchema), async (req, res, next) => {
  try {
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'INSERT INTO categorias (nombre) VALUES ($1) RETURNING *', [req.body.nombre]
      );
      await audit(client, 'categorias', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
      return rows[0];
    });
    res.status(201).json(row);
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
    // 2026-06-15 multi-tenant: SET LOCAL después del BEGIN para que la tx
    // respete RLS. Aplica solo a esta tx — el client vuelve al pool limpio.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    // ON CONFLICT con el índice parcial idx_categorias_tenant_nombre
    // (tenant_id, LOWER(nombre) WHERE deleted_at IS NULL). 2026-06-24 ONB-3:
    // el índice cambió de global a per-tenant en migration
    // 20260624110000_categorias_unique_per_tenant — antes era LOWER(nombre)
    // global. El INSERT no necesita tenant_id explícito porque la dynamic
    // default de RLS lo setea (current_setting('app.current_tenant')).
    await client.query(
      `INSERT INTO categorias (nombre)
       SELECT unnest($1::text[])
       ON CONFLICT (tenant_id, LOWER(nombre)) WHERE deleted_at IS NULL DO NOTHING`,
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
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE categorias SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
      );
      if (!rows[0]) return null;
      await audit(client, 'categorias', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ───────────────────────── Catálogos: depósitos ───────────────────────── */

router.get('/depositos', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM depositos WHERE deleted_at IS NULL ORDER BY nombre'
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/depositos', validate(nombreSchema), async (req, res, next) => {
  try {
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'INSERT INTO depositos (nombre) VALUES ($1) RETURNING *', [req.body.nombre]
      );
      await audit(client, 'depositos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
      return rows[0];
    });
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un depósito con ese nombre' });
    next(err);
  }
});

router.delete('/depositos/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE depositos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
      );
      if (!rows[0]) return null;
      await audit(client, 'depositos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Depósito no encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ───────────────────────── Métricas de inventario ───────────────────────── */

// Cache de métricas extraído a lib/inventarioCache.js — junio 2026.
// La función `invalidateMetricas` se importa también en otros routers que
// modifican productos (cuentas.js para venta B2B, ventas.js para retail, etc).
const { fetchMetricas, invalidateMetricas } = require('../lib/inventarioCache');

router.get('/productos/metricas', async (req, res, next) => {
  // PR 4.9 (2026-06-15): cache per-tenant — fetchMetricas(req.tenantId).
  // Ver lib/inventarioCache.js.
  //
  // 2026-06-24 hotfix post-F5b: la auditoría post-permisos detectó que
  // F5b shapeó GET /productos y /productos/:id/historial pero OLVIDÓ este
  // endpoint, que devuelve SUM(costo*cantidad). Un vendedor sin
  // `inventario.ver_costos` veía el valor total del inventario del tenant.
  // Mismo patrón de redact que F5b: los `count` NO se redactan (un vendedor
  // sí puede saber CUÁNTO stock hay sin saber CUÁNTA plata representa), los
  // campos monetarios sí (`en_tecnico_usd/ars` + montos por categoría en
  // `inv_por_clase[]`).
  //
  // 2026-07-11 F3-Fase2c: post-sunset de los campos legacy inv_equipos_* /
  // inv_accesorios_*, el redact solo cubre `en_tecnico_*` (escalares) + los
  // usd/ars del array `inv_por_clase[]`.
  try {
    const metricas = await fetchMetricas(req.tenantId);
    const canSeeCostos = await hasCapability(req.user, 'inventario.ver_costos');
    if (canSeeCostos) {
      res.json(metricas);
      return;
    }
    // Redact los campos monetarios (Fase 2c). Devolvemos null (no undefined
    // ni delete) para que el frontend reconozca la ausencia y muestre "—"
    // en vez de "$0" — bug U1 detectado en la auditoría original F5b.
    const invPorClaseRedacted = (metricas.inv_por_clase || []).map(c => ({
      ...c,
      usd: null,
      ars: null,
    }));
    res.json({
      ...metricas,
      en_tecnico_usd:    null,
      en_tecnico_ars:    null,
      inv_por_clase:     invPorClaseRedacted,
    });
  } catch (err) { next(err); }
});

// 2026-06-30 #imei-dup: chequeo previo de IMEI duplicado para la UX de alta.
// La decisión durable (migration 20260524000001_inventario.js:13-15) es no
// poner UNIQUE en DB porque un IMEI puede reingresar via canje cuando un
// equipo vendido vuelve. Pero EN EL MOMENTO DE LA CARGA queremos avisar al
// operador si ese IMEI ya está cargado en otro producto ACTIVO — la mayoría
// de los duplicados son tipeos o re-cargas accidentales.
//
// Filtra por estado='disponible' + deleted_at IS NULL deliberadamente:
//   - vendido        → su IMEI puede reingresar via canje
//   - en_tecnico     → físicamente en stock, pero ya cargado → bloqueamos
//   - reservado      → ya cargado → bloqueamos
//   - deleted_at <>  → soft-deleted, su IMEI puede reusarse
//
// Lucas pidió bloquear si está en otro "activo" — interpretamos activo como
// disponible (que es donde tienen sentido los duplicados problemáticos). Si
// en el futuro hay que ampliar a en_tecnico/reservado, es 1 línea.
//
// 200 en todos los casos (no es error de auth/validación): si el caller
// recibe { exists: true } decide cómo presentarlo. Si el IMEI es vacío o
// solo espacios → 400 (caller debería filtrar antes de llamar).
router.get('/productos/check-imei', async (req, res, next) => {
  try {
    const imei = String(req.query.imei ?? '').trim();
    if (!imei) return res.status(400).json({ error: 'IMEI requerido' });

    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, nombre, estado
           FROM productos
          WHERE imei = $1
            AND deleted_at IS NULL
            AND estado = 'disponible'
          LIMIT 1`,
        [imei]
      );
      return rows[0] || null;
    });

    if (!row) return res.json({ exists: false });
    res.json({ exists: true, producto: { id: row.id, nombre: row.nombre, estado: row.estado } });
  } catch (err) { next(err); }
});

// Proveedores únicos vistos en productos vivos. Insumo del combo de edición
// inline (Inventario): no tenemos tabla de proveedores como FK, así que esto
// es la mejor fuente de verdad para autocompletar. DISTINCT chico (≤cientos
// en cualquier escenario realista) → query sin paginación.
router.get('/productos/proveedores', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      // 2026-07-12 (auditoría TOTAL Stock P3-3): LIMIT 500 defensivo. La
      // grilla de autocomplete no muestra más — este es el techo prudente
      // para prevenir que un tenant B2B grande devuelva miles de strings.
      const { rows } = await client.query(`
        SELECT DISTINCT TRIM(proveedor) AS proveedor
          FROM productos
         WHERE deleted_at IS NULL
           AND proveedor IS NOT NULL
           AND TRIM(proveedor) <> ''
         ORDER BY proveedor
         LIMIT 500
      `);
      return rows;
    });
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
// 2026-06-23 F5b: el endpoint /desglose es PURO breakdown de costos
// (inv_usd, valorizado_usd, margen). Sin `inventario.ver_costos` no
// hay shape parcial razonable — devolvemos 403 directo.
router.get('/desglose', requireCapability('inventario.ver_costos'), validate(queryDesgloseSchema, 'query'), async (req, res, next) => {
  try {
    const { por, clase_id, clase, estado, categoria_id, deposito_id, proveedor, solo_stock, buscar } = req.query;
    const dim = DIM_CONFIG[por];
    if (!dim) return res.status(400).json({ error: 'Dimensión inválida' });

    const conditions = ['p.deleted_at IS NULL'];
    const params = [];
    // F3.d-3 (2026-07-09): filtro principal `?clase_id=UUID`.
    // Compat legacy: `?clase=<slug>` sigue soportado — mismo EXISTS que en
    // GET /productos.
    if (clase_id) {
      params.push(clase_id);
      conditions.push(`p.clase_id = $${params.length}`);
    } else if (clase) {
      params.push(clase);
      conditions.push(`EXISTS (
        SELECT 1 FROM clases_producto cpf
         WHERE cpf.id = p.clase_id
           AND cpf.slug_legacy = $${params.length}
           AND cpf.deleted_at IS NULL
      )`);
    }
    if (estado)       { params.push(estado);       conditions.push(`p.estado = $${params.length}`); }
    if (categoria_id) { params.push(categoria_id); conditions.push(`p.categoria_id = $${params.length}`); }
    if (deposito_id)  { params.push(deposito_id);  conditions.push(`p.deposito_id = $${params.length}`); }
    if (proveedor)    { params.push(proveedor);    conditions.push(`TRIM(COALESCE(p.proveedor, '')) = $${params.length}`); }
    if (solo_stock)   { conditions.push(`p.estado = 'disponible' AND p.cantidad > 0`); }
    // 2026-07-14: tokenización — cada palabra debe aparecer en algún campo.
    // Precisión reforzada vs. `%iPhone 17%` literal anterior.
    const searchClauseDesglose = buildSearchClause(buscar, ['p.nombre', 'p.imei', 'p.color', 'p.gb'], params);
    if (searchClauseDesglose) conditions.push(searchClauseDesglose);
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

    // 2 queries serializadas sobre el mismo client dentro de una sola tx con
    // el tenant context. withTenant envuelve el callback en BEGIN/COMMIT — las
    // 2 queries comparten tx y RLS aplica a ambas. Obligatorio serializar con
    // pg@9+: no se pueden ejecutar queries concurrentes sobre el mismo client
    // (el protocolo Postgres es secuencial → Promise.all no daba paralelismo).
    const [filasRes, totalRes] = await db.withTenant(req.tenantId, async (client) => {
      const filas = await client.query(filasQuery, params);
      const total = await client.query(totalQuery, params);
      return [filas, total];
    });

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
    const { buscar, clase_id, clase, estado, categoria_id, deposito_id, solo_stock,
            nombre, proveedor, gb, color, vista, condicion, desde, hasta } = req.query;

    const conditions = ['p.deleted_at IS NULL'];
    const params = [];
    // F3.d-3 (2026-07-09): filtro principal `?clase_id=UUID`.
    // Compat legacy: `?clase=<slug>` sigue soportado — resolvemos vía EXISTS
    // en clases_producto.slug_legacy para no obligar a los tests / bookmarks
    // viejos a regenerar la URL. Ambos aceptados; si vienen los dos, gana
    // clase_id (más específico).
    if (clase_id)     { params.push(clase_id);     conditions.push(`p.clase_id = $${params.length}`); }
    else if (clase)   {
      params.push(clase);
      conditions.push(`EXISTS (
        SELECT 1 FROM clases_producto cpf
         WHERE cpf.id = p.clase_id
           AND cpf.slug_legacy = $${params.length}
           AND cpf.deleted_at IS NULL
      )`);
    }
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
      // 2026-07-04 (#507) — Filtro por fecha de venta cuando vista='vendidos'.
      // Cubre ambos canales:
      //   - Retail: venta_items.producto_id → ventas.fecha
      //   - B2B:    items_movimiento_cc.producto_id → movimientos_cc.fecha
      //             (mc.tipo='compra' = compra que el cliente CC nos hace).
      // Un producto matchea si tiene AL MENOS UN item en cualquiera de los 2
      // canales dentro del rango. Ambos EXISTS respetan soft-deletes.
      if (desde || hasta) {
        const desdeIdx = desde ? (params.push(desde), params.length) : null;
        const hastaIdx = hasta ? (params.push(hasta), params.length) : null;
        const fechaRetail = [
          desdeIdx ? `v.fecha >= $${desdeIdx}` : null,
          hastaIdx ? `v.fecha <= $${hastaIdx}` : null,
        ].filter(Boolean).join(' AND ');
        const fechaB2B = [
          desdeIdx ? `mc.fecha >= $${desdeIdx}` : null,
          hastaIdx ? `mc.fecha <= $${hastaIdx}` : null,
        ].filter(Boolean).join(' AND ');
        conditions.push(`(
          EXISTS (
            SELECT 1 FROM venta_items vi
            JOIN ventas v ON v.id = vi.venta_id
            WHERE vi.producto_id = p.id
              AND v.deleted_at IS NULL
              AND ${fechaRetail}
          )
          OR EXISTS (
            SELECT 1 FROM items_movimiento_cc ic
            JOIN movimientos_cc mc ON mc.id = ic.movimiento_cc_id
            WHERE ic.producto_id = p.id
              AND mc.tipo = 'compra'
              AND mc.deleted_at IS NULL
              AND ${fechaB2B}
          )
        )`);
      }
    } else if (vistaEfectiva === 'todos_visibles') {
      conditions.push(`p.oculto = false`);
    }
    // 'todos_ocultos' → sin filtro extra: ve todo.

    // Igualdades exactas — drill-down desde Desglose 360.
    if (nombre)    { params.push(nombre);    conditions.push(`p.nombre = $${params.length}`); }
    if (proveedor) { params.push(proveedor); conditions.push(`TRIM(COALESCE(p.proveedor, '')) = $${params.length}`); }
    if (gb)        { params.push(gb);        conditions.push(`TRIM(COALESCE(p.gb, '')) = $${params.length}`); }
    if (color)     { params.push(color);     conditions.push(`TRIM(COALESCE(p.color, '')) = $${params.length}`); }
    // 2026-07-14 v2 (follow-up del tokenización PR #615, feedback Lucas):
    // ahora usamos `buildSearchWithRanking` en /productos. Diferencias vs
    // buildSearchClause legacy (que sigue vivo para /desglose y /vendidos):
    //   · WHERE: agrega 2da vía fuzzy (similarity(nombre) >= 0.35) para tolerar
    //     typos. Ej: "iphon 17" (typo) → matchea "iPhone 17 Pro Max".
    //   · ORDER BY: score compuesto que prioriza matches en `nombre` sobre
    //     matches en IMEI/color/gb. Los más relevantes salen primero.
    const searchRanking = buildSearchWithRanking(buscar, params);
    if (searchRanking.where) conditions.push(searchRanking.where);
    const where = conditions.join(' AND ');
    // ORDER BY: si hay búsqueda activa, prioriza por score; sino, orden alfabético.
    // El `p.nombre, p.id DESC` queda como tie-breaker en ambos casos.
    const orderByClause = searchRanking.orderBy
      ? `${searchRanking.orderBy}, p.nombre, p.id DESC`
      : `p.nombre, p.id DESC`;
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });

    const countQuery = `SELECT COUNT(*) FROM productos p WHERE ${where}`;
    // LIMIT/OFFSET indexes en el dataQuery deben apuntar DESPUÉS de los
    // orderByParams (que también se appendan al final). Con búsqueda activa:
    // [...params, rawQuery, limit, offset] → limit=$N+1, offset=$N+2 donde
    // N = params.length + orderByParams.length.
    const orderByParamsCount = (searchRanking.orderByParams || []).length;
    const limitIdx = params.length + orderByParamsCount + 1;
    const offsetIdx = params.length + orderByParamsCount + 2;
    const dataQuery = `
      SELECT p.id, p.tipo_carga, p.clase_id, cp.slug_legacy AS clase,
             p.nombre, p.imei, p.gb, p.color, p.bateria,
             p.categoria_id, p.deposito_id, p.proveedor, p.costo, p.costo_moneda,
             p.precio_venta, p.precio_moneda, p.trackear_stock, p.cantidad, p.estado,
             p.observaciones, p.condicion, p.oculto, p.created_at,
             (p.foto_data IS NOT NULL OR p.foto_key IS NOT NULL) AS tiene_foto, p.foto_nombre, p.foto_tipo,
             c.nombre AS categoria_nombre, d.nombre AS deposito_nombre
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN depositos  d ON d.id = p.deposito_id
      LEFT JOIN clases_producto cp ON cp.id = p.clase_id AND cp.deleted_at IS NULL
      WHERE ${where}
      ORDER BY ${orderByClause}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    // countQuery usa solo los params del WHERE (no tiene ORDER BY).
    // dataQuery usa params WHERE + orderByParams (rawQuery para similarity) + limit + offset.
    const orderByParams = searchRanking.orderByParams || [];
    const [countRes, dataRes] = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query(countQuery, params);
      const dataRes = await client.query(dataQuery, [...params, ...orderByParams, limit, offset]);
      return [countRes, dataRes];
    });

    // 2026-06-23 F5b: response shaping. Si el user no tiene
    // `inventario.ver_costos`, sacamos `costo` y `costo_moneda` de cada
    // fila. El frontend ya tiene la cap en JWT y oculta la columna —
    // este es defense in depth + protege llamadas directas a la API.
    const canSeeCostos = await hasCapability(req.user, 'inventario.ver_costos');
    const rows = canSeeCostos
      ? dataRes.rows
      : dataRes.rows.map(({ costo, costo_moneda, ...rest }) => rest);

    res.json(paginatedResponse(rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

/**
 * GET /api/inventario/usados — Tab "Equipos usados" en Inventario (2026-07-11).
 *
 * Lista productos con `condicion='usado'` (celulares canjeados, usados
 * cargados manualmente en Inventario, etc.) con trazabilidad de origen:
 * si el producto vino de un canje, se hace LEFT JOIN a `canjes` + `ventas`
 * + `contactos` para exponer `origen: 'canje'` + `canje_origen: { venta_id,
 * order_id, fecha, cliente_nombre, cliente_telefono }`. Si el producto no
 * viene de ningún canje, `origen: 'manual'` y `canje_origen: null`.
 *
 * Motivación (Lucas 2026-07-11): tener un lugar dedicado para revisar el
 * stock usado — quiénes son los clientes que dejaron equipos por canje, a
 * qué precio se tomaron, cuál es el estado batería, etc. La vista principal
 * de Inventario mezcla nuevo + usado y no diferencia origen.
 *
 * Filtros aceptados (queryUsadosSchema):
 *   - buscar:      LIKE en nombre + IMEI + color + gb + cliente_nombre
 *   - solo_canjes: bool, filtra a los que efectivamente vinieron por canje
 *   - estado:      productos.estado (disponible / vendido / en_tecnico / reservado)
 *   - desde/hasta: rango sobre productos.created_at (fecha de ingreso)
 *   - page/limit:  paginación estándar
 *
 * Response shape (paginado):
 *   {
 *     data: [{
 *       ...productos fields...,
 *       clase_nombre, clase_emoji,
 *       categoria_nombre, deposito_nombre,
 *       origen: 'canje' | 'manual',
 *       canje_origen: {
 *         venta_id, order_id, fecha,
 *         cliente_nombre, cliente_telefono
 *       } | null
 *     }],
 *     pagination: { page, limit, total, pages }
 *   }
 *
 * Nota RLS: `canjes` no tiene columna tenant_id explícita pero hereda por
 * cascade desde `ventas` (venta_id FK); RLS de ventas ya filtra por tenant,
 * y el LEFT JOIN de canjes no filtra rows del tenant → seguro.
 * Un producto puede tener 0 o 1 canje asociado (relación 1:1 en la
 * práctica: canje POST crea el producto y setea producto_id). Si por
 * alguna razón hay >1, tomamos el más reciente vía LATERAL.
 */
router.get('/usados', validate(queryUsadosSchema, 'query'), async (req, res, next) => {
  try {
    const { buscar, solo_canjes, solo_manual, estado, desde, hasta } = req.query;
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });

    const conditions = [
      `p.deleted_at IS NULL`,
      `p.condicion = 'usado'`,       // scope del tab
    ];
    const params = [];
    if (estado) { params.push(estado); conditions.push(`p.estado = $${params.length}`); }
    if (desde)  { params.push(desde);  conditions.push(`p.created_at::date >= $${params.length}`); }
    if (hasta)  { params.push(hasta);  conditions.push(`p.created_at::date <= $${params.length}`); }
    if (solo_canjes) {
      conditions.push(`cj.id IS NOT NULL`);
    }
    // 2026-07-11: `solo_manual` filtra a los que NO vinieron por canje
    // (compra externa, lote de usados a proveedor, carga manual desde el
    // form). Complemento de `solo_canjes` para el Seg de 3 estados del
    // frontend (Todos / Canjes / Carga manual).
    if (solo_manual) {
      conditions.push(`cj.id IS NULL`);
    }
    // 2026-07-14: tokenización — /vendidos incluye v.cliente_nombre en los
    // campos buscables además del producto. Ej. "Juan iPhone" busca ventas
    // de cliente Juan con producto iPhone.
    const searchClauseVend = buildSearchClause(buscar,
      ['p.nombre', 'p.imei', 'p.color', 'p.gb', 'v.cliente_nombre'], params);
    if (searchClauseVend) conditions.push(searchClauseVend);
    const where = conditions.join(' AND ');

    // JOIN LATERAL sobre `canjes` para tomar solo el canje más reciente si
    // por algún motivo hay >1 con el mismo producto_id. Simplifica el
    // paginado (una fila por producto siempre).
    const baseFrom = `
      FROM productos p
      LEFT JOIN clases_producto cp ON cp.id = p.clase_id AND cp.deleted_at IS NULL
      LEFT JOIN categorias       c  ON c.id  = p.categoria_id AND c.deleted_at IS NULL
      LEFT JOIN depositos        d  ON d.id  = p.deposito_id  AND d.deleted_at IS NULL
      LEFT JOIN LATERAL (
        -- 2026-07-12 (audit Stock P1-1): cj.deleted_at IS NULL — filter
        -- del partial index idx_canjes_venta_id_activos.
        SELECT cj.id, cj.venta_id, cj.valor_toma, cj.moneda AS canje_moneda
          FROM canjes cj
         WHERE cj.producto_id = p.id AND cj.deleted_at IS NULL
         ORDER BY cj.created_at DESC
         LIMIT 1
      ) cj ON true
      LEFT JOIN ventas   v  ON v.id  = cj.venta_id AND v.deleted_at IS NULL
      LEFT JOIN contactos co ON co.id = v.cliente_id AND co.deleted_at IS NULL
    `;

    const countQuery = `SELECT COUNT(*) ${baseFrom} WHERE ${where}`;
    const dataQuery = `
      SELECT p.id, p.tipo_carga, p.clase_id, cp.slug_legacy AS clase,
             cp.nombre AS clase_nombre, cp.emoji AS clase_emoji,
             p.nombre, p.imei, p.gb, p.color, p.bateria,
             p.categoria_id, p.deposito_id, p.proveedor,
             p.costo, p.costo_moneda,
             p.precio_venta, p.precio_moneda,
             p.trackear_stock, p.cantidad, p.estado, p.observaciones,
             p.condicion, p.oculto, p.created_at,
             (p.foto_data IS NOT NULL OR p.foto_key IS NOT NULL) AS tiene_foto,
             p.foto_nombre, p.foto_tipo,
             c.nombre AS categoria_nombre,
             d.nombre AS deposito_nombre,
             -- Trazabilidad del canje (NULL si el producto es "manual").
             cj.id       AS canje_id,
             cj.venta_id AS canje_venta_id,
             v.order_id  AS canje_venta_order_id,
             v.fecha     AS canje_venta_fecha,
             v.cliente_nombre AS canje_cliente_nombre,
             co.telefono AS canje_cliente_telefono
        ${baseFrom}
       WHERE ${where}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const [countRes, dataRes] = await db.withTenant(req.tenantId, async (client) => {
      const c = await client.query(countQuery, params);
      const d = await client.query(dataQuery, [...params, limit, offset]);
      return [c, d];
    });

    // Defensa de costos: mismo pattern que /productos. Sin cap ver_costos,
    // sacamos costo + costo_moneda (y también el valor_toma del canje).
    const canSeeCostos = await hasCapability(req.user, 'inventario.ver_costos');

    const rows = dataRes.rows.map((r) => {
      const {
        canje_id, canje_venta_id, canje_venta_order_id, canje_venta_fecha,
        canje_cliente_nombre, canje_cliente_telefono,
        costo, costo_moneda,
        ...rest
      } = r;
      const base = {
        ...rest,
        origen: canje_id ? 'canje' : 'manual',
        canje_origen: canje_id ? {
          canje_id,
          venta_id:         canje_venta_id,
          venta_order_id:   canje_venta_order_id,
          venta_fecha:      canje_venta_fecha,
          cliente_nombre:   canje_cliente_nombre,
          cliente_telefono: canje_cliente_telefono,
        } : null,
      };
      // Solo agrego costo/costo_moneda si el user puede verlos.
      if (canSeeCostos) {
        base.costo = costo;
        base.costo_moneda = costo_moneda;
      }
      return base;
    });

    res.json(paginatedResponse(rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

// Foto on-demand: el blob NO viaja en el listado (evita transferir base64 en cada query)
/**
 * GET /api/inventario/productos/:id/historial — Trazabilidad de un producto.
 *
 * Devuelve la compra de origen y la venta (si ya se vendió) para mostrar en el
 * modal de Inventario. Diseño 2026-06-15 para cerrar el loop de trazabilidad
 * (Fase 1 dejó la trazabilidad forward: import XLSX → compras en Proveedores;
 * Fase 2 cierra con el reverse: producto → compra + venta).
 *
 * Joins:
 *   - Compra: match por imei_serial contra proveedor_movimiento_items
 *     (no hay FK directa porque el match histórico se hizo a posteriori en
 *     compras pre-Fase-1). Solo aplica si el producto tiene IMEI.
 *   - Venta retail: venta_items.producto_id (FK directa).
 *   - Venta B2B: items_movimiento_cc.producto_id (FK directa).
 *
 * Si un producto fue vendido por dos canales (caso edge, no debería pasar pero
 * datos malos pueden hacerlo), se prioriza la más reciente por fecha.
 *
 * Response shape:
 *   { compra: {...} | null, venta: {...} | null }
 */
router.get('/productos/:id/historial', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // Las 3 queries (producto base + compra de origen + venta retail/B2B)
    // van dentro de la misma tx con tenant context. Más eficiente y RLS
    // aplica a las 3 consistentemente.
    const { prodRows, compra, ventaRetail, ventaB2B } = await db.withTenant(req.tenantId, async (client) => {
      const { rows: prodRows } = await client.query(
        `SELECT id, imei FROM productos WHERE id = $1 AND deleted_at IS NULL`,
        [id]
      );
      if (!prodRows[0]) return { prodRows, compra: null, ventaRetail: [], ventaB2B: [] };
      const imei = (prodRows[0].imei || '').trim();

      let compra = null;
      if (imei) {
        const { rows } = await client.query(`
          SELECT pm.id          AS movimiento_id,
                 pm.fecha       AS fecha,
                 pm.proveedor_id,
                 pr.nombre      AS proveedor_nombre,
                 pm.monto       AS monto,
                 pm.moneda      AS moneda,
                 pm.monto_usd   AS monto_usd,
                 pm.descripcion AS descripcion,
                 pmi.valor      AS valor_item
            FROM proveedor_movimiento_items pmi
            JOIN proveedor_movimientos pm ON pm.id = pmi.proveedor_movimiento_id
            JOIN proveedores           pr ON pr.id = pm.proveedor_id
           WHERE pmi.imei_serial = $1
             AND pm.tipo = 'compra'
             AND pm.deleted_at IS NULL
             AND pr.deleted_at IS NULL
           ORDER BY pm.fecha DESC, pm.id DESC
           LIMIT 1
        `, [imei]);
        compra = rows[0] || null;
      }

      const { rows: ventaRetail } = await client.query(`
        SELECT v.id             AS venta_id,
               v.fecha          AS fecha,
               v.cliente_id     AS cliente_id,
               COALESCE(c.nombre, v.cliente_nombre) AS cliente_nombre,
               vi.precio_vendido AS precio_vendido,
               vi.moneda        AS moneda,
               v.ganancia_usd   AS ganancia_usd,
               v.estado         AS estado
          FROM venta_items vi
          JOIN ventas v     ON v.id = vi.venta_id
          LEFT JOIN contactos c ON c.id = v.cliente_id
         WHERE vi.producto_id = $1
           AND v.deleted_at IS NULL
         ORDER BY v.fecha DESC, v.id DESC
         LIMIT 1
      `, [id]);

      const { rows: ventaB2B } = await client.query(`
        SELECT mc.id           AS venta_id,
               mc.fecha        AS fecha,
               mc.cliente_cc_id AS cliente_id,
               cc.nombre       AS cliente_nombre,
               ic.valor        AS precio_vendido,
               'USD'           AS moneda
          FROM items_movimiento_cc ic
          JOIN movimientos_cc mc ON mc.id = ic.movimiento_cc_id
          JOIN clientes_cc    cc ON cc.id = mc.cliente_cc_id
         WHERE ic.producto_id = $1
           AND mc.tipo = 'compra'
           AND mc.deleted_at IS NULL
         ORDER BY mc.fecha DESC, mc.id DESC
         LIMIT 1
      `, [id]);

      return { prodRows, compra, ventaRetail, ventaB2B };
    });

    if (!prodRows[0]) return res.status(404).json({ error: 'Producto no encontrado' });

    // Si hay venta por ambos canales (no debería), la más reciente gana.
    let venta = null;
    const cand = [];
    if (ventaRetail[0]) cand.push({ ...ventaRetail[0], tipo: 'retail' });
    if (ventaB2B[0])    cand.push({ ...ventaB2B[0],    tipo: 'b2b' });
    if (cand.length > 0) {
      cand.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      venta = cand[0];
    }

    // 2026-06-23 F5b: response shaping.
    //   - `inventario.ver_compras` controla si vemos el bloque compra.
    //     Vendedor NO la tiene (no debería saber a qué proveedor le
    //     compramos ni cuánto). Encargado SÍ.
    //   - `inventario.ver_costos` controla los campos monetarios
    //     (monto/valor_item) dentro del bloque. Encargado SÍ, vendedor NO.
    // Hacemos check ANTES de construir el body para no exponer datos.
    //
    // BLOCKER 2026-07-05 P1 (seguridad ganancias): antes el bloque `venta`
    // salía con `ganancia_usd` sin gating — un vendedor con `inventario.ver`
    // pero SIN `ventas.ver_ganancias` podía leer la ganancia de cada producto
    // vendido navegando el historial. Fix consistente con el patrón de #510:
    // redactamos `ganancia_usd` del bloque venta si el user no puede ver
    // ganancias. Owner/admin bypass (hasCapability retorna true).
    const [canSeeCompras, canSeeCostos, canSeeGanancias] = await Promise.all([
      hasCapability(req.user, 'inventario.ver_compras'),
      hasCapability(req.user, 'inventario.ver_costos'),
      hasCapability(req.user, 'ventas.ver_ganancias'),
    ]);
    let compraOut = null;
    if (canSeeCompras && compra) {
      if (canSeeCostos) {
        compraOut = compra;
      } else {
        // Redacto montos pero conservo proveedor/fecha (info no-monetaria
        // que igual es parte del historial visual).
        const { monto, monto_usd, valor_item, moneda, ...rest } = compra;
        compraOut = rest;
      }
    }

    let ventaOut = venta;
    if (venta && !canSeeGanancias) {
      const { ganancia_usd, ...ventaRest } = venta;
      ventaOut = ventaRest;
    }

    res.json({ compra: compraOut, venta: ventaOut });
  } catch (err) { next(err); }
});

router.get('/productos/:id/foto', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    // P-03 Fase 4: la lectura pasa por fileStore. Driver db lee foto_data
    // directo. Driver r2 chequea primero foto_key (baja de R2) y hace fallback
    // a foto_data para filas legacy. Shape del response { foto_data, foto_nombre,
    // foto_tipo } NO cambia — frontend intacto. foto_key incluida en el SELECT
    // para que el driver r2 pueda decidir el path.
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT foto_data, foto_key, foto_nombre, foto_tipo FROM productos WHERE id = $1 AND deleted_at IS NULL', [id]
      );
      return rows[0] || null;
    });
    if (!row) return res.status(404).json({ error: 'Sin foto' });
    const file = await fileStore.get(row, { prefix: 'foto' });
    if (!file) return res.status(404).json({ error: 'Sin foto' });
    res.json({ foto_data: file.data, foto_nombre: file.nombre, foto_tipo: file.tipo });
  } catch (err) { next(err); }
});

// P-03 Fase 4: foto_key + foto_size se agregan al array. Cuando el upload
// va a R2 (flag ON + driver r2), foto_data queda NULL y la referencia vive
// en foto_key. Cuando va a path legacy (flag OFF o driver db), foto_key y
// foto_size quedan NULL y la columna legacy foto_data conserva el base64.
// F3.d-3 (2026-07-09): `clase` VARCHAR se dropeó (migration 20260709000001).
// PRODUCTO_COLS ya no incluye la columna legacy — solo `clase_id`.
const PRODUCTO_COLS = [
  'tipo_carga', 'clase_id', 'nombre', 'imei', 'gb', 'color', 'bateria',
  'categoria_id', 'deposito_id', 'proveedor', 'costo', 'costo_moneda',
  'precio_venta', 'precio_moneda', 'trackear_stock', 'cantidad', 'estado',
  'foto_data', 'foto_nombre', 'foto_tipo', 'foto_key', 'foto_size',
  'observaciones', 'condicion', 'oculto',
];

// F3.d-3: helper que resuelve la categoría para el body del producto.
//
// Nueva ruta (post-F3.c-2): body trae `clase_id` UUID → valida que exista +
// devuelve `slug_legacy` (para validar coherencia unitario ↔ cantidad).
//
// Ruta legacy (deprecated compat): body trae solo `clase` = slug F1 →
// buscamos el `clase_id` de la fila base (`es_base=true AND slug_legacy=$clase`).
// Sirve para clientes viejos que aún envían slug + tests preexistentes.
// El body.clase se ignora en el INSERT/UPDATE — solo persiste `clase_id`.
async function resolveClaseInfo(client, tenantId, body) {
  let clase_id = body.clase_id;
  const claseSlug = body.clase;
  if (!clase_id && claseSlug) {
    // Compat: derive clase_id desde slug legacy.
    const { rows } = await client.query(
      `SELECT id, slug_legacy FROM clases_producto
        WHERE tenant_id = $1 AND slug_legacy = $2 AND es_base = true
          AND deleted_at IS NULL
        LIMIT 1`,
      [tenantId, claseSlug]
    );
    if (rows[0]) {
      body.clase_id = rows[0].id;   // muta body para que el INSERT use el UUID
      return { slug_legacy: rows[0].slug_legacy };
    }
    // slug no matcheó → dejamos clase_id null (edge case: tenant sin esa base)
  }
  if (!clase_id) return { slug_legacy: null };
  const { rows } = await client.query(
    `SELECT slug_legacy FROM clases_producto
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [clase_id, tenantId]
  );
  if (!rows[0]) {
    const err = new Error(`La categoría (clase_id=${clase_id}) no existe o fue borrada.`);
    err.status = 400;
    err.code = 'clase_id_invalido';
    throw err;
  }
  return { slug_legacy: rows[0].slug_legacy };
}

// F3.d-3: agrega `clase` sintético al row del producto para compat con
// clientes que aún esperan ese field en el response. El slug viene del JOIN
// a `clases_producto.slug_legacy`. Solo se ejecuta para responses (nunca
// muta la DB). Un extra SELECT por producto — costo aceptable durante la
// transición de F3.
async function agregarClaseCompat(client, row) {
  if (!row || !row.clase_id) return row;
  const { rows } = await client.query(
    `SELECT slug_legacy FROM clases_producto WHERE id = $1 AND deleted_at IS NULL`,
    [row.clase_id]
  );
  if (rows[0]) row.clase = rows[0].slug_legacy;
  return row;
}

// F3.d-3: valida coherencia unitario ↔ cantidad post-derive del slug_legacy.
// Antes vivía como refine Zod en el schema; ahora acá porque necesita el
// slug_legacy que sale de `clases_producto` (no del body).
function validarUnitarioCoherente(slug_legacy, body) {
  if (!slug_legacy) return; // categoría custom del tenant (no base) — sin regla
  if (!SLUGS_UNITARIOS.has(slug_legacy)) return;
  if (body.tipo_carga !== 'unitario') return;
  if (Number(body.cantidad) === 1 || body.cantidad == null) return;
  const err = new Error('Un producto unitario debe tener cantidad = 1');
  err.status = 400;
  err.path = ['cantidad'];
  throw err;
}

router.post('/productos', requireCapability('inventario.crear'), validate(createProductoSchema), async (req, res, next) => {
  try {
    // Multi-país F2: el schema acepta UYU + ARS, pero el tenant solo puede
    // usar las monedas habilitadas para su país (assertMonedaValidaParaPais
    // rebota con 400 si no). Cada producto tiene 2 monedas — costo + precio
    // — y cada una se valida independientemente con su fieldName para que el
    // error indique cuál de las dos fue inválida.
    assertMonedaValidaParaPais(req.body.costo_moneda, req.tenantPais, 'costo_moneda');
    assertMonedaValidaParaPais(req.body.precio_moneda, req.tenantPais, 'precio_moneda');

    // Auditoría 2026-06-30 IMEI race — chequeo preventivo en POST single.
    // Antes solo el bulk import filtraba IMEIs duplicados (POST /productos/bulk
    // tiene este mismo SELECT). El POST single no tenía nada → un operador
    // podía cargar el mismo IMEI dos veces y la DB lo aceptaba (no había
    // UNIQUE constraint hasta migration 20260701000003).
    //
    // El check preventivo da un 409 limpio con mensaje claro (vs el 500 opaco
    // que devolvería el INSERT al violar el UNIQUE). El UNIQUE PARCIAL de la
    // migration es la defensa final que cierra la ventana de race entre este
    // check y el INSERT — si dos requests concurrentes pasan el check al
    // mismo tiempo, solo uno gana el INSERT (el otro recibe 23505 que
    // mapeamos a 409 abajo en el catch).
    const imeiInput = (req.body.imei || '').trim();
    if (imeiInput) {
      const yaExiste = await db.withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT id, nombre, estado FROM productos
             WHERE imei = $1
               AND deleted_at IS NULL
               AND estado = 'disponible'
             LIMIT 1`,
          [imeiInput]
        );
        return rows[0] || null;
      });
      if (yaExiste) {
        return res.status(409).json({
          error: 'IMEI ya cargado en otro producto disponible',
          duplicado: { id: yaExiste.id, nombre: yaExiste.nombre, estado: yaExiste.estado },
        });
      }
    }

    // Defaults JS para columnas NOT NULL nuevas (la migración tiene DEFAULT,
    // pero como el INSERT lista todas las columnas explícitamente pasaríamos
    // NULL si el cliente no las manda → NOT NULL violation). Defaultear acá
    // es más simple que ramificar el SQL.
    const b = {
      ...req.body,
      condicion: req.body.condicion ?? 'nuevo',
      oculto:    req.body.oculto    ?? false,
    };
    // P-03 Fase 4: bifurcación de upload por feature flag (mismo patrón que
    // comprobantes en Fase 3).
    //   Flag ON + STORAGE_DRIVER=r2 → fileStore.put sube a R2 y devuelve
    //     `{ data: null, key: '...' }`. INSERT guarda key+size, foto_data NULL.
    //   Flag OFF o driver=db → bypass: foto_data preserva el base64, key+size
    //     quedan NULL. Comportamiento idéntico al pre-fase-4.
    // Reads (GET /productos/:id/foto, listado tiene_foto) usan fileStore.get
    // con fallback automático — flippear el flag no rompe acceso a fotos
    // anteriores.
    const useR2 = fileStore._DRIVER === 'r2'
               && await storageFlags.isEnabled('storage_r2_productos');
    let fotoFile;
    if (useR2) {
      fotoFile = await fileStore.put({
        tenantId: req.tenantId,  // PR 5 multi-tenant: prefix t{tenantId}/ en la key R2
        dataBase64: b.foto_data ?? null,
        filename: b.foto_nombre ?? null,
        mime: b.foto_tipo ?? null,
        entity: 'productos',
      });
    } else {
      fotoFile = {
        data: b.foto_data ?? null,
        key: null,
        size: null,
        nombre: b.foto_nombre ?? null,
        tipo: b.foto_tipo ?? null,
      };
    }
    b.foto_data   = fotoFile.data;
    b.foto_nombre = fotoFile.nombre;
    b.foto_tipo   = fotoFile.tipo;
    b.foto_key    = fotoFile.key;
    b.foto_size   = fotoFile.size;
    const placeholders = PRODUCTO_COLS.map((_, i) => `$${i + 1}`).join(',');
    const row = await db.withTenant(req.tenantId, async (client) => {
      // F3.d-3: valida clase_id + coherencia unitario ↔ cantidad. Sin derive
      // bidireccional (columna `clase` dropeada en migration 20260709000001).
      const { slug_legacy } = await resolveClaseInfo(client, req.tenantId, b);
      validarUnitarioCoherente(slug_legacy, b);

      const values = PRODUCTO_COLS.map(c => b[c] ?? null);
      const { rows } = await client.query(
        `INSERT INTO productos (${PRODUCTO_COLS.join(',')}) VALUES (${placeholders}) RETURNING *`,
        values
      );
      // F3.d-3: hidrata `clase` sintético en el response (compat).
      await agregarClaseCompat(client, rows[0]);
      await audit(client, 'productos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
      return rows[0];
    });
    invalidateMetricas(req.tenantId);  // junio 2026: cache stale era fuente de bugs de baseline
    res.status(201).json(row);
  } catch (err) {
    // Auditoría 2026-06-30 IMEI race — si dos requests pasaron el check
    // preventivo al mismo tiempo, el UNIQUE PARCIAL de DB rebota uno con
    // 23505 (unique_violation). Mapeamos a 409 con mensaje claro en lugar
    // del 500 opaco que el next(err) genérico devolvería.
    if (err && err.code === '23505' && err.constraint === 'idx_productos_imei_unique') {
      return res.status(409).json({
        error: 'IMEI ya cargado en otro producto disponible (conflicto concurrente).',
      });
    }
    next(err);
  }
});

router.put('/productos/:id', requireCapability('inventario.editar'), validate(updateProductoSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // Multi-país F2: validación país-aware si el PUT trae monedas.
    // updateProductoSchema es .partial(), así que `costo_moneda`/`precio_moneda`
    // pueden venir undefined (no se cambian); el helper hace no-op en ese caso.
    assertMonedaValidaParaPais(req.body.costo_moneda, req.tenantPais, 'costo_moneda');
    assertMonedaValidaParaPais(req.body.precio_moneda, req.tenantPais, 'precio_moneda');

    const before = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM productos WHERE id = $1 AND deleted_at IS NULL', [id]
      );
      return rows;
    });
    if (!before[0]) return res.status(404).json({ error: 'Producto no encontrado' });

    // P-03 Fase 4: si vino una foto nueva en el body, bifurcar por flag y
    // procesar. Preserva la semántica COALESCE para el resto de columnas: si
    // el cliente NO envió un campo, no se toca.
    //
    // Cuando se cambia la foto y el flag está ON + driver r2: se sube a R2,
    // foto_key se setea con la key nueva y foto_data se nullifica. Cuando
    // el flag está OFF: foto_data preserva el base64, foto_key se nullifica.
    // La key anterior (si existía) en R2 queda huérfana — el cleanup es Fase 6
    // (purge cron).
    //
    // Los 5 campos foto_* requieren SET explícito (sin COALESCE) cuando se
    // actualizan, porque COALESCE($N, foto_data) preserva foto_data si pasamos
    // NULL — exactamente lo que queremos EVITAR en el path R2.
    const fotoUpdated = ('foto_data' in req.body);
    const FOTO_FIELDS = new Set(['foto_data', 'foto_nombre', 'foto_tipo', 'foto_key', 'foto_size']);

    if (fotoUpdated) {
      const useR2 = fileStore._DRIVER === 'r2'
                 && await storageFlags.isEnabled('storage_r2_productos');
      let fotoFile;
      if (useR2) {
        fotoFile = await fileStore.put({
          tenantId: req.tenantId,  // PR 5 multi-tenant: prefix t{tenantId}/ en la key R2
          dataBase64: req.body.foto_data,
          filename: req.body.foto_nombre,
          mime: req.body.foto_tipo,
          entity: 'productos',
          subpath: `producto-${id}`,
        });
      } else {
        fotoFile = {
          data: req.body.foto_data,
          key: null,
          size: null,
          nombre: req.body.foto_nombre ?? null,
          tipo: req.body.foto_tipo ?? null,
        };
      }
      req.body.foto_data   = fotoFile.data;
      req.body.foto_nombre = fotoFile.nombre;
      req.body.foto_tipo   = fotoFile.tipo;
      req.body.foto_key    = fotoFile.key;
      req.body.foto_size   = fotoFile.size;
    }

    // SET dinámico: COALESCE para columnas no-foto (preserva valor viejo si
    // el caller no envió el campo); asignación directa para los 5 campos foto_*
    // cuando se está actualizando la foto (permite nullificar foto_data en R2,
    // o nullificar foto_key en path legacy).
    const sets = PRODUCTO_COLS.map((c, i) => {
      if (FOTO_FIELDS.has(c) && fotoUpdated) {
        return `${c} = $${i + 1}`;
      }
      return `${c} = COALESCE($${i + 1}, ${c})`;
    }).join(', ');
    const row = await db.withTenant(req.tenantId, async (client) => {
      // F3.c: derive bidireccional clase ↔ clase_id ANTES del UPDATE.
      // F3.d-3: si el cliente toca `clase_id`, validamos que exista + coherencia
      // unitario ↔ cantidad. Si no lo toca, el COALESCE preserva el valor viejo.
      if (req.body.clase_id !== undefined) {
        const { slug_legacy } = await resolveClaseInfo(client, req.tenantId, req.body);
        // Para la coherencia unitario usamos el shape mezclado — cantidad
        // puede venir en el partial o quedar del DB. Sin cantidad en el
        // partial, se asume "no cambia" y no validamos (defense: el INSERT
        // original ya validó).
        if (req.body.cantidad !== undefined) {
          validarUnitarioCoherente(slug_legacy, req.body);
        }
      }
      // values se computa DESPUÉS del derive para que el COALESCE reciba los
      // valores actualizados.
      const values = PRODUCTO_COLS.map(c => {
        if (FOTO_FIELDS.has(c) && fotoUpdated) {
          // Path foto-updated: tomamos el valor procesado (puede ser null).
          return req.body[c] ?? null;
        }
        return c in req.body ? req.body[c] : null;
      });
      // 2026-07-12 (auditoría TOTAL Stock P2-1): + `deleted_at IS NULL` en
      // el UPDATE. Cierra ventana TOCTOU entre el SELECT + FOR UPDATE (línea
      // 1189, que sí filtra deleted_at) y este UPDATE — si otro proceso
      // soft-deletea entre medio, el UPDATE lo re-vive.
      const { rows } = await client.query(
        `UPDATE productos SET ${sets} WHERE id = $${PRODUCTO_COLS.length + 1} AND deleted_at IS NULL RETURNING *`,
        [...values, id]
      );
      // F3.d-3: hidrata `clase` sintético en el response (compat).
      await agregarClaseCompat(client, rows[0]);
      await audit(client, 'productos', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
      return rows[0];
    });
    invalidateMetricas(req.tenantId);
    res.json(row);
  } catch (err) { next(err); }
});

router.delete('/productos/:id', requireCapability('inventario.eliminar'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE productos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
      );
      if (!rows[0]) return null;
      await audit(client, 'productos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Producto no encontrado' });
    invalidateMetricas(req.tenantId);
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
// Reversible: como todo en Tecny, es soft-delete (deleted_at = NOW()).
// Para recuperar, hay que correr SQL directo en DB (no hay UI de undelete).
// 2026-06-23 F5a: gate inline. Vaciar el stock disponible es la operación
// más destructiva del módulo (soft-borra todos los productos no vendidos
// del filtro). Capability propia `inventario.vaciar_stock` — owner/admin
// del tenant bypassean, todos los demás roles deberían no tenerla.
router.post('/productos/bulk-delete-disponibles', requireCapability('inventario.vaciar_stock'), bulkLimiter, async (req, res, next) => {
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
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // Validación: ¿hay envíos en curso apuntando a productos disponibles?
    // Estados 'Entregado' y 'Cancelado' son terminales — borrar el producto no
    // afecta esos envíos (la referencia queda como "producto borrado" pero el
    // envío ya cerró). 'Pendiente'/'En camino' son los que importan.
    //
    // 2026-06-15 fix: agregamos `AND e.deleted_at IS NULL`. Sin esto, envíos
    // soft-deleted con estado Pendiente/En camino seguían bloqueando el wipe
    // — `envios.estado` no se cambia al soft-deletear (solo se setea
    // deleted_at), así que un envío "fantasma" disparaba el 409 aunque ya no
    // exista para el operador. Reportado por Lucas: borró todos los envíos y
    // el botón de vaciar inventario seguía dando "hay 2 envíos en curso".
    // 2026-07-12 (auditoría TOTAL Stock P1-3): tenant_id explícito ADEMÁS del
    // SET LOCAL + RLS. Este endpoint SOFT-DELETEA masivamente productos —
    // defense-in-depth: si por algún motivo el session var no se propagara
    // (bug futuro en pooling, SET LOCAL fuera de tx), el filtro literal
    // impide un wipe cross-tenant. No cambia behavior actual — solo
    // cinturón + tiradores.
    const enUso = await client.query(
      `SELECT ei.envio_id, e.cliente, e.estado, ei.producto_id, p.nombre AS producto_nombre
         FROM envio_items ei
         JOIN envios   e ON e.id = ei.envio_id
         JOIN productos p ON p.id = ei.producto_id
        WHERE e.estado IN ('Pendiente', 'En camino')
          AND e.deleted_at IS NULL
          AND e.tenant_id = $1
          AND p.estado = 'disponible'
          AND p.deleted_at IS NULL
          AND p.tenant_id = $1
          AND ei.producto_id IS NOT NULL
        LIMIT 10`,
      [req.tenantId]
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
          AND tenant_id = $1
        RETURNING id`,
      [req.tenantId]
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
    invalidateMetricas(req.tenantId);  // vaciado masivo → cache definitivamente stale
    res.json({ borrados });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// POST /productos/bulk-delete-disponibles-con-compras (admin-only)
//
// Variante destructiva pedida por Lucas 2026-06-15. Hace lo mismo que el
// endpoint anterior PERO ADEMÁS borra las compras a proveedores cuyos
// productos quedaron 100% borrados, revirtiendo sus egresos de caja.
//
// Política de compras PARCIALES: si una compra trajo 5 productos y 2 están
// vendidos (no borrables), los 3 disponibles se vacían pero la compra
// queda intacta — el historial de las 2 ventas se preserva. Sólo se borran
// compras cuyos productos TODOS están deleted_at IS NOT NULL después del
// vaciado.
//
// Mismo modelo defensivo que el endpoint hermano:
//   - Guarda contra envíos en curso (bloquea con 409).
//   - Audit-lote (no por producto / movimiento) para no inflar audit_logs.
//   - Tx única atómica: si cualquier reverso de caja deja saldo negativo,
//     ROLLBACK total y el estado del tenant queda intacto.
router.post('/productos/bulk-delete-disponibles-con-compras', bulkLimiter, adminOnly, async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // 1. Guard contra envíos en curso (mismo check que el hermano).
    // 2026-07-12 (auditoría TOTAL Stock P1-3): tenant_id explícito además del
    // SET LOCAL + RLS. Ver comentario extenso en bulk-delete-disponibles.
    const enUso = await client.query(
      `SELECT ei.envio_id, e.cliente, e.estado, ei.producto_id, p.nombre AS producto_nombre
         FROM envio_items ei
         JOIN envios   e ON e.id = ei.envio_id
         JOIN productos p ON p.id = ei.producto_id
        WHERE e.estado IN ('Pendiente', 'En camino')
          AND e.deleted_at IS NULL
          AND e.tenant_id = $1
          AND p.estado = 'disponible'
          AND p.deleted_at IS NULL
          AND p.tenant_id = $1
          AND ei.producto_id IS NOT NULL
        LIMIT 10`,
      [req.tenantId]
    );
    if (enUso.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `No se puede vaciar: hay ${enUso.rows.length === 10 ? '10+' : enUso.rows.length} envíos en curso con productos disponibles referenciados. Resolvé esos envíos primero (marcar como Entregado o Cancelar).`,
        envios_bloqueantes: enUso.rows,
      });
    }

    // 2. Snapshot de qué compras quedan IMPACTADAS por el vaciado.
    //    Capturamos los proveedor_movimiento_id de TODOS los productos
    //    disponibles antes de borrar (puede haber compras con productos
    //    parciales que no debemos tocar).
    // 2026-07-12 (auditoría TOTAL Stock P1-3): tenant_id explícito.
    const { rows: dispProds } = await client.query(
      `SELECT id, proveedor_movimiento_id
         FROM productos
        WHERE deleted_at IS NULL AND estado = 'disponible'
          AND tenant_id = $1
        ORDER BY id FOR UPDATE`,
      [req.tenantId]
    );
    const movIdsImpactados = [
      ...new Set(dispProds.map(p => p.proveedor_movimiento_id).filter(Boolean)),
    ];

    // 3. Soft-delete los productos disponibles (paso original del endpoint hermano).
    // 2026-07-12 (auditoría TOTAL Stock P1-3): tenant_id explícito.
    const { rows: borradosRows } = await client.query(
      `UPDATE productos
          SET deleted_at = NOW()
        WHERE deleted_at IS NULL
          AND estado = 'disponible'
          AND tenant_id = $1
        RETURNING id`,
      [req.tenantId]
    );
    const borrados = borradosRows.length;

    // 4. Para cada compra impactada: ¿quedan productos VIVOS de esa compra?
    //    - Si NO (todos los del mov están deleted_at IS NOT NULL): borrar
    //      la compra + revertir caja.
    //    - Si SÍ (parcial: algunos vendidos sobreviven): NO tocar — el
    //      historial vendido bloquea el borrado de la compra.
    let comprasBorradas = 0;
    if (movIdsImpactados.length > 0) {
      // 2026-07-12 (auditoría TOTAL Stock P1-3): tenant_id explícito.
      const { rows: movsSinViventes } = await client.query(
        `SELECT m.id
           FROM proveedor_movimientos m
          WHERE m.id = ANY($1::int[]) AND m.deleted_at IS NULL
            AND m.tenant_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM productos p
               WHERE p.proveedor_movimiento_id = m.id AND p.deleted_at IS NULL
            )
          ORDER BY m.id FOR UPDATE`,
        [movIdsImpactados, req.tenantId]
      );
      if (movsSinViventes.length > 0) {
        const movsBorrablesIds = movsSinViventes.map(m => m.id);
        await client.query(
          `UPDATE proveedor_movimientos SET deleted_at = NOW()
             WHERE id = ANY($1::int[]) AND deleted_at IS NULL
               AND tenant_id = $2`,
          [movsBorrablesIds, req.tenantId]
        );
        for (const id of movsBorrablesIds) {
          await reverseCajaMovimientos(client, 'proveedor_movimientos', id);
        }
        comprasBorradas = movsBorrablesIds.length;
      }
    }

    if (borrados > 0 || comprasBorradas > 0) {
      await audit(client, 'productos', 'DELETE', 0, {
        tipo: 'bulk_delete_disponibles_con_compras',
        productos_borrados: borrados,
        compras_borradas: comprasBorradas,
        user_id: req.user.id,
      });
    }

    await client.query('COMMIT');
    invalidateMetricas(req.tenantId);
    if (comprasBorradas > 0) invalidateCajas(req.tenantId);
    res.json({ borrados, compras_borradas: comprasBorradas });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

router.post('/productos/bulk', requireCapability('inventario.crear'), bulkLimiter, validate(bulkProductoSchema), async (req, res, next) => {
  const productos = req.body.productos;

  // Revalidamos FKs ANTES de empezar a insertar: si alguna categoría/depósito no existe,
  // devolvemos 400 listando las filas inválidas en vez de que muera con un 23503 opaco
  // y un ROLLBACK que tira las 499 filas válidas. Una sola query por catálogo.
  const catIds = [...new Set(productos.map(p => p.categoria_id).filter(Boolean))];
  const depIds = [...new Set(productos.map(p => p.deposito_id).filter(Boolean))];
  const [catValid, depValid] = await db.withTenant(req.tenantId, async (client) => {
    const catValid = catIds.length
      ? await client.query('SELECT id FROM categorias WHERE id = ANY($1::int[]) AND deleted_at IS NULL', [catIds])
      : { rows: [] };
    const depValid = depIds.length
      ? await client.query('SELECT id FROM depositos  WHERE id = ANY($1::int[]) AND deleted_at IS NULL', [depIds])
      : { rows: [] };
    return [catValid, depValid];
  });
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
    const yaExisten = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT imei FROM productos
          WHERE imei = ANY($1::text[]) AND deleted_at IS NULL`,
        [imeisDelLote]
      );
      return rows;
    });
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
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const cols = PRODUCTO_COLS.filter(c => !c.startsWith('foto_'));

    // Mismo default explícito que en el POST simple: columnas NOT NULL nuevas.
    // F3.c: además, resolveClaseAndClaseId por cada producto para poblar el
    // `clase_id` desde el `slug_legacy` (o viceversa). Se hace en el bucle
    // para no tener que agrupar por clase — cada producto puede tener una
    // clase distinta y el catálogo `clases_producto` es chico (10-30 filas),
    // por lo que el SELECT es cheap. En producción, si el bulk es grande
    // y hace muchas categorías, se puede optimizar con un cache in-memory
    // por request; hoy no vale la pena.
    const buf = [];
    for (const p of productos) {
      // F3.d-3: validamos clase_id + coherencia unitario ↔ cantidad. Sin
      // derive de `clase` legacy (columna dropeada). El body ya contiene
      // clase_id — solo verificamos que exista en el catálogo del tenant.
      const { slug_legacy } = await resolveClaseInfo(client, req.tenantId, p);
      validarUnitarioCoherente(slug_legacy, p);
      buf.push({
        ...p,
        condicion: p.condicion ?? 'nuevo',
        oculto:    p.oculto    ?? false,
      });
    }

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
      tipo_carga:    'text',
      // F3.d-3: `clase` VARCHAR dropeada — solo queda clase_id UUID.
      clase_id:      'uuid',    // F3.c (2026-07-08): FK a clases_producto
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
    // 2026-06-11 S-04: audit DENTRO de la TX, antes del COMMIT. Antes corría
    // post-commit con `Promise.all` y pool global: si el proceso moría entre
    // COMMIT y el bloque de audits, los productos quedaban persistidos sin
    // trazabilidad. Ahora un único audit batch con ids + count — atómico con
    // los inserts.
    await audit(client, 'productos', 'INSERT', creados[0] || 0, {
      despues: { _bulk: true, count: creados.length, ids: creados, samples: productos.slice(0, 3) },
      user_id: req.user.id,
      req,
    });
    await client.query('COMMIT');
    invalidateMetricas(req.tenantId);  // import masivo → cache definitivamente stale
    res.status(201).json({ ok: true, creados: creados.length });
  } catch (err) {
    await client.query('ROLLBACK');
    // Auditoría 2026-06-30 IMEI race — bulk también puede chocar con el UNIQUE
    // PARCIAL si dos importaciones concurrentes overlap. Mapeo a 409 limpio.
    if (err && err.code === '23505' && err.constraint === 'idx_productos_imei_unique') {
      return res.status(409).json({
        error: 'Algún IMEI del lote ya existe en inventario (conflicto concurrente con otro import en curso).',
      });
    }
    next(err);
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────
// CATEGORÍAS (clases_producto) — CRUD por tenant — F3.a
// ─────────────────────────────────────────────────────────────────────
//
// Reemplaza el enum global de 9 slugs (`productos.clase`) por una tabla
// editable por tenant. Design doc: `docs/design/categorias-crud-tenant-f3.md`.
//
// Notas de política:
//   - La fila `es_sin_categoria=true` es de sistema — no se puede renombrar,
//     desactivar ni borrar. Es el fallback del importador XLSX.
//   - Delete con productos activos: BLOQUEA con 409 (el operador debe reasignar
//     primero). Alternativas evaluadas y descartadas: reasignar a otra clase
//     en el mismo request, orphan silencioso.
//   - Unique (tenant_id, LOWER(nombre)) case-insensitive, ignorando soft-deleted
//     — reusar un nombre borrado es válido.

// GET /clases — listar todas las clases del tenant, con count de productos
// asociados (para el guard de delete y para display).
//
// Filtro explícito `tenant_id = $1` además del RLS: defensa en profundidad.
// El RLS es la principal fuente de aislamiento en producción (rol `ipro_app`),
// pero en tests (donde el pool corre como superuser con BYPASSRLS) el filtro
// SQL es lo único que evita ver clases de otros tenants residuales del test DB.
// Mismo pattern se aplica al resto de queries del CRUD abajo.
router.get('/clases', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.nombre, c.emoji, c.orden, c.activa,
                c.es_base, c.es_sin_categoria, c.slug_legacy,
                c.created_at, c.updated_at,
                COUNT(p.id) FILTER (WHERE p.deleted_at IS NULL)::int AS count_productos
           FROM clases_producto c
           LEFT JOIN productos p ON p.clase_id = c.id AND p.tenant_id = $1
          WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
          GROUP BY c.id
          ORDER BY c.orden ASC, LOWER(c.nombre) ASC`,
        [req.tenantId]
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /clases — crear una clase nueva (custom del tenant).
router.post(
  '/clases',
  requireCapability('inventario.crear'),
  validate(createClaseProductoSchema),
  async (req, res, next) => {
    try {
      const { nombre, emoji, activa, orden } = req.body;
      const row = await db.withTenant(req.tenantId, async (client) => {
        try {
          const { rows } = await client.query(
            `INSERT INTO clases_producto (tenant_id, nombre, emoji, orden, activa)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [req.tenantId, nombre, emoji ?? null, orden ?? 0, activa]
          );
          await audit(client, 'clases_producto', 'INSERT', rows[0].id, {
            despues: rows[0], user_id: req.user.id, req,
          });
          return rows[0];
        } catch (err) {
          // Unique (tenant_id, LOWER(nombre)) → conflict amigable.
          if (err.code === '23505' && err.constraint === 'uq_clases_producto_tenant_nombre') {
            const e = new Error('Ya existe una categoría con ese nombre');
            e.status = 409;
            e.code = 'nombre_duplicado';
            throw e;
          }
          throw err;
        }
      });
      res.status(201).json(row);
    } catch (err) { next(err); }
  }
);

// PUT /clases/:id — editar (nombre, emoji, activa, orden).
// La fila `es_sin_categoria=true` NO se puede editar (400).
router.put(
  '/clases/:id',
  requireCapability('inventario.editar'),
  validate(updateClaseProductoSchema),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      // No hacemos parseId (UUID, no int). Chequeo básico defensivo.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: 'ID inválido' });
      }
      const { nombre, emoji, activa, orden } = req.body;
      const result = await db.withTenant(req.tenantId, async (client) => {
        // Guard: solo edición de filas del tenant, no borradas, no "Sin categoría".
        // tenant_id explícito además del RLS — ver comentario en GET /clases.
        const { rows: existing } = await client.query(
          `SELECT * FROM clases_producto
            WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
          [id, req.tenantId]
        );
        if (!existing[0]) return { notFound: true };
        if (existing[0].es_sin_categoria) return { protegida: true };

        try {
          // Distinguir "no mandado" (mantener valor viejo) de "explicit null"
          // (borrar emoji). El schema Zod permite emoji: null; Postgres COALESCE
          // no diferencia — usamos un sentinel string improbable.
          const emojiParam = emoji === null ? '__unset__' : (emoji ?? null);
          const { rows } = await client.query(
            `UPDATE clases_producto SET
               nombre = COALESCE($1, nombre),
               emoji  = CASE WHEN $2::text = '__unset__' THEN NULL
                             WHEN $2 IS NULL THEN emoji
                             ELSE $2 END,
               activa = COALESCE($3, activa),
               orden  = COALESCE($4, orden)
             WHERE id = $5 AND tenant_id = $6 AND deleted_at IS NULL
             RETURNING *`,
            [nombre ?? null, emojiParam, activa ?? null, orden ?? null, id, req.tenantId]
          );
          await audit(client, 'clases_producto', 'UPDATE', id, {
            antes: existing[0], despues: rows[0], user_id: req.user.id, req,
          });
          return { ok: rows[0] };
        } catch (err) {
          if (err.code === '23505' && err.constraint === 'uq_clases_producto_tenant_nombre') {
            const e = new Error('Ya existe otra categoría con ese nombre');
            e.status = 409;
            e.code = 'nombre_duplicado';
            throw e;
          }
          throw err;
        }
      });
      if (result.notFound) return res.status(404).json({ error: 'Categoría no encontrada' });
      if (result.protegida) {
        return res.status(400).json({
          error: 'La categoría "Sin categoría" es del sistema y no se puede editar.',
          code: 'categoria_protegida',
        });
      }
      res.json(result.ok);
    } catch (err) { next(err); }
  }
);

// DELETE /clases/:id — soft-delete. Bloquea con 409 si hay productos activos
// asociados; el operador debe reasignarlos primero. Bloquea con 400 si es
// la fila "Sin categoría" del sistema.
router.delete(
  '/clases/:id',
  requireCapability('inventario.eliminar'),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: 'ID inválido' });
      }
      const result = await db.withTenant(req.tenantId, async (client) => {
        // tenant_id explícito además del RLS — ver comentario en GET /clases.
        const { rows: existing } = await client.query(
          `SELECT * FROM clases_producto
            WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
          [id, req.tenantId]
        );
        if (!existing[0]) return { notFound: true };
        if (existing[0].es_sin_categoria) return { protegida: true };

        // Guard: no borrar si hay productos activos asociados.
        const { rows: countRows } = await client.query(
          `SELECT COUNT(*)::int AS n FROM productos
            WHERE clase_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
          [id, req.tenantId]
        );
        const count = countRows[0].n;
        if (count > 0) return { hasProductos: true, count };

        const { rows } = await client.query(
          `UPDATE clases_producto SET deleted_at = NOW()
            WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
            RETURNING *`,
          [id, req.tenantId]
        );
        await audit(client, 'clases_producto', 'DELETE', id, {
          antes: existing[0], user_id: req.user.id, req,
        });
        return { ok: rows[0] };
      });
      if (result.notFound) return res.status(404).json({ error: 'Categoría no encontrada' });
      if (result.protegida) {
        return res.status(400).json({
          error: 'La categoría "Sin categoría" es del sistema y no se puede borrar.',
          code: 'categoria_protegida',
        });
      }
      if (result.hasProductos) {
        return res.status(409).json({
          error: `No se puede borrar: hay ${result.count} producto${result.count === 1 ? '' : 's'} en esta categoría. Reasignalos primero.`,
          code: 'has_productos',
          count_productos: result.count,
        });
      }
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

// POST /clases/reorder — batch update del orden. Recibe array de {id, orden}.
// Transaccional (dentro de la withTenant tx). Silenciosamente skipea IDs
// que no pertenecen al tenant (RLS los filtra en el UPDATE) o ya borrados.
router.post(
  '/clases/reorder',
  requireCapability('inventario.editar'),
  validate(reorderClasesProductoSchema),
  async (req, res, next) => {
    try {
      const { items } = req.body;
      const updated = await db.withTenant(req.tenantId, async (client) => {
        let n = 0;
        for (const it of items) {
          // tenant_id explícito además del RLS — ver comentario en GET /clases.
          const { rowCount } = await client.query(
            `UPDATE clases_producto SET orden = $1
              WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL`,
            [it.orden, it.id, req.tenantId]
          );
          n += rowCount;
        }
        await audit(client, 'clases_producto', 'REORDER', null, {
          despues: { count: n, ids: items.map(i => i.id) },
          user_id: req.user.id, req,
        });
        return n;
      });
      res.json({ updated });
    } catch (err) { next(err); }
  }
);

module.exports = router;

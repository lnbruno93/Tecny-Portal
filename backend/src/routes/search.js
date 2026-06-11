// Búsqueda global cross-módulo (U-23 TANDA 6).
//
// Endpoint único `GET /api/search?q=<query>&limit=<n>` que reemplaza el
// patrón "Lucas necesita encontrar X → navegar al módulo Y → escribir el
// filtro → esperar" por un command palette tipo GitHub/Linear ⌘K que
// devuelve top N matches en clientes, productos, ventas y envíos en un solo
// round-trip.
//
// Diseño:
//   · Auth: solo `requireAuth` (montado en app.js). Los permisos por entidad
//     se chequean DENTRO del handler — si al usuario le falta `inventario`,
//     `results.productos` viene `[]` con `counts.productos = 0`, sin 403.
//     Así un operador con permiso parcial (e.g. solo `envios`) puede usar el
//     palette sin que se le rompa la búsqueda completa.
//   · 4 queries en paralelo con `Promise.all`. Cada una hace `ILIKE` + COUNT(*)
//     para que el frontend pueda mostrar "(234 más)" sin pedir paginación.
//   · `LIMIT $1` parametrizado → resistente a SQL injection. ILIKE con
//     `%${q}%` también parametrizado: el patrón con `%` se arma en JS y
//     entra como valor de bind, no se concatena al SQL. Probado con
//     `q=''; DROP TABLE`.
//   · No cache: las queries son chiquitas (LIMIT 5) y los datos cambian
//     constantemente. Un cache TTL haría que un producto recién creado no
//     aparezca por 30-60s en la búsqueda — UX inaceptable.

const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const { searchSchema } = require('../schemas/search');

// Helper: chequeo de permiso sin tocar DB. Mismo pattern que
// `hasPermission()` en requirePermission.js pero síncrono — el usuario
// puede no tener `perms` en el JWT (tokens legacy), en cuyo caso asumimos
// false. Cuando todos los tokens activos rotan post-deploy P-02 (8h), esta
// rama nunca se ejecuta. Defensive: nunca tira, devuelve true/false.
function userHasPerm(req, tool) {
  if (req.user?.role === 'admin') return true;
  return req.user?.perms?.[tool] === true;
}

// Resultado vacío reutilizable — evita allocar `{ items: [], total: 0 }` en
// cada llamada cuando el user no tiene el permiso correspondiente.
const EMPTY = { items: [], total: 0 };

// --- Búsquedas por entidad --------------------------------------------------
// Cada función recibe `pattern` (ya con los `%...%`) y `limit`, devuelve
// `{ items, total }`. NO levanta — las DB errors se propagan al handler que
// las captura en su Promise.all y delega a `next(err)`.

async function searchClientes(pattern, limit) {
  // ILIKE en `nombre || ' ' || apellido` permite matchear "juan perez" aunque
  // estén en columnas distintas. COUNT(*) corre en paralelo dentro de un
  // CTE para evitar dos round-trips.
  const sql = `
    WITH matched AS (
      SELECT id, nombre, apellido, tipo
        FROM contactos
       WHERE deleted_at IS NULL
         AND (COALESCE(nombre, '') || ' ' || COALESCE(apellido, '')) ILIKE $1
    )
    SELECT
      (SELECT COUNT(*) FROM matched)::int AS total,
      COALESCE(json_agg(t) FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS items
      FROM (
        SELECT id, nombre, apellido, tipo
          FROM matched
         ORDER BY nombre, apellido
         LIMIT $2
      ) t
  `;
  const { rows } = await db.query(sql, [pattern, limit]);
  return { items: rows[0].items, total: rows[0].total };
}

async function searchProductos(pattern, limit) {
  // Excluimos `vendido` — en operación interesa más buscar stock disponible,
  // reservado o en_tecnico. Si Lucas pide "ver también vendidos" hay que
  // sumar un flag al schema.
  const sql = `
    WITH matched AS (
      SELECT id, nombre, imei, precio_venta, precio_moneda, estado, cantidad
        FROM productos
       WHERE deleted_at IS NULL
         AND estado <> 'vendido'
         AND (nombre ILIKE $1
              OR imei ILIKE $1
              OR COALESCE(observaciones, '') ILIKE $1)
    )
    SELECT
      (SELECT COUNT(*) FROM matched)::int AS total,
      COALESCE(json_agg(t) FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS items
      FROM (
        SELECT id, nombre, imei, precio_venta, precio_moneda, estado, cantidad
          FROM matched
         ORDER BY nombre
         LIMIT $2
      ) t
  `;
  const { rows } = await db.query(sql, [pattern, limit]);
  return { items: rows[0].items, total: rows[0].total };
}

async function searchVentas(pattern, limit) {
  // EXISTS contra venta_items: queremos matchear si CUALQUIER item de la
  // venta contiene la query en `descripcion` o `imei` (e.g. "iphone 13" o
  // un IMEI específico) sin duplicar filas por JOIN. Mucho más rápido que
  // SELECT DISTINCT con JOIN.
  const sql = `
    WITH matched AS (
      SELECT v.id, v.fecha, v.cliente_nombre, v.total_usd, v.estado
        FROM ventas v
       WHERE v.deleted_at IS NULL
         AND (
              v.cliente_nombre ILIKE $1
              OR EXISTS (
                SELECT 1 FROM venta_items vi
                 WHERE vi.venta_id = v.id
                   AND (vi.descripcion ILIKE $1 OR vi.imei ILIKE $1)
              )
         )
    )
    SELECT
      (SELECT COUNT(*) FROM matched)::int AS total,
      COALESCE(json_agg(t) FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS items
      FROM (
        SELECT id, fecha, cliente_nombre, total_usd, estado
          FROM matched
         ORDER BY fecha DESC, id DESC
         LIMIT $2
      ) t
  `;
  const { rows } = await db.query(sql, [pattern, limit]);
  return { items: rows[0].items, total: rows[0].total };
}

async function searchEnvios(pattern, limit) {
  const sql = `
    WITH matched AS (
      SELECT id, fecha, cliente, direccion, estado
        FROM envios
       WHERE deleted_at IS NULL
         AND (cliente ILIKE $1
              OR direccion ILIKE $1
              OR COALESCE(telefono, '') ILIKE $1)
    )
    SELECT
      (SELECT COUNT(*) FROM matched)::int AS total,
      COALESCE(json_agg(t) FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS items
      FROM (
        SELECT id, fecha, cliente, direccion, estado
          FROM matched
         ORDER BY fecha DESC, id DESC
         LIMIT $2
      ) t
  `;
  const { rows } = await db.query(sql, [pattern, limit]);
  return { items: rows[0].items, total: rows[0].total };
}

router.get('/', validate(searchSchema, 'query'), async (req, res, next) => {
  try {
    const { q, limit } = req.query;
    // `%...%` se arma acá: backend controla el shape; el cliente solo manda
    // el texto. Esto también blinda contra usuarios "creativos" que metan
    // `%` en su query — funciona pero matchea más de la cuenta.
    const pattern = `%${q}%`;

    // Cada entidad: si el usuario no tiene permiso, devolvemos EMPTY en O(1).
    // Para clientes aceptamos `contactos` O `cuentas` (B2B) — ambos roles
    // ven la agenda de contactos en su contexto, sería raro filtrarles los
    // resultados según cuál de los dos tienen.
    const canClientes  = userHasPerm(req, 'contactos') || userHasPerm(req, 'cuentas');
    const canProductos = userHasPerm(req, 'inventario');
    const canVentas    = userHasPerm(req, 'ventas') || userHasPerm(req, 'cuentas');
    const canEnvios    = userHasPerm(req, 'envios');

    const [clientes, productos, ventas, envios] = await Promise.all([
      canClientes  ? searchClientes(pattern, limit)  : Promise.resolve(EMPTY),
      canProductos ? searchProductos(pattern, limit) : Promise.resolve(EMPTY),
      canVentas    ? searchVentas(pattern, limit)    : Promise.resolve(EMPTY),
      canEnvios    ? searchEnvios(pattern, limit)    : Promise.resolve(EMPTY),
    ]);

    res.json({
      query: q,
      results: {
        clientes:  clientes.items,
        productos: productos.items,
        ventas:    ventas.items,
        envios:    envios.items,
      },
      counts: {
        clientes:  clientes.total,
        productos: productos.total,
        ventas:    ventas.total,
        envios:    envios.total,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

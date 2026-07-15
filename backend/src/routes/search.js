// Búsqueda global — endpoint único que sirve al command palette del frontend.
//
// 2026-07-13 (feature): el operador presiona Cmd+K / Ctrl+K y escribe. Este
// endpoint devuelve resultados agrupados por categoría (productos, ventas,
// clientes, envíos, cajas, egresos) con el shape mínimo para render + navegación.
//
// Diseño:
//   · GET /api/search?q=<term>&limit=<per-category>
//   · N queries en paralelo con Promise.all (bajo `withTenant` → RLS filtra
//     por tenant en cada uno automáticamente).
//   · Cada categoría devuelve max `limit` resultados (default 5, cap 15).
//   · Response shape uniforme por categoría — el frontend renderiza sin
//     conocer el detalle de cada tipo.
//   · `q` requiere min 2 chars — evita queries triviales que barran la mitad
//     de la tabla. `q` se escapa con ILIKE + parametrización estándar.
//
// Perf:
//   · Cada query usa el índice más obvio (nombre/order_id/imei/etc). Sobre
//     tenants con 100k+ productos el ILIKE '%term%' puede ser lento sin
//     índice trigram, pero para nuestro rango actual (~decenas de miles de
//     rows por tenant) el seq scan sobre columna ya filtrada por RLS es OK.
//   · Si a futuro la escala requiere, agregar `pg_trgm` con GIN index sobre
//     productos.nombre + ventas.cliente_nombre + contactos.nombre.
//   · Fire-and-forget rate limit: hereda del limiter general del app.js.
//     Sin limiter propio — el endpoint es idempotente y read-only.
//
// Seguridad:
//   · RLS enforcea aislamiento por tenant (mismo pattern que resto del portal).
//   · `q` se escapa con parametrización estándar de pg (nada de string concat).
//   · Respuesta redactada — no expone campos sensibles (costos, saldos internos).

const router = require('express').Router();
const db = require('../config/database');
const { z } = require('zod');
const validate = require('../lib/validate');

const querySchema = z.object({
  q:     z.string().trim().min(2, 'Búsqueda: mínimo 2 caracteres').max(100),
  // Cap 15 por categoría. Con 6 categorías × 15 = 90 rows máximo por request.
  limit: z.coerce.number().int().positive().max(15).default(5),
});

// 2026-07-13: helper — el user tiene la capability? Fast path desde
// req.user.caps del JWT. Bypass roles (owner/admin del tenant) devuelven
// true incondicional — ver isBypassRole en middleware/requireCapability.js.
//
// 2026-07-14 (bug reportado por TekHaus): 2 problemas de bypass:
//   1. El rol del cap-system está en `tenant_cap_rol` (nuevo), NO
//      `tenant_rol` (viejo, mantenido para compat).
//   2. Admin GLOBAL (users.role='admin') NO tiene `tenant_cap_rol` embebido
//      en el JWT (auth.js:97 skipea el embed para admin global). El bypass
//      para admin global es via req.user.role === 'admin' — ver
//      requireCapability.js:37-40 que chequea ambos paths.
// Sin chequear los 2, TODAS las categorías gate-adas devolvían 0 rows para
// admin global (TEST_USER) y para owners con caps: undefined.
function hasCap(req, slug) {
  // Bypass 1: admin global (users.role='admin').
  if (req.user?.role === 'admin') return true;
  // Bypass 2: owner/admin del tenant (cap-system).
  const capRol = req.user?.tenant_cap_rol;
  if (capRol === 'owner' || capRol === 'admin') return true;
  // Sino, chequeo explícito de caps (objeto { slug: true } del JWT).
  return req.user?.caps?.[slug] === true;
}

router.get('/', validate(querySchema, 'query'), async (req, res, next) => {
  try {
    const { q, limit } = req.query;
    // ILIKE con wildcards. Los % los agregamos server-side para que el frontend
    // no tenga que preocuparse (y no pueda insertar wildcards raros).
    const pattern = `%${q}%`;

    // 2026-07-13: gate por capabilities antes de disparar las queries. Un
    // vendedor sin cap `egresos.ver` NO ve resultados de egresos aunque
    // matcheen. RLS ya scopea por tenant; esto suma el gate por rol/user.
    const canProductos = hasCap(req, 'inventario.ver');
    const canVentas    = hasCap(req, 'ventas.trabajar');
    const canEnvios    = hasCap(req, 'envios.trabajar');
    const canCajas     = hasCap(req, 'cajas.ver');
    const canEgresos   = hasCap(req, 'egresos.ver');
    // Contactos: sin capability específica en el mount de app.js (solo
    // requireAuth). Es "libro de direcciones" del tenant — todos los users
    // del tenant tienen acceso implícito. Siempre buscamos.
    const canContactos = true;

    const results = await db.withTenant(req.tenantId, async (client) => {
      // 6 queries en paralelo — cada una scopeada por RLS al tenant del user.
      // Si alguna falla (columna renombrada, tabla no accesible por caps),
      // Promise.allSettled degrada elegantemente: la sección aparece vacía
      // pero el resto responde. Preferimos "algunos resultados" sobre 500.
      //
      // Categorías gateadas por cap → si el user no tiene la cap, la query
      // se salta con Promise.resolve({ rows: [] }). Zero costo DB.
      const noop = Promise.resolve({ rows: [] });
      const [productos, ventas, contactos, envios, cajas, egresos] = await Promise.allSettled([
        canProductos ? client.query(
          `SELECT id, nombre, imei, color, gb, estado
             FROM productos
            WHERE deleted_at IS NULL
              AND (nombre ILIKE $1 OR imei ILIKE $1 OR color ILIKE $1)
            ORDER BY
              -- match exacto primero, luego por relevancia natural (id DESC = más nuevo)
              CASE WHEN LOWER(nombre) = LOWER($2) THEN 0
                   WHEN LOWER(nombre) LIKE LOWER($3) THEN 1
                   ELSE 2 END,
              id DESC
            LIMIT $4`,
          [pattern, q, `${q}%`, limit]
        ) : noop,
        canVentas ? client.query(
          `SELECT id, order_id, cliente_nombre, fecha, total_usd, estado
             FROM ventas
            WHERE deleted_at IS NULL
              AND (order_id ILIKE $1 OR cliente_nombre ILIKE $1)
            ORDER BY fecha DESC, id DESC
            LIMIT $2`,
          [pattern, limit]
        ) : noop,
        canContactos ? client.query(
          `SELECT id, nombre, email, telefono, tipo
             FROM contactos
            WHERE deleted_at IS NULL
              AND (nombre ILIKE $1 OR email ILIKE $1 OR telefono ILIKE $1)
            ORDER BY
              CASE WHEN LOWER(nombre) = LOWER($2) THEN 0
                   WHEN LOWER(nombre) LIKE LOWER($3) THEN 1
                   ELSE 2 END,
              id DESC
            LIMIT $4`,
          [pattern, q, `${q}%`, limit]
        ) : noop,
        canEnvios ? client.query(
          `SELECT id, cliente, direccion, fecha, estado
             FROM envios
            WHERE deleted_at IS NULL
              AND (cliente ILIKE $1 OR direccion ILIKE $1)
            ORDER BY fecha DESC, id DESC
            LIMIT $2`,
          [pattern, limit]
        ) : noop,
        canCajas ? client.query(
          `SELECT id, nombre, moneda, es_financiera, es_tarjeta
             FROM metodos_pago
            WHERE deleted_at IS NULL
              AND nombre ILIKE $1
            ORDER BY nombre
            LIMIT $2`,
          [pattern, limit]
        ) : noop,
        canEgresos ? client.query(
          `SELECT id, concepto, monto, moneda, fecha, estado
             FROM egresos
            WHERE deleted_at IS NULL
              AND concepto ILIKE $1
            ORDER BY fecha DESC, id DESC
            LIMIT $2`,
          [pattern, limit]
        ) : noop,
      ]);

      // helper: extract rows or [] si falló (Promise.allSettled)
      const rows = (r) => r.status === 'fulfilled' ? r.value.rows : [];

      return {
        productos: rows(productos).map(p => ({
          id:       p.id,
          label:    p.nombre,
          sublabel: [p.imei, p.color, p.gb].filter(Boolean).join(' · '),
          badge:    p.estado, // 'disponible' / 'vendido' / etc
          url:      `/inventario?q=${encodeURIComponent(p.nombre)}`,
        })),
        ventas: rows(ventas).map(v => ({
          id:       v.id,
          label:    v.order_id,
          sublabel: [v.cliente_nombre, v.fecha].filter(Boolean).join(' · '),
          badge:    v.estado,
          amount:   v.total_usd != null ? `u$s${Number(v.total_usd).toFixed(2)}` : null,
          // 2026-07-15 (task #134): antes devolvíamos `?q=<order_id>` que sólo
          // filtraba el dashboard. Ahora `?open=<id>` — Ventas.jsx detecta el
          // param, fetchea la venta específica y abre el modal de edición
          // directamente, sin importar el período/estado activos.
          url:      `/ventas?open=${v.id}`,
        })),
        contactos: rows(contactos).map(c => ({
          id:       c.id,
          label:    c.nombre,
          sublabel: [c.email, c.telefono].filter(Boolean).join(' · '),
          badge:    c.tipo, // 'cliente' / 'proveedor'
          url:      `/contactos?q=${encodeURIComponent(c.nombre)}`,
        })),
        envios: rows(envios).map(e => ({
          id:       e.id,
          label:    e.cliente,
          sublabel: [e.direccion, e.fecha].filter(Boolean).join(' · '),
          badge:    e.estado,
          url:      `/envios?q=${encodeURIComponent(e.cliente)}`,
        })),
        cajas: rows(cajas).map(c => ({
          id:       c.id,
          label:    c.nombre,
          sublabel: c.moneda + (c.es_financiera ? ' · Financiera' : '') + (c.es_tarjeta ? ' · Tarjeta' : ''),
          url:      `/cajas`,
        })),
        egresos: rows(egresos).map(e => ({
          id:       e.id,
          label:    e.concepto,
          sublabel: [e.fecha].filter(Boolean).join(' · '),
          badge:    e.estado,
          amount:   e.monto != null ? `${e.moneda === 'USD' || e.moneda === 'USDT' ? 'u$s' : '$'}${Number(e.monto).toFixed(2)}` : null,
          // Nota (2026-07-14): EgresosPanel.jsx no tiene search input por texto
          // (solo filtros de estado + categoría). Llevamos a la lista completa
          // — el user ya vio el egreso en el palette y puede scrollear /
          // filtrar por categoría desde ahí. Follow-up: agregar input de
          // texto a EgresosPanel para poder pre-filtrar como en Ventas/Envíos.
          url:      `/egresos`,
        })),
      };
    });

    // Total = suma de todas las categorías (útil para "N resultados" en UI).
    const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
    res.json({ q, total, results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

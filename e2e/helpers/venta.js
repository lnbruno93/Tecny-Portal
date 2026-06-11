// Helper para crear ventas retail vía API directa (sin UI).
//
// Útil cuando un spec necesita pre-condiciones de venta y no quiere
// acoplarse al flow del modal Nueva venta — que es lento, propenso a
// flakes y ya está cubierto por venta-retail.spec.js.
//
// Diseño (unificado entre edit-venta y dashboard-venta, 2026-06-11):
//   - Login API-only (mismo patrón que clienteCc.js / twofa.js) para obtener
//     un JWT del testadmin (sembrado por globalSetup).
//   - Resolución dinámica del `metodo_pago_id` por moneda + nombre. Esto
//     evita hardcodear IDs que dependen del orden del seed.
//   - El caller puede pasar `items` y `pagos` con shape mínimo y el helper
//     completa lo necesario; o llamar sin args y obtener un default útil
//     para el flow de edición (1 ítem manual + 1 pago USD efectivo de 100).
//
// Lo que NO hace:
//   - No crea cliente, vendedor, etiqueta ni canjes. Si un spec los necesita,
//     puede pasarlos en `opts.extra` o crear su propio helper especializado.
//   - No valida que los montos cuadren — eso lo hace el backend (validarTc /
//     validarCuentaCorriente). Si el test pasa montos inconsistentes, el
//     POST devolverá 4xx y rejectará la promise.
//   - No hace cleanup: globalSetup TRUNCATEa al próximo run de la suite.

const DEFAULT_API_URL = 'http://localhost:3001';
const { TEST_USER } = require('./globalSetup');

async function apiLogin({ username, password, apiUrl }) {
  const res = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `login failed (${res.status})`);
  return json;
}

async function apiCall({ token, method, path, body, apiUrl }) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function todayStr() {
  // YYYY-MM-DD, día local (no UTC) — coherente con lo que hace el frontend.
  // El backend trata fecha como DATE plana (sin TZ); usar la TZ local del
  // runner garantiza que la venta caiga en "hoy" cuando el dashboard filtra
  // por fecha local.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Devuelve un metodo_pago resolviendo por moneda + (substring del) nombre.
 * Default: USD Efectivo (el sembrado por globalSetup como 'USD | Efectivo').
 *
 * El endpoint `/api/ventas/metodos-pago` no requiere permiso `cajas` (es
 * read-only y se expone para el modal de Nueva venta). Lo preferimos sobre
 * `/api/cajas/metodos-pago`.
 */
async function findMetodoPago({ token, apiUrl, moneda = 'USD', nombreLike = 'Efectivo' } = {}) {
  const metodos = await apiCall({
    token, method: 'GET', path: '/api/ventas/metodos-pago', apiUrl,
  });
  const list = Array.isArray(metodos) ? metodos : (metodos.data || []);
  // Match por moneda + substring del nombre. Tolerante a mayúsculas/acentos del seed.
  const found = list.find(
    m => m.moneda === moneda && String(m.nombre).toLowerCase().includes(nombreLike.toLowerCase())
  );
  if (!found) {
    throw new Error(
      `metodo_pago no encontrado para moneda=${moneda} nombreLike=${nombreLike}. ` +
      `Disponibles: ${list.map(m => `${m.nombre} (${m.moneda})`).join(', ')}`
    );
  }
  return found;
}

/**
 * Crea una venta retail vía POST /api/ventas.
 *
 * Firma unificada (post-merge entre edit-venta y dashboard-venta):
 *
 * `opts.items` (opcional): array de items. Si no se pasa, default 1 item
 *    manual `Original Item E2E` cantidad=1 precio=100 costo=50 moneda=USD.
 *    Cada item: { descripcion, cantidad, precio_vendido, costo, moneda }.
 *
 * `opts.pagos` (opcional): array de pagos. Si no se pasa, default 1 pago
 *    USD efectivo 100. Cada pago puede traer `metodo_pago_id`+`metodo_nombre`
 *    explícitos, o solo `{ moneda, monto }` y el helper resuelve via
 *    findMetodoPago() (cacheado por moneda). Soporte `metodo_nombre_like`
 *    para override del default 'Efectivo'.
 *
 * `opts.fecha`: YYYY-MM-DD. Default = hoy (TZ local del runner).
 *
 * `opts.estado`: 'acreditado' | 'pendiente' | 'cancelado'. Default
 *    'acreditado' — único estado que suma a ganancia neta del dashboard
 *    (regla TANDA 0 abril 2026).
 *
 * `opts.extra`: campos adicionales para mezclar al payload (cliente_nombre,
 *    etiqueta_id, etc) sin romper la firma.
 *
 * Segundo arg opcional `{ apiUrl }` para tests fuera de localhost.
 * `opts.apiUrl` también funciona (compat con la versión vieja del helper).
 *
 * Devuelve la venta tal como sale del POST (+ `_metodoPago` con el primer
 * método resuelto, para los call sites que lo necesiten).
 */
async function createVentaViaApi(opts = {}, { apiUrl: argApiUrl } = {}) {
  // Compatibilidad: aceptamos `apiUrl` tanto en opts como en el segundo arg.
  // El segundo arg gana si está presente.
  const apiUrl = argApiUrl || opts.apiUrl || DEFAULT_API_URL;

  const { token } = await apiLogin({
    username: TEST_USER.username, password: TEST_USER.password, apiUrl,
  });

  // Resolución de pagos: el caller puede pasar pagos completos o solo
  // {moneda, monto}; cacheamos por (moneda + nombreLike) para no pegarle
  // N veces al endpoint si son misma moneda.
  const metodoCache = new Map();
  async function resolverPago(p) {
    if (p.metodo_pago_id && p.metodo_nombre) {
      return { es_cuenta_corriente: false, ...p };
    }
    const moneda = p.moneda || 'USD';
    const nombreLike = p.metodo_nombre_like || 'Efectivo';
    const key = `${moneda}|${nombreLike}`;
    let metodo = metodoCache.get(key);
    if (!metodo) {
      metodo = await findMetodoPago({ token, apiUrl, moneda, nombreLike });
      metodoCache.set(key, metodo);
    }
    return {
      metodo_pago_id: metodo.id,
      metodo_nombre: metodo.nombre,
      monto: p.monto,
      moneda,
      es_cuenta_corriente: false,
      ...(p.tc != null ? { tc: p.tc } : {}),
    };
  }

  // Defaults para el flow happy path de edición (sin args).
  const itemsInput = opts.items && opts.items.length > 0
    ? opts.items
    : [{
        descripcion: 'Original Item E2E',
        cantidad: 1,
        precio_vendido: 100,
        costo: 50,
        moneda: 'USD',
      }];

  const pagosInput = opts.pagos && opts.pagos.length > 0
    ? opts.pagos
    : [{ moneda: 'USD', monto: 100 }];

  const pagosResueltos = [];
  for (const p of pagosInput) pagosResueltos.push(await resolverPago(p));

  const body = {
    fecha: opts.fecha || todayStr(),
    estado: opts.estado || 'acreditado',
    items: itemsInput.map(i => ({
      descripcion: i.descripcion,
      cantidad: i.cantidad,
      precio_vendido: i.precio_vendido,
      costo: i.costo,
      moneda: i.moneda || 'USD',
    })),
    pagos: pagosResueltos,
    ...(opts.extra || {}),
  };

  const venta = await apiCall({
    token, method: 'POST', path: '/api/ventas', apiUrl, body,
  });

  // _metodoPago: primer método resuelto. Útil para tests que después
  // necesitan construir un pago en la UI usando la misma caja del seed.
  const _metodoPago = pagosResueltos[0]
    ? { id: pagosResueltos[0].metodo_pago_id, nombre: pagosResueltos[0].metodo_nombre }
    : null;
  return { ...venta, _metodoPago };
}

/**
 * Trae la venta hidratada (con items + pagos) usando GET /api/ventas con un
 * filtro de búsqueda. El endpoint no tiene GET /:id — pero la lista incluye
 * items y pagos de cada row. Filtramos por descripción del item para acotar
 * y encontrar la venta del test.
 *
 * Devuelve el primer row que matchea el id pedido, o null si no aparece.
 */
async function fetchVentaConItems(ventaId, { buscar, apiUrl = DEFAULT_API_URL } = {}) {
  const { token } = await apiLogin({
    username: TEST_USER.username, password: TEST_USER.password, apiUrl,
  });
  const q = buscar ? `?buscar=${encodeURIComponent(buscar)}` : '';
  const res = await apiCall({
    token, method: 'GET', path: `/api/ventas${q}`, apiUrl,
  });
  const lista = Array.isArray(res) ? res : (res.data || []);
  return lista.find(v => v.id === ventaId) || null;
}

module.exports = { createVentaViaApi, fetchVentaConItems, findMetodoPago };

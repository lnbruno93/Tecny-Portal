// Helper para crear una venta vía API directa, sin UI.
//
// Útil cuando un spec necesita pre-condiciones de venta (ej. el dashboard
// de ventas, KPIs) y no quiere acoplarse al flow del modal Nueva venta —
// que es lento, propenso a flakes y ya está cubierto por venta-retail.spec.js.
//
// Diseño:
//   - Login API-only (mismo patrón que clienteCc.js / twofa.js) para obtener
//     un JWT del testadmin (sembrado por globalSetup).
//   - Resolución dinámica del `metodo_pago_id` por moneda + nombre. Esto
//     evita hardcodear IDs que dependen del orden del seed (los seeds del
//     globalSetup empiezan con id=1 pero el orden puede mover si alguien
//     reordena el INSERT).
//   - El caller pasa `items` y `pagos` con shape limpio; el helper rellena
//     defaults (estado='acreditado' por default — ese es el único que suma
//     a ganancia neta en el dashboard, regla de TANDA 0 abril 2026).
//
// Lo que NO hace:
//   - No crea cliente, vendedor, etiqueta ni canjes. Si un spec los necesita,
//     puede pasarlos en `extra` o crear su propio helper especializado.
//   - No valida que los montos cuadren — eso lo hace el backend (validarTc /
//     validarCuentaCorriente). Si el test pasa montos inconsistentes, el
//     POST devolverá 4xx y rejectará la promise.

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
 * Crea una venta via POST /api/ventas con payload mínimo.
 *
 * `opts.items`: array de items (al menos 1). Cada item: { descripcion,
 *    cantidad, precio_vendido, costo, moneda }.
 * `opts.pagos`: array de pagos. Si el caller no pasa `metodo_pago_id` /
 *    `metodo_nombre`, el helper los resuelve via findMetodoPago() usando
 *    `pago.moneda` y el nombre por defecto ("Efectivo"). Esto permite
 *    callers minimalistas: `pagos: [{ moneda:'USD', monto:200 }]`.
 * `opts.fecha`: YYYY-MM-DD. Default = hoy (en TZ local del runner).
 * `opts.estado`: 'acreditado' | 'pendiente' | 'cancelado'. Default 'acreditado'
 *    porque la mayoría de los specs que usan este helper validan KPIs del
 *    dashboard, que sólo agrega acreditadas (ganancia neta).
 *
 * Devuelve la venta creada tal como la devuelve el backend (RETURNING *).
 */
async function createVentaViaApi({
  items,
  pagos,
  fecha,
  estado = 'acreditado',
  apiUrl = DEFAULT_API_URL,
  ...extra
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('createVentaViaApi: items es requerido y debe tener al menos 1');
  }
  if (!Array.isArray(pagos) || pagos.length === 0) {
    throw new Error('createVentaViaApi: pagos es requerido y debe tener al menos 1');
  }

  const { token } = await apiLogin({
    username: TEST_USER.username, password: TEST_USER.password, apiUrl,
  });

  // Resolver metodo_pago_id por cada pago que no lo traiga. Cacheamos por
  // moneda para no pegarle N veces al mismo endpoint si todos son misma moneda.
  const metodoCache = new Map();
  const pagosResueltos = [];
  for (const p of pagos) {
    if (p.metodo_pago_id && p.metodo_nombre) {
      pagosResueltos.push({ es_cuenta_corriente: false, ...p });
      continue;
    }
    const moneda = p.moneda || 'USD';
    const key = `${moneda}|${p.metodo_nombre_like || 'Efectivo'}`;
    let metodo = metodoCache.get(key);
    if (!metodo) {
      metodo = await findMetodoPago({
        token, apiUrl, moneda, nombreLike: p.metodo_nombre_like || 'Efectivo',
      });
      metodoCache.set(key, metodo);
    }
    pagosResueltos.push({
      metodo_pago_id: metodo.id,
      metodo_nombre:  metodo.nombre,
      monto:          p.monto,
      moneda,
      es_cuenta_corriente: false,
      ...(p.tc != null ? { tc: p.tc } : {}),
    });
  }

  // YYYY-MM-DD en TZ local — usamos `toISOString().slice(0,10)` no, eso es UTC.
  // El backend trata fecha como DATE plana (sin TZ); usar la TZ local del runner
  // garantiza que la venta caiga en "hoy" cuando el dashboard filtra por fecha local.
  const hoyLocal = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const body = {
    fecha: fecha || hoyLocal(),
    estado,
    items: items.map(i => ({
      descripcion: i.descripcion,
      cantidad: i.cantidad,
      precio_vendido: i.precio_vendido,
      costo: i.costo,
      moneda: i.moneda || 'USD',
    })),
    pagos: pagosResueltos,
    ...extra,
  };

  const venta = await apiCall({
    token, method: 'POST', path: '/api/ventas', apiUrl, body,
  });
  return venta;
}

module.exports = { createVentaViaApi, findMetodoPago };

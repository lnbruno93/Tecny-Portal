// Helper para crear ventas retail vía API.
//
// Útil cuando un spec necesita una venta pre-existente como pre-condición
// (ej.: el flow de edición). Ir por API en lugar de pasar por el modal es
// más rápido y deja el spec enfocado en el flujo bajo test.
//
// Diseño (paralelo a `e2e/helpers/clienteCc.js`):
//   - Login API-only (sin UI) para obtener el JWT del testadmin.
//   - Llamadas con fetch nativo + Authorization Bearer.
//   - Defaults útiles para el happy path (1 item manual + 1 pago USD efectivo
//     con la caja sembrada por globalSetup en metodos_pago).
//   - Devuelve la venta tal como sale del POST (id + columnas raw — items y
//     pagos no se incluyen en el response del POST; si el caller los necesita
//     re-hidratados los puede traer con GET /api/ventas?buscar=...).
//
// El helper NO hace cleanup: globalSetup TRUNCATEa al próximo run de la suite.

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
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Crea una venta retail vía POST /api/ventas. Defaults pensados para el flow
 * happy path de edición:
 *   - 1 item manual (sin producto_id, así no toca stock al editar).
 *     descripcion='Original Item E2E', cantidad=1, precio_vendido=100,
 *     costo=50, moneda='USD'.
 *   - 1 pago de 100 USD vía caja "USD | Efectivo" (sembrada por globalSetup).
 *   - estado='acreditado' para que el item retenga (no es load-bearing acá
 *     porque los manuales no descuentan stock, pero es lo realista).
 *   - fecha = hoy.
 *
 * Cualquier campo puede sobreescribirse vía `overrides`. Si el caller pasa
 * `items` o `pagos`, reemplazan los defaults (no merge).
 *
 * Devuelve el body del POST (venta row tal como la inserta el backend) +
 * el método de pago resuelto en `_metodoPago` para que el caller pueda
 * referenciarlo si necesita re-construir el pago en la UI.
 */
async function createVentaViaApi(overrides = {}, { apiUrl = DEFAULT_API_URL } = {}) {
  const { token } = await apiLogin({
    username: TEST_USER.username, password: TEST_USER.password, apiUrl,
  });

  // Resolver el metodo_pago_id de "USD | Efectivo" para armar el pago default.
  // El catálogo lo siembra globalSetup; si no aparece es un bug del setup.
  const metodos = await apiCall({
    token, method: 'GET', path: '/api/ventas/metodos-pago', apiUrl,
  });
  const usdEfectivo = (metodos || []).find(m => m.nombre === 'USD | Efectivo');
  if (!usdEfectivo) throw new Error('Caja "USD | Efectivo" no encontrada en metodos_pago');

  const defaults = {
    fecha: todayStr(),
    estado: 'acreditado',
    items: [{
      descripcion: 'Original Item E2E',
      cantidad: 1,
      precio_vendido: 100,
      costo: 50,
      moneda: 'USD',
    }],
    pagos: [{
      metodo_pago_id: usdEfectivo.id,
      metodo_nombre: usdEfectivo.nombre,
      monto: 100,
      moneda: 'USD',
      es_cuenta_corriente: false,
    }],
  };

  const payload = { ...defaults, ...overrides };
  // Si el caller pasó items o pagos custom, ya entraron via spread. No hacemos
  // merge a nivel array — ese path se documenta como "reemplaza el default".

  const venta = await apiCall({
    token, method: 'POST', path: '/api/ventas', apiUrl, body: payload,
  });
  return { ...venta, _metodoPago: usdEfectivo };
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

module.exports = { createVentaViaApi, fetchVentaConItems };

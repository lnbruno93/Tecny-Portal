// Helper para precondiciones del flow E2E "Cobranza masiva B2B".
//
// El modal CobranzaMasivaModal opera sobre clientes CC con deuda (`saldo > 0`).
// Para ejercer el flow real necesitamos:
//   1. Crear N clientes CC (mismo patrón que `createClienteCc`).
//   2. Dejarles deuda inicial sin pasar por el flujo de venta B2B (demasiado
//      pesado para una pre-condición). El backend acepta `saldo_inicial` en
//      POST /api/cuentas/clientes — internamente crea un movimientos_cc tipo
//      'saldo_inicial' con `monto_total = saldo_inicial`, que el cálculo de
//      saldo suma como deuda. Esto es exactamente lo que necesitamos para
//      arrancar el spec con clientes deudores sin tocar inventario ni cajas.
//
// Diseño (paralelo a clienteCc.js):
//   - Login API-only → JWT del testadmin (replicado, no compartido, para
//     evitar coupling cross-helper como ya se hace en twofa.js / clienteCc.js).
//   - Devuelve `[{ id, nombre, saldo }]` en el orden recibido para que el
//     spec pueda referenciarlos por índice o por nombre.

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
 * Crea N clientes CC con deuda inicial (USD) cada uno.
 *
 * Reutiliza el campo `saldo_inicial` del schema createClienteCCSchema, que
 * genera un movimientos_cc tipo 'saldo_inicial' dentro de la misma transacción
 * de creación del cliente. Esto es la forma más limpia de seedear deuda sin
 * pasar por el flujo de venta B2B completo (que exige producto, items, etc.).
 *
 * Input:
 *   clientes: [{ name: 'Cliente A E2E', deuda: 500 }]
 *
 * Devuelve:
 *   [{ id, nombre, apellido, saldo }] en el mismo orden de input.
 *
 * Nota: el endpoint /api/cuentas/clientes devuelve { ...cliente, saldo }
 * directamente (ver routes/cuentas.js:219) — usamos eso como verdad y no
 * re-fetcheamos para evitar round-trips innecesarios.
 */
async function seedClientesConDeuda(clientes, { apiUrl = DEFAULT_API_URL } = {}) {
  const { token } = await apiLogin({
    username: TEST_USER.username, password: TEST_USER.password, apiUrl,
  });

  const creados = [];
  for (const { name, deuda } of clientes) {
    const partes = name.trim().split(/\s+/);
    const nombre   = partes[0];
    const apellido = partes.slice(1).join(' ') || null;
    const cliente = await apiCall({
      token, method: 'POST', path: '/api/cuentas/clientes', apiUrl,
      body: { nombre, apellido, categoria: 'A+', saldo_inicial: Number(deuda) || 0 },
    });
    creados.push(cliente);
  }
  return creados;
}

/**
 * Lee el saldo actual de los clientes pasados por id, vía GET /api/cuentas/clientes.
 *
 * Usado por el spec en las aserciones post-cobranza para confirmar que el saldo
 * quedó actualizado. Devuelve un Map<id, saldoNumber> para lookup directo.
 */
async function getSaldosByIds(ids, { apiUrl = DEFAULT_API_URL } = {}) {
  const { token } = await apiLogin({
    username: TEST_USER.username, password: TEST_USER.password, apiUrl,
  });
  const resp = await apiCall({
    token, method: 'GET', path: '/api/cuentas/clientes?limit=200', apiUrl,
  });
  const all = resp.data || [];
  const idSet = new Set(ids.map(Number));
  const map = new Map();
  for (const c of all) {
    if (idSet.has(Number(c.id))) map.set(Number(c.id), Number(c.saldo));
  }
  return map;
}

module.exports = { seedClientesConDeuda, getSaldosByIds };

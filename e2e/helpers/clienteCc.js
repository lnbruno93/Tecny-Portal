// Helper para crear precondiciones del flow E2E B2B.
//
// Provee dos pre-condiciones que necesita el spec de B2B (alta de venta con
// planilla):
//   1. `createClienteCc(nombre, { apiUrl })` — crea un cliente CC vía API REST
//      del backend (POST /api/cuentas/clientes). El modal B2B requiere un
//      cliente seleccionado en la sidebar.
//   2. `seedProductoForB2B(opts)` — crea una categoría + un producto en
//      inventario (POST /api/inventario/categorias + POST /api/inventario/productos),
//      indispensable porque VentaB2BModal.jsx exige producto_id por línea
//      (ver `validar()` del modal: "Fila X: elegí un producto del stock").
//      El modal NO tiene opción "Ítem manual" — toda fila pasa por el picker
//      que consulta `/api/inventario/productos?vista=no_vendidos`.
//
// Diseño (paralelo a `e2e/helpers/twofa.js`):
//   - Login API-only (sin UI) para obtener JWT del testadmin.
//   - Llamadas con fetch nativo + Authorization Bearer.
//   - Sin acoplamiento al spec — el helper devuelve los IDs creados para que
//     el caller pueda referenciarlos en aserciones (saldo del cliente, etc).
//   - NO hace cleanup: globalSetup TRUNCATEa al próximo run de la suite. Los
//     specs corren con DB compartida; agregar registros adicionales no rompe
//     a otros tests porque los selectores son por nombre único ("Mayorista E2E").

const DEFAULT_API_URL = 'http://localhost:3001';
const { TEST_USER } = require('./globalSetup');

// Login API → JWT. Mismo patrón que twofa.js (no compartimos el helper porque
// está dentro de un módulo orientado a 2FA; copiarlo evita acoplamiento spurio).
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
 * Crea un cliente CC test con datos mínimos (nombre + apellido + categoría).
 *
 * El schema (createClienteCCSchema) requiere `categoria` enum VIP|A+|A-.
 * Usamos 'A+' por default; no afecta el flow B2B (la categoría es solo
 * label visual en sidebar).
 *
 * Devuelve { id, nombre, apellido, saldo } directamente del backend.
 */
async function createClienteCc(nombreCompleto, { apiUrl = DEFAULT_API_URL } = {}) {
  // Split nombre completo en (nombre, apellido). Si no hay espacio, todo va
  // a `nombre` y `apellido` queda vacío. Esto no es load-bearing — el sidebar
  // los concatena y la asserción es por substring.
  const partes = nombreCompleto.trim().split(/\s+/);
  const nombre   = partes[0];
  const apellido = partes.slice(1).join(' ') || null;

  const { token } = await apiLogin({
    username: TEST_USER.username, password: TEST_USER.password, apiUrl,
  });
  return apiCall({
    token, method: 'POST', path: '/api/cuentas/clientes', apiUrl,
    body: { nombre, apellido, categoria: 'A+' },
  });
}

/**
 * Crea una categoría + un producto en inventario para que el modal B2B pueda
 * elegirlo del autocomplete. Idempotente a nivel test-suite: cada llamada
 * crea un producto nuevo (sin verificar duplicados) — el caller decide cuántos.
 *
 * Necesario porque VentaB2BModal exige producto_id por línea (no hay "ítem
 * manual" como en VentaModal retail).
 *
 * Defaults pensados para el flow happy path:
 *   - categoria_id: crea/reusa una categoría "E2E"
 *   - estado: 'disponible' (el picker filtra por vista=no_vendidos que exige
 *     estado <> 'vendido' AND cantidad > 0 AND oculto = false).
 *   - tipo_carga: 'lote' permite cantidad > 1 (el modal B2B vende cantidades
 *     mayores a 1). Para tipo_carga='unitario' Zod exige cantidad=1.
 *
 * Devuelve { id, nombre, ... } del producto creado.
 */
async function seedProductoForB2B(
  { nombre, cantidad, costo = 0, precio = 0, apiUrl = DEFAULT_API_URL } = {}
) {
  const { token } = await apiLogin({
    username: TEST_USER.username, password: TEST_USER.password, apiUrl,
  });

  // 1) Asegurar una categoría. Como TRUNCATE corre solo al inicio de la suite,
  //    podríamos chocar con UNIQUE si dos productos comparten categoría — pero
  //    `nombreSchema` no exige unicidad de categoría, así que reusar nombre es
  //    seguro: si ya existe el backend la inserta con otro id (no es ideal,
  //    pero no rompe nada). Para mantener el helper simple, intentamos crear
  //    y si falla por unique, hacemos GET y tomamos la primera.
  let categoriaId;
  try {
    const cat = await apiCall({
      token, method: 'POST', path: '/api/inventario/categorias', apiUrl,
      body: { nombre: 'E2E' },
    });
    categoriaId = cat.id;
  } catch (e) {
    // Si ya existe (409 / 500 por unique), recuperamos la lista y agarramos la "E2E".
    const cats = await apiCall({
      token, method: 'GET', path: '/api/inventario/categorias', apiUrl,
    });
    const found = (Array.isArray(cats) ? cats : cats.data || []).find(c => c.nombre === 'E2E');
    if (!found) throw e;
    categoriaId = found.id;
  }

  // 2) Crear el producto. `tipo_carga: 'lote'` para permitir cantidad > 1
  //    (la fila 2 del spec vende 5 unidades de "Cargador E2E"). 'lote' también
  //    salta el refine `unitarioCoherente` que exige cantidad=1 en celulares
  //    unitarios.
  const producto = await apiCall({
    token, method: 'POST', path: '/api/inventario/productos', apiUrl,
    body: {
      tipo_carga: 'lote',
      clase: 'accesorio',
      nombre,
      categoria_id: categoriaId,
      costo,
      costo_moneda: 'USD',
      precio_venta: precio,
      precio_moneda: 'USD',
      cantidad,
      estado: 'disponible',
    },
  });
  return producto;
}

module.exports = { createClienteCc, seedProductoForB2B };

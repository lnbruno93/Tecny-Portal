// Base URL del backend. Source de verdad:
//   - Local dev: .env.local con `VITE_API_URL=http://localhost:3001`
//   - Netlify prod/staging/preview: env var `VITE_API_URL` por context
//   - Fallback (env var ausente): hardcoded tecny-backend-production
//
// Validación al cargar el módulo — sin esto, configs rotas degradan en
// runtime y son muy caras de debuggear:
//
// Bug 2026-06-19: Netlify "Branch deploys" tenía `VITE_API_URL` seteada
// pero SIN protocolo `https://` (valor "tecny-backend-staging.up.railway.app").
// `fetch(BASE + path)` con BASE sin protocolo lo trata como URL relativa →
// pegaba a `https://staging.tecnyapp.com/tecny-backend-staging.up.railway.app/...`
// → SPA fallback respondía index.html → JSON parse falla → UI mostraba
// "Sin conexión con el servidor" sin pista del origen real. 1h de debug.
//
// Hardening:
//   1. Si VITE_API_URL está seteada y NO arranca con http(s):// → throw al
//      cargar el módulo. Error visible en consola al instante.
//   2. Trim de trailing slash — el código asume BASE + '/api/...' sin
//      generar doble slash.
//   3. Fallback silencioso a prod-backend solo si la env var falta del todo.
//      El gate adicional en `vite.config.js` (build-time) impide builds de
//      staging/preview sin la var seteada, así nunca usamos el fallback en
//      contextos no-prod (que es lo que generó el bug de hoy).
// Resolución exportada para tests unitarios — el módulo la invoca una vez
// con `import.meta.env.VITE_API_URL` al cargar, pero también queremos cubrir
// casos edge (sin protocolo, con trailing slash, vacía) sin tener que
// recargar el módulo con stubs de import.meta.env.
export function resolveApiBase(rawUrl) {
  const trimmed = (rawUrl || '').trim();
  if (trimmed && !/^https?:\/\//.test(trimmed)) {
    throw new Error(
      `[api] VITE_API_URL inválida: "${trimmed}". ` +
      'Debe arrancar con http:// o https://. ' +
      'Revisá la env var en Netlify (Site settings → Environment variables) ' +
      'o en .env.local si estás en dev.'
    );
  }
  // Fallback hardcoded a backend prod cuando la var no está. En builds de
  // Netlify NO production (branch-deploy/preview), vite.config.js falla el
  // build si la var falta — entonces este fallback solo se usa en:
  //   - prod (donde el backend prod ES el correcto)
  //   - tests (donde nadie hace requests reales)
  //   - dev local sin .env.local (developer ve el fallback en consola)
  return (trimmed || 'https://tecny-backend-production.up.railway.app').replace(/\/+$/, '');
}

const BASE = resolveApiBase(import.meta.env.VITE_API_URL);

function getToken() {
  return localStorage.getItem('fin_token') || null;
}

export function saveToken(t) {
  localStorage.setItem('fin_token', t);
}

export function clearToken() {
  localStorage.removeItem('fin_token');
}

// Core fetch wrapper — throws on error, returns parsed JSON
export async function api(path, method = 'GET', body = null, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
  };

  const token = getToken();
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(BASE + path, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('La solicitud tardó demasiado. Verificá tu conexión e intentá de nuevo.');
    throw new Error('Sin conexión con el servidor. Verificá tu red e intentá de nuevo.');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('session-expired'));
    throw new Error('NO_AUTH');
  }
  // 2026-06-24 TANDA 2 U0: preservar el mensaje custom del backend si lo trae
  // (mismo patrón que 429 abajo). El middleware requireCapability devuelve
  // "No tenés permiso para esta acción" — uniforme pero útil. Antes pisábamos
  // TODO 403 con el genérico, lo que ocultaba info del backend y dejaba al
  // admin sin pista de qué cap falta. Adjuntamos status para que el caller
  // pueda distinguir (Inicio.jsx degrada silenciosamente los 403, otros
  // muestran toast).
  if (res.status === 403) {
    let msg = 'No tenés permiso para realizar esta acción.';
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch (_) { /* sin body parsable, mensaje genérico */ }
    const err = new Error(msg);
    err.status = 403;
    throw err;
  }
  // 429: preservar el mensaje custom del backend si lo trae (ej. OCR dice
  // "Pasaste el límite, cargá a mano"; B2B bulk dice "Demasiadas cargas
  // masivas"). Cae al genérico solo si el body no parsea como JSON o no
  // tiene `error`. Antes pisaba todos los 429 con un mensaje genérico.
  if (res.status === 429) {
    let msg = 'Demasiadas solicitudes. Esperá unos minutos e intentá de nuevo.';
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch (_) { /* sin body parsable, mensaje genérico */ }
    const err = new Error(msg);
    err.status = 429;
    throw err;
  }

  if (!res.ok) {
    let msg = 'Error del servidor';
    let body = null;
    try {
      body = await res.json();
      msg = body.error || body.message || msg;
    } catch (_) {}
    // Adjuntamos el body completo al error para que los handlers puedan
    // leer campos extras (ej. `imeis_existentes`, `productos_vendidos`,
    // `detalles` de cobranza masiva). Auditoría #B-10.
    const err = new Error(msg);
    err.responseBody = body;
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// Typed helpers — one per endpoint group
//
// Nota especial para login: usa fetch directo (no el wrapper api()) porque el
// flow de 2FA devuelve 401 con `twofa_required: true` durante un login válido.
// El api() wrapper hace clearToken+session-expired event ante CUALQUIER 401, lo
// cual rompería ese flow. Acá manejamos 401 nosotros sin disparar logout.
//
// TANDA 2.3: el primer parámetro `username` ahora puede ser username O email.
// Si contiene '@', lo enviamos al backend en el field `email`; si no, en
// `username`. El backend acepta ambos (loginSchema con refine) — ver
// backend/src/routes/auth.js. Esto cierra el loop con signup público: los
// users signupeados por TANDA 2.2 conocen su email (no el username derivado).
async function loginDirect({ username, password, code }) {
  const isEmail = typeof username === 'string' && username.includes('@');
  const body = isEmail
    ? { email: username, password }
    : { username, password };
  if (code) body.code = code;
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data; // { token, user }
  // 401 con twofa_required → caso esperado del flow, NO es error de auth.
  if (res.status === 401 && data.twofa_required) {
    return { twofa_required: true };
  }
  // Otros errores: 401 normal (password mala), 423 (lockout), 429 (rate limit), etc.
  const err = new Error(data.error || data.message || 'Usuario o contraseña incorrectos');
  err.status = res.status;
  err.responseBody = data;
  throw err;
}

export const auth = {
  login: (username, password, code) => loginDirect({ username, password, code }),
  me: () => api('/api/auth/me'),
  logout: () => api('/api/auth/logout', 'POST'),
  // 2026-06-11 SE-07: 3er arg opcional twofa_code para users con 2FA activo.
  // El flow es two-step: primer call sin code → si backend responde
  // { twofa_required: true } el UI muestra input de 2FA → segundo call con code.
  changePassword: (currentPassword, newPassword, twofaCode) => api(
    '/api/auth/change-password',
    'POST',
    twofaCode
      ? { currentPassword, newPassword, twofa_code: twofaCode }
      : { currentPassword, newPassword }
  ),
  // TANDA 2.2: signup público + email verification. Las dos primeras son
  // públicas (sin auth header — el wrapper api() las manda sin token si no
  // hay sesión, igual el backend acepta). resendVerification SÍ requiere auth
  // (se llama desde el banner cuando el user ya está logueado pero unverified).
  signup: (data) => api('/api/auth/signup', 'POST', data),
  verifyEmail: (token) => api('/api/auth/verify-email', 'POST', { token }),
  resendVerification: () => api('/api/auth/resend-verification', 'POST'),
  // TANDA 0 #321: forgot-password auto-servicio. Las 2 son públicas.
  // forgotPassword: pide reset por email. Backend responde 200 idéntica para
  // email existente vs no-existente (anti-enum) → frontend muestra siempre
  // "Si el email es válido, te mandamos un link".
  // resetPassword: consume el token del email + setea nueva pass. Errores
  // distinguen por `code` ∈ {INVALID_RESET_TOKEN, EXPIRED_RESET_TOKEN, USED_RESET_TOKEN}.
  forgotPassword: (email, hcaptchaResponse) => api(
    '/api/auth/forgot-password',
    'POST',
    hcaptchaResponse ? { email, hcaptcha_response: hcaptchaResponse } : { email }
  ),
  resetPassword: (token, newPassword) => api(
    '/api/auth/reset-password',
    'POST',
    { token, newPassword }
  ),
};

// 2FA endpoints. Todos requieren JWT válido (requireAuth) — usan el wrapper api()
// estándar que ya maneja auth headers.
export const twoFa = {
  status:             () => api('/api/auth/2fa/status'),
  setup:              () => api('/api/auth/2fa/setup', 'POST'),
  enable:             (code) => api('/api/auth/2fa/enable', 'POST', { code }),
  disable:            (code) => api('/api/auth/2fa/disable', 'POST', { code }),
  regenerateRecovery: (code) => api('/api/auth/2fa/regenerate-recovery', 'POST', { code }),
};

export const comprobantes = {
  list: (params = {}) => api('/api/comprobantes?' + new URLSearchParams(params)),
  totales: (params = {}) => api('/api/comprobantes/totales?' + new URLSearchParams(params)),
  create: (data) => api('/api/comprobantes', 'POST', data),
  delete: (id) => api(`/api/comprobantes/${id}`, 'DELETE'),
  archivo: (id) => api(`/api/comprobantes/${id}/archivo`),  // { data, nombre, tipo }
  // Réplica del modelo cobro previo de Tarjetas: comprobante manual con
  // venta_id=NULL. El backend calcula comisión + neto server-side desde
  // bruto + pct (fallback al pct_financiera de config).
  createManual: (data) => api('/api/comprobantes/manuales', 'POST', data),
  updateManual: (id, data) => api(`/api/comprobantes/manuales/${id}`, 'PATCH', data),
  // Export ZIP — NO usa el wrapper api() porque devuelve un stream binario
  // (no JSON). Devolvemos una Response cruda; el caller hace .blob() + descarga.
  // Mandamos el JWT por header como el resto del API.
  exportZip: async (params = {}) => {
    const token = localStorage.getItem('fin_token');
    const url = (import.meta.env.VITE_API_URL || 'https://tecny-backend-production.up.railway.app')
      + '/api/comprobantes/export-zip?' + new URLSearchParams(params);
    const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    if (!res.ok) {
      // Errores se sirven como JSON (no como zip). Parseamos el body para
      // exponer el mensaje del backend ("no hay comprobantes", "429", etc.).
      // Si el body NO es JSON (ej. backend del staging todavía deployando y el
      // 404 cae al Express default en HTML), damos un mensaje específico — no
      // queremos mostrar "Error 404" pelado al operador.
      let msg = null;
      try { const body = await res.json(); msg = body?.error || null; } catch { /* body no es JSON */ }
      if (!msg) {
        if (res.status === 404) msg = 'La descarga ZIP no está disponible en este servidor (deploy aún en curso). Probá de nuevo en 1-2 min.';
        else if (res.status === 401) msg = 'NO_AUTH';
        else if (res.status === 403) msg = 'No tenés permiso para descargar comprobantes.';
        else if (res.status === 429) msg = 'Demasiadas descargas masivas. Esperá unos minutos.';
        else msg = `Error del servidor (${res.status})`;
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.blob();
  },
};

export const pagos = {
  list: () => api('/api/pagos'),
  totales: () => api('/api/pagos/totales'),
  create: (data) => api('/api/pagos', 'POST', data),
  delete: (id) => api(`/api/pagos/${id}`, 'DELETE'),
};

export const vendedores = {
  list: () => api('/api/vendedores'),
  create: (data) => api('/api/vendedores', 'POST', data),
  update: (id, data) => api(`/api/vendedores/${id}`, 'PUT', data),
  delete: (id) => api(`/api/vendedores/${id}`, 'DELETE'),
};

export const cajas = {
  // Deudas (movimientos_deudas): tipo debe|pago, monto_ars, monto_usd
  deudas: (params = {}) => api('/api/cajas/deudas?' + new URLSearchParams(params)),
  createDeuda: (data) => api('/api/cajas/deudas', 'POST', data),
  deleteDeuda: (id) => api(`/api/cajas/deudas/${id}`, 'DELETE'),
  // Inversiones (movimientos_inversiones): monto (ARS), tasa (texto libre)
  inversiones: (params = {}) => api('/api/cajas/inversiones?' + new URLSearchParams(params)),
  createInversion: (data) => api('/api/cajas/inversiones', 'POST', data),
  deleteInversion: (id) => api(`/api/cajas/inversiones/${id}`, 'DELETE'),
  // Config Cajas (cuentas de dinero = metodos_pago): nombre, moneda, activo, orden, saldo_inicial
  listCajas: () => api('/api/cajas/cajas'),
  // Lista lite de métodos de pago (cajas activas) SIN saldos ni datos
  // sensibles. Accesible por cualquier usuario logueado (sin permiso
  // 'cajas'). Usar en selectores de medio de cobro en Envíos, Ventas,
  // B2B, etc. — 2026-06-10, bug Envíos donde quien no tenía permiso de
  // cajas no podía cobrar.
  listMetodosPago: () => api('/api/metodos-pago'),
  createCaja: (data) => api('/api/cajas/cajas', 'POST', data),
  updateCaja: (id, data) => api(`/api/cajas/cajas/${id}`, 'PUT', data),
  deleteCaja: (id) => api(`/api/cajas/cajas/${id}`, 'DELETE'),
  // Ledger global (todas las cajas) con filtros + totales
  ledger: (params = {}) => api('/api/cajas/movimientos?' + new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null))
  )),
  // Ledger por caja (saldo/historial + ajustes manuales) — respuesta paginada { data, pagination }
  cajaMovimientos: (id, params = {}) => api(`/api/cajas/cajas/${id}/movimientos?` + new URLSearchParams(params)),
  createCajaAjuste: (id, data) => api(`/api/cajas/cajas/${id}/movimientos`, 'POST', data),
  deleteCajaMov: (id) => api(`/api/cajas/cajas/movimientos/${id}`, 'DELETE'),
  // Resumen agregado por contacto_id
  resumen: () => api('/api/cajas/resumen'),
};

export const egresos = {
  list:        (params = {}) => api('/api/egresos?' + new URLSearchParams(params)),
  create:      (data) => api('/api/egresos', 'POST', data),
  update:      (id, data) => api(`/api/egresos/${id}`, 'PUT', data),
  delete:      (id) => api(`/api/egresos/${id}`, 'DELETE'),
  categorias:       () => api('/api/egresos/categorias'),
  createCategoria:  (data) => api('/api/egresos/categorias', 'POST', data),
  updateCategoria:  (id, data) => api(`/api/egresos/categorias/${id}`, 'PUT', data),
  deleteCategoria:  (id) => api(`/api/egresos/categorias/${id}`, 'DELETE'),
  recurrentes:      () => api('/api/egresos/recurrentes'),
  createRecurrente: (data) => api('/api/egresos/recurrentes', 'POST', data),
  updateRecurrente: (id, data) => api(`/api/egresos/recurrentes/${id}`, 'PUT', data),
  deleteRecurrente: (id) => api(`/api/egresos/recurrentes/${id}`, 'DELETE'),
  generar:          (periodo) => api('/api/egresos/generar', 'POST', { periodo }),
};

// Sanidad del Negocio (feature 2026-06-23) — dashboard de presupuesto vs real
// mensual. El backend devuelve TODO cruzado en un solo GET.
export const sanidad = {
  list:             (meses = 6) => api(`/api/sanidad?meses=${meses}`),
  upsertProyeccion: (periodo, bruto_proyectado_usd) =>
    api('/api/sanidad/proyeccion', 'PUT', { periodo, bruto_proyectado_usd }),
  deleteProyeccion: (periodo) => api(`/api/sanidad/proyeccion/${periodo}`, 'DELETE'),
  // Override del monto presupuestado de un recurrente para un mes específico.
  // El backend usa este monto SI EXISTE para ese (recurrente, periodo); si no,
  // cae al `monto` default del recurrente. Permite reflejar aumentos de
  // alquiler/salario sin reescribir la historia.
  upsertOverride: (recurrente_id, periodo, monto, moneda = 'USD', tc = null) =>
    api('/api/sanidad/override', 'PUT', { recurrente_id, periodo, monto, moneda, tc }),
  deleteOverride: (recurrente_id, periodo) =>
    api(`/api/sanidad/override/${recurrente_id}/${periodo}`, 'DELETE'),
};

export const cambios = {
  entidades:       () => api('/api/cambios/entidades'),
  // Saldo agregado en USD — consumido por 360 & Capital ({ saldo_usd }).
  saldosResumen:   () => api('/api/cambios/saldos-resumen'),
  entidad:         (id) => api(`/api/cambios/entidades/${id}`),
  createEntidad:   (data) => api('/api/cambios/entidades', 'POST', data),
  updateEntidad:   (id, data) => api(`/api/cambios/entidades/${id}`, 'PUT', data),
  deleteEntidad:   (id) => api(`/api/cambios/entidades/${id}`, 'DELETE'),
  movimientos:     (id) => api(`/api/cambios/entidades/${id}/movimientos`),
  createMovimiento: (data) => api('/api/cambios/movimientos', 'POST', data),
  deleteMovimiento: (id) => api(`/api/cambios/movimientos/${id}`, 'DELETE'),
};

export const tarjetas = {
  // Las "tarjetas" son métodos de pago marcados como tal en Cajas (solo lectura acá).
  // list/get aceptan { desde, hasta } opcionales: el backend filtra Comisión/Cobrado/
  // Movimientos del resumen por ese rango; el saldo se mantiene histórico (estado actual).
  list:              (params = {}) => api('/api/tarjetas?' + new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
  )),
  // Saldo agregado por moneda — consumido por 360 & Capital ({ saldo_ars, saldo_usd }).
  saldosResumen:     () => api('/api/tarjetas/saldos-resumen'),
  // Estado de cuenta unificado (todas las tarjetas) + por tarjeta. Aceptan
  // params { desde, hasta, limit } opcionales para filtrar por rango.
  movimientosAll:    (params = {}) => api('/api/tarjetas/movimientos?' + new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
  )),
  // Totales agregados del período (sin pagación) — KPIs separados por moneda
  // (ARS/USD/USDT) para el header del export PDF/XLSX.
  movimientosTotales:(params = {}) => api('/api/tarjetas/movimientos/totales?' + new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
  )),
  get:               (id, params = {}) => api(`/api/tarjetas/${id}?` + new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
  )),
  movimientos:       (id, params = {}) => api(`/api/tarjetas/${id}/movimientos?` + new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
  )),
  createLiquidacion: (data) => api('/api/tarjetas/liquidaciones', 'POST', data),
  // Liquidación múltiple: un depósito de la financiera repartido entre N tarjetas.
  // Body: { fecha, caja_id, repartos: [{ metodo_pago_id, monto }], comentarios? }.
  // Backend crea N movs + N ingresos a la caja en UNA tx atómica.
  createLiquidacionMultiple: (data) => api('/api/tarjetas/liquidaciones-multiples', 'POST', data),
  // Cobro previo: saldos pendientes de ventas anteriores al sistema (sin venta_id).
  // El backend calcula comisión y neto a partir de bruto + pct (o del % del método si pct omitido).
  createCobroInicial: (data) => api('/api/tarjetas/cobros-iniciales', 'POST', data),
  // Edita un movimiento. Para cobros previos: { fecha?, monto_bruto?, pct?, comentarios? }.
  // Para liquidaciones: { fecha?, monto?, caja_id?, comentarios? } (el backend revierte
  // la caja vieja y postea una nueva). Cobros de venta no se editan acá → 400.
  updateMovimiento:  (id, data) => api(`/api/tarjetas/movimientos/${id}`, 'PATCH', data),
  deleteMovimiento:  (id) => api(`/api/tarjetas/movimientos/${id}`, 'DELETE'),
};

export const envios = {
  list: (params = {}) => api('/api/envios?' + new URLSearchParams(params)),
  get: (id) => api(`/api/envios/${id}`),
  create: (data) => api('/api/envios', 'POST', data),
  // updateEstado usa la ruta PUT /:id (no existe sub-ruta /estado)
  update: (id, data) => api(`/api/envios/${id}`, 'PUT', data),
  updateEstado: (id, estado) => api(`/api/envios/${id}`, 'PUT', { estado }),
  // Confirmar entrega: marca envío como 'Entregado' y la venta asociada como 'acreditado' en una TX.
  confirmarEntrega: (id) => api(`/api/envios/${id}/confirmar-entrega`, 'POST'),
  delete: (id) => api(`/api/envios/${id}`, 'DELETE'),
};

export const cuentas = {
  clientes: (params = {}) => api('/api/cuentas/clientes?' + new URLSearchParams(params)),
  // #P-05: endpoint dedicado a autocomplete del picker, devuelve hasta 15
  // clientes filtrados por q + con_saldo. Sustituye la carga eager de 500
  // clientes al abrir el modal de cobranza masiva.
  clientesSearch: (q, conSaldo = false) => api(
    `/api/cuentas/clientes/search?q=${encodeURIComponent(q)}&con_saldo=${conSaldo}`
  ),
  cliente: (id) => api(`/api/cuentas/clientes/${id}`),
  createCliente: (data) => api('/api/cuentas/clientes', 'POST', data),
  updateCliente: (id, data) => api(`/api/cuentas/clientes/${id}`, 'PUT', data),
  deleteCliente: (id) => api(`/api/cuentas/clientes/${id}`, 'DELETE'),
  // Preview de la cascada antes de confirmar: cuántos movs se van a cancelar,
  // cuánta caja a revertir, cuántos productos a restaurar. Usado por el
  // confirm modal de CuentasCC.jsx para mostrar números concretos.
  deleteClientePreview: (id) => api(`/api/cuentas/clientes/${id}/delete-preview`),
  movimientos: (clienteId, params = {}) => api(`/api/cuentas/clientes/${clienteId}/movimientos?` + new URLSearchParams(params)),
  resumen: (clienteId) => api(`/api/cuentas/clientes/${clienteId}/resumen`),
  resumenGeneral: () => api('/api/cuentas/resumen-general'),
  calendario: (mes) => api(`/api/cuentas/calendario?mes=${mes}`),
  createMovimiento: (data) => api('/api/cuentas/movimientos', 'POST', data),
  deleteMovimiento: (id) => api(`/api/cuentas/movimientos/${id}`, 'DELETE'),
  // Devolución inline de un item de una venta B2B: marca el item con
  // devuelto_at, crea mov_cc tipo 'devolucion' asociado, restaura stock y
  // ajusta saldo. Junio 2026 — PR del feature ↺.
  devolverItem: (movId, itemId) =>
    api(`/api/cuentas/movimientos/${movId}/items/${itemId}/devolver`, 'POST'),
  // PATCH estado visual de un movimiento (2026-06-10): acreditado | pendiente.
  // Usado por el selector de la grilla unificada de Ventas para B2B.
  setEstadoMovimiento: (id, estado) =>
    api(`/api/cuentas/movimientos/${id}/estado`, 'PATCH', { estado }),
  cobranzaMasiva:   (data) => api('/api/cuentas/cobranzas-masivas', 'POST', data),
};

export const proveedores = {
  list: (params = {}) => api('/api/proveedores?' + new URLSearchParams(params)),
  get: (id) => api(`/api/proveedores/${id}`),
  create: (data) => api('/api/proveedores', 'POST', data),
  // Bulk resolve-or-create — para sembrar proveedores en el import de stock
  // (autocomplete futuro). Devuelve { creados: N } solo (no IDs porque productos
  // usa string libre, no FK).
  bulk: (nombres) => api('/api/proveedores/bulk', 'POST', { nombres }),
  update: (id, data) => api(`/api/proveedores/${id}`, 'PUT', data),
  delete: (id) => api(`/api/proveedores/${id}`, 'DELETE'),
  movimientos: (id, params = {}) => api(`/api/proveedores/${id}/movimientos?` + new URLSearchParams(params)),
  createMovimiento: (data) => api('/api/proveedores/movimientos', 'POST', data),
  // Bulk multi-proveedor — usado por el import XLSX cuando una planilla trae
  // productos de varios proveedores. Transacción atómica server-side: o se
  // crean TODOS los movimientos o ninguno. Ver backend/src/routes/proveedores.js
  // (POST /movimientos/bulk).
  createMovimientosBulk: (movimientos) => api('/api/proveedores/movimientos/bulk', 'POST', { movimientos }),
  deleteMovimiento: (id) => api(`/api/proveedores/movimientos/${id}`, 'DELETE'),
  saldos: () => api('/api/proveedores/resumen/saldos'),
  // Bulk-delete cascade — admin only. Borra TODOS los proveedores + sus
  // compras/pagos + revierte los egresos de caja. Si alguna caja queda
  // en negativo o algún producto está vendido, el endpoint rechaza con
  // 409 sin tocar nada. Devuelve { proveedores_borrados, movimientos_borrados,
  // productos_borrados }.
  bulkDeleteAll: () => api('/api/proveedores/bulk-delete-all', 'POST'),
};

export const proyectos = {
  list: (params = {}) => api('/api/proyectos?' + new URLSearchParams(params)),
  get: (id) => api(`/api/proyectos/${id}`),
  create: (data) => api('/api/proyectos', 'POST', data),
  update: (id, data) => api(`/api/proyectos/${id}`, 'PUT', data),
  delete: (id) => api(`/api/proyectos/${id}`, 'DELETE'),
  movimientos: (id, params = {}) => api(`/api/proyectos/${id}/movimientos?` + new URLSearchParams(params)),
  createMovimiento: (data) => api('/api/proyectos/movimientos', 'POST', data),
  deleteMovimiento: (id) => api(`/api/proyectos/movimientos/${id}`, 'DELETE'),
};

export const contactos = {
  list: (params = {}) => api('/api/contactos?' + new URLSearchParams(params)),
  create: (data) => api('/api/contactos', 'POST', data),
  update: (id, data) => api(`/api/contactos/${id}`, 'PUT', data),
  delete: (id) => api(`/api/contactos/${id}`, 'DELETE'),
};

export const usados = {
  list: () => api('/api/usados'),
  create: (data) => api('/api/usados', 'POST', data),
  delete: (id) => api(`/api/usados/${id}`, 'DELETE'),
  bulkUpdate: (items) => api('/api/usados/bulk', 'PUT', { updates: items }),
};

export const inventario = {
  productos:       (params = {}) => api('/api/inventario/productos?' + new URLSearchParams(params)),
  metricas:        () => api('/api/inventario/productos/metricas'),
  proveedoresList: () => api('/api/inventario/productos/proveedores'),
  desglose:        (params = {}) => api('/api/inventario/desglose?' + new URLSearchParams(params)),
  foto:            (id) => api(`/api/inventario/productos/${id}/foto`),
  // Fase 2 trazabilidad (2026-06-15): historial de compra+venta de un producto.
  // Usado por el modal Detalle/Historial que abre con click en una fila.
  historial:       (id) => api(`/api/inventario/productos/${id}/historial`),
  createProducto:  (data) => api('/api/inventario/productos', 'POST', data),
  updateProducto:  (id, data) => api(`/api/inventario/productos/${id}`, 'PUT', data),
  deleteProducto:  (id) => api(`/api/inventario/productos/${id}`, 'DELETE'),
  bulkProductos:   (productos) => api('/api/inventario/productos/bulk', 'POST', { productos }),
  // Bulk soft-delete de productos en estado 'disponible'. Mantiene vendidos,
  // en_tecnico y reservados. Devuelve { borrados: N }.
  bulkDeleteDisponibles: () => api('/api/inventario/productos/bulk-delete-disponibles', 'POST'),
  // Variante destructiva (admin only): además del bulk-delete, borra las
  // compras a proveedores cuyos productos quedaron 100% borrados y revierte
  // sus egresos de caja. Compras con algún producto vendido (parciales) NO
  // se tocan. Devuelve { borrados, compras_borradas }.
  bulkDeleteDisponiblesConCompras: () => api('/api/inventario/productos/bulk-delete-disponibles-con-compras', 'POST'),
  categorias:      () => api('/api/inventario/categorias'),
  createCategoria: (data) => api('/api/inventario/categorias', 'POST', data),
  // Bulk resolve-or-create — devuelve { map: { lowercase_nombre: id } } para
  // todas las categorías pedidas (recién creadas + ya existentes). Usado por
  // el import de stock para no hacer N round-trips secuenciales.
  bulkCategorias:  (nombres) => api('/api/inventario/categorias/bulk', 'POST', { nombres }),
  deleteCategoria: (id) => api(`/api/inventario/categorias/${id}`, 'DELETE'),
  depositos:       () => api('/api/inventario/depositos'),
  createDeposito:  (data) => api('/api/inventario/depositos', 'POST', data),
  deleteDeposito:  (id) => api(`/api/inventario/depositos/${id}`, 'DELETE'),
};

export const ventas = {
  list:            (params = {}) => api('/api/ventas?' + new URLSearchParams(params)),
  create:          (data) => api('/api/ventas', 'POST', data),
  update:          (id, data) => api(`/api/ventas/${id}`, 'PUT', data),
  delete:          (id) => api(`/api/ventas/${id}`, 'DELETE'),
  dashboard:       (params = {}) => api('/api/ventas/dashboard?' + new URLSearchParams(params)),
  etiquetas:       () => api('/api/ventas/etiquetas'),
  createEtiqueta:  (data) => api('/api/ventas/etiquetas', 'POST', data),
  deleteEtiqueta:  (id) => api(`/api/ventas/etiquetas/${id}`, 'DELETE'),
  metodosPago:     () => api('/api/ventas/metodos-pago'),
  rapidas:         (params = {}) => api('/api/ventas/ventas-rapidas?' + new URLSearchParams(params)),
  createRapida:    (data) => api('/api/ventas/ventas-rapidas', 'POST', data),
  updateRapida:    (id, data) => api(`/api/ventas/ventas-rapidas/${id}`, 'PUT', data),
  deleteRapida:    (id) => api(`/api/ventas/ventas-rapidas/${id}`, 'DELETE'),
  garantias:       () => api('/api/ventas/garantias'),
  createGarantia:  (data) => api('/api/ventas/garantias', 'POST', data),
  updateGarantia:  (id, data) => api(`/api/ventas/garantias/${id}`, 'PUT', data),
  deleteGarantia:  (id) => api(`/api/ventas/garantias/${id}`, 'DELETE'),
  comprobantes:    (id) => api(`/api/ventas/${id}/comprobantes`),
  getComprobante:  (cid) => api(`/api/ventas/comprobantes/${cid}`),
  uploadComprobante: (id, data) => api(`/api/ventas/${id}/comprobantes`, 'POST', data),
};

export const usuarios = {
  list: () => api('/api/usuarios'),
  create: (data) => api('/api/usuarios', 'POST', data),
  update: (id, data) => api(`/api/usuarios/${id}`, 'PUT', data),
  delete: (id) => api(`/api/usuarios/${id}`, 'DELETE'),
};

// 2026-06-23 Permisos F2: endpoints del sistema capability-based.
// Catalog = 46 capabilities agrupadas en 20 pantallas (lectura libre).
// (2026-06-27 #454: +1 capability + 1 pantalla por Red B2B 'cross_tenant.write')
// Users = lista enriquecida con rol + overrides + caps efectivas.
// Update = PUT con `rol` y/o `overrides` (reemplazo total de overrides).
//
// Conviven con `usuarios` (legacy CRUD) durante F1–F3. F4 reemplaza el
// modelo de permisos viejo. Acá usamos `capabilities.users` solo para
// VER y EDITAR roles/overrides; create/delete/password siguen vía
// `usuarios.*`.
export const capabilities = {
  catalog: () => api('/api/capabilities/catalog'),
  users:   () => api('/api/capabilities/users'),
  update:  (id, { rol, overrides } = {}) => {
    const body = {};
    if (rol !== undefined) body.rol = rol;
    if (overrides !== undefined) body.overrides = overrides;
    return api(`/api/capabilities/users/${id}`, 'PUT', body);
  },
};

export const config = {
  get: () => api('/api/config'),
  update: (data) => api('/api/config', 'PUT', data),
  // #443: límites informativos del sistema. Devuelve { limits: [{t, d}] }.
  // Antes vivía hardcoded en Config.jsx desincronizado de la realidad.
  systemLimits: () => api('/api/config/system-limits'),
  // #445: último TC usado por el tenant (de venta más reciente en 90d).
  // Devuelve { tc, source: 'venta'|'fallback', computed_at }. Antes el
  // Cotizador tenía un default de 1400 hardcoded que se desactualizaba mes
  // a mes. Si no hay venta con TC reciente, devuelve fallback=1400 igual
  // para mantener el behavior viejo en tenants sin data.
  lastTc: () => api('/api/config/last-tc'),
};

// Endpoints admin (rol=admin requerido server-side). Pantalla Config →
// tab Mantenimiento. El UI los oculta si user.role !== 'admin', pero el
// backend rechaza de todos modos con 403.
export const admin = {
  // Backfill caja Financiera: dry-run + apply. Wrapper de los scripts
  // de TANDA 2. Ver scripts/backfill-caja-financiera.js.
  backfillFinancieraReport: () => api('/api/admin/backfill-caja-financiera'),
  backfillFinancieraApply:  () => api('/api/admin/backfill-caja-financiera/apply', 'POST'),
  // Backfill cajas-tarjeta (paralelo al de Financiera). Reconstruye
  // trazabilidad para cobros y liquidaciones histor­icos pre-TANDA 1 Tarjetas.
  backfillTarjetasReport: () => api('/api/admin/backfill-caja-tarjetas'),
  backfillTarjetasApply:  () => api('/api/admin/backfill-caja-tarjetas/apply', 'POST'),
  // Diagnóstico de stock: dado un IMEI o producto_id, devuelve el árbol completo
  // de productos (vivos + soft-deleted) + items_movimiento_cc que los referencian
  // (incluso movs borrados). Útil para auditar por qué un producto quedó en
  // estado='vendido' tras borrar la venta que lo descontó. PR #136.
  diagnoseProducto: (q) => api('/api/admin/diagnose-producto?' + new URLSearchParams(q)),
  // Restaurar producto vendido a estado='disponible' + cantidad indicada.
  // Audit log obligatorio (reason mínimo 5 chars). Solo para productos vivos.
  restoreProducto: (body) => api('/api/admin/restore-producto', 'POST', body),
  // Cleanup de movimientos B2B huérfanos (cliente borrado, mov vivo). Existe
  // para limpiar el estado sucio pre-fix de DELETE /clientes/:id (que hoy ya
  // cascadea). PR #137.
  orphanMovsReport: () => api('/api/admin/orphan-movs'),
  orphanMovsApply:  () => api('/api/admin/orphan-movs/apply', 'POST'),
};

export const historial = {
  list: (params = {}) => api('/api/historial?' + new URLSearchParams(params)),
};

export const ocr = {
  // El backend espera { imageData, mediaType } y devuelve { monto }
  extract: (imageData, mediaType) => api('/api/ocr', 'POST', { imageData, mediaType }),
};

export const dashboard = {
  // Resumen mensual con comparativo. params: { periodo, comparar_con } (YYYY-MM).
  // Devuelve { actual, comparado, generado_en } — el delta % lo calcula el front.
  resumenMensual: (params = {}) => api('/api/dashboard/resumen-mensual?' + new URLSearchParams(params)),
};

export const conciliacion = {
  list:   (params = {}) => api('/api/conciliacion?' + new URLSearchParams(params)),
  get:    (id)          => api(`/api/conciliacion/${id}`),
  // data: { caja_id, fecha_desde, fecha_hasta, archivo_nombre?, tolerancia_dias?, lineas }
  create: (data)        => api('/api/conciliacion', 'POST', data),
  updateLinea: (id, lineaId, data) => api(`/api/conciliacion/${id}/lineas/${lineaId}`, 'PUT', data),
  cerrar: (id)          => api(`/api/conciliacion/${id}/cerrar`, 'POST'),
  delete: (id)          => api(`/api/conciliacion/${id}`, 'DELETE'),
};

export const alertas = {
  // Devuelve { grupos: [{tipo, titulo, severidad, items, count}], total_alertas, generado_en }
  list:        () => api('/api/alertas'),
  config:      () => api('/api/alertas/config'),
  // data: { activa?, parametros? }
  updateConfig: (tipo, data) => api(`/api/alertas/config/${tipo}`, 'PUT', data),
};

// Feature flags (M-08 GRAN auditoría 2026-06-10).
//   · list() lo consume el FeatureFlagsContext al mount → map { name: bool }.
//   · adminList/Create/Update/Delete requieren role='admin' (server-side
//     enforced — el UI todavía no existe; la API queda lista para cuando se
//     necesite el panel admin).
export const featureFlags = {
  list:         () => api('/api/feature-flags'),
  adminList:    () => api('/api/feature-flags/admin'),
  adminCreate:  (data) => api('/api/feature-flags', 'POST', data),
  adminUpdate:  (name, data) => api(`/api/feature-flags/${name}`, 'PATCH', data),
  adminDelete:  (name) => api(`/api/feature-flags/${name}`, 'DELETE'),
};

// 2026-06-18 #323 TANDA 1 H3: onboarding status para Inicio.jsx.
// Devuelve { has_productos, has_contactos, has_ventas }. OnboardingCard
// lo lee al mount, decide qué items mostrar tachados / pendientes.
export const onboarding = {
  status: () => api('/api/onboarding/status'),
};

// 2026-06-20 #340: Bot conversacional analítico (Asistente Tecny).
//   · createConversation: arranca una sesión nueva (titulo se asigna del
//     primer mensaje del user automáticamente).
//   · list/get: para reabrir conversaciones pasadas desde el widget.
//   · sendMessage: post sincronico al bot. timeoutMs alto (60s) porque las
//     tools + tool loop pueden tardar varios segundos en converger.
//   · delete: borra conversación + cascada a mensajes.
//
// El response de sendMessage trae:
//   { text, content, model, tokens: { input, output, cached }, tool_calls }
// El widget muestra `text`; los demás campos son para debugging / cost
// dashboard futuro.
// Perfil del tenant (2026-06-22 multi-tenant fix Cotizador).
//   · get: lo lee el Cotizador para renderear la frase de Google solo si
//     el tenant la tiene habilitada. También lo lee Config para mostrar
//     el form de edición.
//   · update: PUT que requiere adminOnly del tenant (backend lo verifica).
export const tenantProfile = {
  get:    () => api('/api/tenant-profile'),
  update: (data) => api('/api/tenant-profile', 'PUT', data),
};

export const chat = {
  listConversations:  (limit = 30) => api('/api/chat/conversations?' + new URLSearchParams({ limit })),
  createConversation: () => api('/api/chat/conversations', 'POST', {}),
  getConversation:    (id) => api(`/api/chat/conversations/${id}`),
  sendMessage:        (id, text) => api(`/api/chat/conversations/${id}/messages`, 'POST', { text }, 60000),
  deleteConversation: (id) => api(`/api/chat/conversations/${id}`, 'DELETE'),
};

// 2026-06-27 #454 Red B2B F1: partnerships lifecycle.
// Todos los endpoints requieren capability `cross_tenant.write` server-side.
// El frontend esconde el sidebar item si el user no la tiene — pero igual el
// backend chequea, así que cualquier llamada hardcoded sin cap rebota 403.
export const redB2b = {
  partnerships: {
    list:    (status) => {
      const qs = status ? '?' + new URLSearchParams({ status }) : '';
      return api(`/api/red-b2b/partnerships${qs}`);
    },
    get:     (id) => api(`/api/red-b2b/partnerships/${id}`),
    invite:  (target_tenant_slug, message) =>
      api('/api/red-b2b/partnerships/invite', 'POST',
        message ? { target_tenant_slug, message } : { target_tenant_slug }),
    accept:  (id) => api(`/api/red-b2b/partnerships/${id}/accept`, 'POST'),
    reject:  (id, reason) =>
      api(`/api/red-b2b/partnerships/${id}/reject`, 'POST',
        reason ? { reason } : {}),
    revoke:  (id, reason) =>
      api(`/api/red-b2b/partnerships/${id}/revoke`, 'POST',
        reason ? { reason } : {}),
  },
};

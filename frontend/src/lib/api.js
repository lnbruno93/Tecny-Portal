// Base URL: local dev → localhost:3001, production → Railway
const BASE = import.meta.env.VITE_API_URL || 'https://ipro-backend-production.up.railway.app';

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
  if (res.status === 403) throw new Error('No tenés permiso para realizar esta acción.');
  if (res.status === 429) throw new Error('Demasiadas solicitudes. Esperá unos minutos e intentá de nuevo.');

  if (!res.ok) {
    let msg = 'Error del servidor';
    try { const d = await res.json(); msg = d.error || d.message || msg; } catch (_) {}
    throw new Error(msg);
  }

  return res.json();
}

// Typed helpers — one per endpoint group
export const auth = {
  login: (username, password) => api('/api/auth/login', 'POST', { username, password }),
  me: () => api('/api/auth/me'),
  logout: () => api('/api/auth/logout', 'POST'),
  changePassword: (currentPassword, newPassword) => api('/api/auth/change-password', 'POST', { currentPassword, newPassword }),
};

export const comprobantes = {
  list: (params = {}) => api('/api/comprobantes?' + new URLSearchParams(params)),
  totales: (params = {}) => api('/api/comprobantes/totales?' + new URLSearchParams(params)),
  create: (data) => api('/api/comprobantes', 'POST', data),
  delete: (id) => api(`/api/comprobantes/${id}`, 'DELETE'),
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
  // Resumen agregado por contacto_id
  resumen: () => api('/api/cajas/resumen'),
};

export const envios = {
  list: (params = {}) => api('/api/envios?' + new URLSearchParams(params)),
  get: (id) => api(`/api/envios/${id}`),
  create: (data) => api('/api/envios', 'POST', data),
  // updateEstado usa la ruta PUT /:id (no existe sub-ruta /estado)
  update: (id, data) => api(`/api/envios/${id}`, 'PUT', data),
  updateEstado: (id, estado) => api(`/api/envios/${id}`, 'PUT', { estado }),
  delete: (id) => api(`/api/envios/${id}`, 'DELETE'),
};

export const cuentas = {
  clientes: (params = {}) => api('/api/cuentas/clientes?' + new URLSearchParams(params)),
  cliente: (id) => api(`/api/cuentas/clientes/${id}`),
  createCliente: (data) => api('/api/cuentas/clientes', 'POST', data),
  updateCliente: (id, data) => api(`/api/cuentas/clientes/${id}`, 'PUT', data),
  deleteCliente: (id) => api(`/api/cuentas/clientes/${id}`, 'DELETE'),
  movimientos: (clienteId) => api(`/api/cuentas/clientes/${clienteId}/movimientos`),
  resumen: (clienteId) => api(`/api/cuentas/clientes/${clienteId}/resumen`),
  resumenGeneral: () => api('/api/cuentas/resumen-general'),
  calendario: (mes) => api(`/api/cuentas/calendario?mes=${mes}`),
  createMovimiento: (data) => api('/api/cuentas/movimientos', 'POST', data),
  deleteMovimiento: (id) => api(`/api/cuentas/movimientos/${id}`, 'DELETE'),
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

export const usuarios = {
  list: () => api('/api/usuarios'),
  create: (data) => api('/api/usuarios', 'POST', data),
  update: (id, data) => api(`/api/usuarios/${id}`, 'PUT', data),
  delete: (id) => api(`/api/usuarios/${id}`, 'DELETE'),
};

export const config = {
  get: () => api('/api/config'),
  update: (data) => api('/api/config', 'PUT', data),
};

export const historial = {
  list: (params = {}) => api('/api/historial?' + new URLSearchParams(params)),
};

export const ocr = {
  extract: (imageBase64) => api('/api/ocr', 'POST', { image: imageBase64 }),
};

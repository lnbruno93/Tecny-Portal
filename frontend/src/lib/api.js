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
  archivo: (id) => api(`/api/comprobantes/${id}/archivo`),  // { data, nombre, tipo }
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

export const cambios = {
  entidades:       () => api('/api/cambios/entidades'),
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
  list:              () => api('/api/tarjetas'),
  movimientosAll:    () => api('/api/tarjetas/movimientos'),
  get:               (id) => api(`/api/tarjetas/${id}`),
  movimientos:       (id) => api(`/api/tarjetas/${id}/movimientos`),
  createLiquidacion: (data) => api('/api/tarjetas/liquidaciones', 'POST', data),
  deleteMovimiento:  (id) => api(`/api/tarjetas/movimientos/${id}`, 'DELETE'),
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
  movimientos: (clienteId, params = {}) => api(`/api/cuentas/clientes/${clienteId}/movimientos?` + new URLSearchParams(params)),
  resumen: (clienteId) => api(`/api/cuentas/clientes/${clienteId}/resumen`),
  resumenGeneral: () => api('/api/cuentas/resumen-general'),
  calendario: (mes) => api(`/api/cuentas/calendario?mes=${mes}`),
  createMovimiento: (data) => api('/api/cuentas/movimientos', 'POST', data),
  deleteMovimiento: (id) => api(`/api/cuentas/movimientos/${id}`, 'DELETE'),
  cobranzaMasiva:   (data) => api('/api/cuentas/cobranzas-masivas', 'POST', data),
};

export const proveedores = {
  list: (params = {}) => api('/api/proveedores?' + new URLSearchParams(params)),
  get: (id) => api(`/api/proveedores/${id}`),
  create: (data) => api('/api/proveedores', 'POST', data),
  update: (id, data) => api(`/api/proveedores/${id}`, 'PUT', data),
  delete: (id) => api(`/api/proveedores/${id}`, 'DELETE'),
  movimientos: (id, params = {}) => api(`/api/proveedores/${id}/movimientos?` + new URLSearchParams(params)),
  createMovimiento: (data) => api('/api/proveedores/movimientos', 'POST', data),
  deleteMovimiento: (id) => api(`/api/proveedores/movimientos/${id}`, 'DELETE'),
  saldos: () => api('/api/proveedores/resumen/saldos'),
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
  createProducto:  (data) => api('/api/inventario/productos', 'POST', data),
  updateProducto:  (id, data) => api(`/api/inventario/productos/${id}`, 'PUT', data),
  deleteProducto:  (id) => api(`/api/inventario/productos/${id}`, 'DELETE'),
  bulkProductos:   (productos) => api('/api/inventario/productos/bulk', 'POST', { productos }),
  categorias:      () => api('/api/inventario/categorias'),
  createCategoria: (data) => api('/api/inventario/categorias', 'POST', data),
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

export const config = {
  get: () => api('/api/config'),
  update: (data) => api('/api/config', 'PUT', data),
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

// Wrapper de fetch para el admin console. Réplica simplificada del patrón
// usado en frontend/src/lib/api.js — los endpoints son distintos (super-admin)
// pero las invariantes de seguridad/UX son las mismas:
//
//   1. VITE_API_URL es la single source of truth del backend. Si está seteada
//      sin http(s):// → throw al cargar el módulo (mismo bug que el portal:
//      sin protocolo, fetch lo trata como path relativo → falla muda).
//   2. Token JWT en localStorage bajo key `admin_token` — separada del
//      `fin_token` del portal a propósito, así un user puede tener sesión
//      en ambos sin pisarse. Cada app es su propia auth boundary.
//   3. 401 → clear token + dispatch evento 'admin-session-expired' + reject.
//      El AuthContext lo escucha y muta `user` a null → ProtectedRoute hace
//      redirect a /login.
//   4. 403 → reject con error.status=403; el componente decide qué mostrar
//      (típicamente "Acceso denegado" + logout).

export function resolveApiBase(rawUrl) {
  const trimmed = (rawUrl || '').trim();
  if (trimmed && !/^https?:\/\//.test(trimmed)) {
    throw new Error(
      `[admin api] VITE_API_URL inválida: "${trimmed}". ` +
      'Debe arrancar con http:// o https://. ' +
      'Revisá la env var en Netlify (Site settings → Environment variables) ' +
      'o en .env.local si estás en dev.'
    );
  }
  // Fallback al backend prod. Mismo razonamiento que el portal: si la var
  // falta en builds non-prod, idealmente vite.config.js debería fallar el
  // build — TODO cuando se configure Netlify para el admin site. Mientras
  // tanto, este fallback al menos no rompe builds locales.
  return (trimmed || 'https://tecny-backend-production.up.railway.app').replace(/\/+$/, '');
}

const BASE = resolveApiBase(import.meta.env.VITE_API_URL);

const TOKEN_KEY = 'admin_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || null;
}

export function saveToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// Core wrapper — devuelve JSON, throw en error con mensaje legible.
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
    if (e.name === 'AbortError') throw new Error('La solicitud tardó demasiado. Verificá tu conexión.');
    throw new Error('Sin conexión con el servidor. Verificá tu red.');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    clearToken();
    // Evento custom diferenciado del portal — un mismo browser podría tener
    // ambas apps abiertas y no queremos disparar logout cruzado.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('admin-session-expired'));
    }
    const err = new Error('NO_AUTH');
    err.status = 401;
    throw err;
  }

  if (!res.ok) {
    let msg = 'Error del servidor';
    let parsed = null;
    try {
      parsed = await res.json();
      msg = parsed?.error || parsed?.message || msg;
    } catch (_) { /* body no es JSON, mensaje genérico */ }
    const err = new Error(msg);
    err.status = res.status;
    err.responseBody = parsed;
    throw err;
  }

  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

// Login directo — no usa el wrapper api() porque el wrapper clearea el token
// ante CUALQUIER 401, y el endpoint de login devuelve 401 ante credenciales
// malas (caso esperado durante el flow normal).
async function loginDirect(username, password) {
  const isEmail = typeof username === 'string' && username.includes('@');
  const body = isEmail ? { email: username, password } : { username, password };
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data; // { token, user }
  const err = new Error(data?.error || data?.message || 'Usuario o contraseña incorrectos');
  err.status = res.status;
  err.responseBody = data;
  throw err;
}

// Helper interno: filtra keys vacías/null antes de armar el query string.
// URLSearchParams las incluiría como `key=` (string vacío) y el backend
// distingue eso de "no enviado" en filtros tipo suspended=true|false.
function buildQs(params) {
  const clean = Object.fromEntries(
    Object.entries(params || {}).filter(([, v]) => v !== '' && v != null)
  );
  const qs = new URLSearchParams(clean).toString();
  return qs ? '?' + qs : '';
}

export const adminApi = {
  // ── Auth ──────────────────────────────────────────────────────────────
  login: (username, password) => loginDirect(username, password),
  // GET /me — devuelve { is_super_admin, user_id, username }. Usado por
  // AuthContext al mount para revalidar que el flag is_super_admin sigue
  // activo (podría haberse revocado vía script desde el último login).
  me: () => api('/api/super-admin/me'),

  // ── Tenants (read) ────────────────────────────────────────────────────
  // GET /tenants?plan=&suspended=&search= — lista con stats inline.
  // Filtros opcionales: `plan` (trial|starter|pro|enterprise),
  // `suspended` ('true'|'false'), `search` (match nombre OR slug ILIKE).
  // Cada row: { id, nombre, slug, plan, custom_mrr_usd, suspended_at,
  // suspended_reason, trial_until, created_at, notes, users_count,
  // last_venta_at, signups_30d, mrr_usd }.
  listTenants: (filters = {}) =>
    api('/api/super-admin/tenants' + buildQs(filters)),

  // GET /tenants/:id — detalle del tenant + recent_admin_actions (últimas
  // 10 acciones admin sobre este tenant). Devuelve 404 si id no existe.
  getTenant: (id) => api(`/api/super-admin/tenants/${id}`),

  // GET /tenants/:id/activity?type=&limit= — drill-down de actividad.
  // type: 'ventas'|'cajas'|'bot'|'alertas'|'audit' (default 'ventas').
  // Cada type tiene shape distinto — el frontend lo renderiza por tab.
  // limit: 1-100, default 20.
  getActivity: (id, type = 'ventas', limit = 20) =>
    api(`/api/super-admin/tenants/${id}/activity?type=${encodeURIComponent(type)}&limit=${limit}`),

  // ── Metrics ───────────────────────────────────────────────────────────
  // GET /metrics — KPIs SaaS agregados (MRR total, # activos/trial/
  // suspended, signups 7d/30d, churn 30d, conversion trial→paid 30d,
  // plan_prices_usd, tenants_by_plan).
  getMetrics: () => api('/api/super-admin/metrics'),

  // GET /metrics/history — serie temporal últimos 90 días con
  // { history: [{date, signups, suspensions}] }. Por ahora solo signups
  // y suspensions; MRR histórico se agrega cuando exista la métrica.
  getMetricsHistory: () => api('/api/super-admin/metrics/history'),

  // GET /metrics/recent-actions?limit= — feed cross-tenant de acciones
  // admin (joined con tenant.nombre + super_admin.username). Cap 50,
  // default 10. El Resumen lo usa como "activity feed".
  getRecentActions: (limit = 10) =>
    api(`/api/super-admin/metrics/recent-actions?limit=${limit}`),

  // ── Tenants (mutations) ───────────────────────────────────────────────
  // Todos los mutations son atómicos en backend (tx + FOR UPDATE +
  // audit trail). Devuelven el tenant actualizado o ok=true según endpoint.

  // PATCH /tenants/:id — mutate genérico. body acepta cualquier combo de
  // { plan, custom_mrr_usd, notes, trial_until, suspended_at, reason }.
  // Auto-coherencia: cambiar plan a no-trial limpia trial_until; a
  // no-enterprise limpia custom_mrr_usd. reason es opcional pero
  // recomendado para audit forense.
  patchTenant: (id, body) =>
    api(`/api/super-admin/tenants/${id}`, 'PATCH', body),

  // POST /tenants/:id/extend-trial — body { days, reason }. days es
  // entero positivo. Solo funciona si tenant.plan === 'trial' (sino 400).
  // Suma sobre el trial_until actual (o sobre hoy si era NULL).
  extendTrial: (id, body) =>
    api(`/api/super-admin/tenants/${id}/extend-trial`, 'POST', body),

  // POST /tenants/:id/suspend — body { reason } (requerido). Setea
  // suspended_at=NOW + suspended_reason. El backend NO desautoriza users
  // del tenant; el efecto de "no pueden operar" lo aplica el middleware
  // requireActiveTenant si el frontend agrega lo correspondiente.
  suspendTenant: (id, body) =>
    api(`/api/super-admin/tenants/${id}/suspend`, 'POST', body),

  // POST /tenants/:id/reactivate — body { reason } opcional. Setea
  // suspended_at=NULL + suspended_reason=NULL. No revierte otros cambios
  // del periodo de suspensión (si subieron plan, queda subido).
  reactivateTenant: (id, body = {}) =>
    api(`/api/super-admin/tenants/${id}/reactivate`, 'POST', body),
};

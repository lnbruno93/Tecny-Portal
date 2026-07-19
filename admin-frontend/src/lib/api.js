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
  // build. Mientras tanto, este fallback al menos no rompe builds locales.
  return (trimmed || 'https://tecny-backend-production.up.railway.app').replace(/\/+$/, '');
}

const BASE = resolveApiBase(import.meta.env.VITE_API_URL);

const TOKEN_KEY = 'admin_token';

// S-8 fix (audit 2026-06-22): try/catch defensivo en localStorage.
// Safari iOS modo privado tiene quota=0 → setItem tira QuotaExceededError.
// Sin el guard, login completo crasheaba con excepción no manejada.
// Failure mode aceptable: token no persiste cross-reload, sesión en
// memoria sigue OK hasta que el operador cierre la pestaña.
export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function saveToken(t) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[admin api] localStorage saveToken failed:', err?.message);
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // No-op si el storage no está disponible.
  }
}

// SEC-4 fix (audit 2026-06-22): clamp tamaño de error.message para que
// si el backend devuelve un blob enorme/raro (no JSON, HTML de proxy,
// stacktrace inadvertido), no se pinta-renderea-completo en banners.
// Limitamos a 200 chars + ellipsis. React escapa el contenido igual,
// pero esto evita layouts rotos por strings de N MB.
const MAX_ERR_MSG = 200;
function clampMsg(msg) {
  if (typeof msg !== 'string') return 'Error del servidor';
  const trimmed = msg.trim();
  if (trimmed.length <= MAX_ERR_MSG) return trimmed;
  return trimmed.slice(0, MAX_ERR_MSG - 1) + '…';
}

// SEC-3 fix (audit 2026-06-22): set de AbortControllers globales para
// poder abortar requests in-flight desde el logout. Sin esto, una
// request lenta lanzada antes del logout puede resolver después con
// datos del super-admin, y un componente puede `setState` sobre ese
// resultado dejándolo visible momentáneamente. El set se rellena al
// momento de iniciar cada request y se limpia cuando termina (success
// o error). `abortAllInFlight` los aborta todos a la vez.
const inFlightControllers = new Set();
export function abortAllInFlight() {
  for (const c of inFlightControllers) {
    try { c.abort(); } catch { /* noop */ }
  }
  inFlightControllers.clear();
}

// Core wrapper — devuelve JSON, throw en error con mensaje legible.
export async function api(path, method = 'GET', body = null, timeoutMs = 15000) {
  const controller = new AbortController();
  inFlightControllers.add(controller);
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
    inFlightControllers.delete(controller);
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
    // SEC-4: clamp tamaño del mensaje antes de propagarlo al UI.
    const err = new Error(clampMsg(msg));
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
// 2026-07-04: acepta `code` (TOTP 6 dígitos) opcional. El backend responde
// 401 con `twofa_required: true` si la password OK pero el user tiene 2FA
// activo — el caller re-invoca con code en la segunda pasada.
//
// 2026-07-13 hotfix: acepta `hcaptchaResponse` opcional. Sprint 1 PR B
// (portal Externa P0-1) agregó hCaptcha invisible en /api/auth/login. El
// admin nunca implementó el widget, entonces con HCAPTCHA_ENABLED=true en
// prod el backend rechazaba TODOS los logins de super-admin con "Verificación
// inválida". El widget ahora vive en pages/Login.jsx del admin y su token
// viaja acá. Mismo semántica que el portal: no se re-envía en step 2 del 2FA.
async function loginDirect(username, password, code, hcaptchaResponse) {
  const isEmail = typeof username === 'string' && username.includes('@');
  const bodyObj = isEmail ? { email: username, password } : { username, password };
  if (code) bodyObj.code = code;
  if (hcaptchaResponse) bodyObj.hcaptcha_response = hcaptchaResponse;
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
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
  // `code` es opcional: el flujo estándar es intentar sin code, y si el backend
  // responde 401 { twofa_required: true }, reintentar con el TOTP de 6 dígitos.
  login: (username, password, code, hcaptchaResponse) =>
    loginDirect(username, password, code, hcaptchaResponse),
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

  // POST /tenants/:id/set-paid-until — body { paid_until: 'YYYY-MM-DD'|null, reason? }.
  // TANDA 4.B billing pre-live: Lucas marca aquí el período cubierto por la
  // transferencia recibida. reason obligatorio cuando paid_until es una fecha
  // (justificación monto cobrado). paid_until=null → grandfather (sin enforcement).
  setPaidUntil: (id, body) =>
    api(`/api/super-admin/tenants/${id}/set-paid-until`, 'POST', body),

  // GET /tenants/export?[plan|suspended|search] — descarga CSV (#450).
  // Streamea el archivo via blob — diferente del wrapper api() que devuelve JSON.
  // Triggers download del browser usando object URL temporal.
  exportTenants: async (filters = {}) => {
    const qs = buildQs(filters);
    const controller = new AbortController();
    inFlightControllers.add(controller);
    try {
      const token = getToken();
      const res = await fetch(BASE + '/api/super-admin/tenants/export' + qs, {
        method: 'GET',
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
        signal: controller.signal,
      });
      if (res.status === 401) {
        clearToken();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('admin-session-expired'));
        }
        const err = new Error('NO_AUTH');
        err.status = 401;
        throw err;
      }
      if (!res.ok) {
        // Errores devuelven JSON, no CSV — parsear.
        let msg = 'No pudimos exportar';
        try {
          const j = await res.json();
          msg = j?.error || msg;
        } catch (_) { /* swallow */ }
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      const blob = await res.blob();
      // Disparar download: anchor invisible + click + revoke URL.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Sacamos nombre del header si vino, sino default.
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      a.download = m ? m[1] : `tenants_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return { ok: true };
    } finally {
      inFlightControllers.delete(controller);
    }
  },

  // PATCH /tenants/:id/pais — cambiar país del tenant (#473).
  //
  // body: { pais: 'AR' | 'UY' }
  // Solo super-admin (gate en backend). Side effects: crea cajas default del
  // país nuevo con sufijo (UY)/(AR) en el nombre, actualiza alerta TC al
  // valor del país, invalida cache tenantStatus. Audit en
  // tenant_admin_actions con action='tenant_pais_changed'.
  //
  // Errores comunes (backend devuelve `code`):
  //   - 400 same_country: pais === actual del tenant
  //   - 400 tenant_suspended: tenant suspendido
  //   - 409 has_active_partnerships: tiene Red B2B activa, revocar primero
  //   - 404: tenant no existe / soft-deleted
  //
  // Response 200: { tenant_id, pais_anterior, pais_nuevo,
  //                 side_effects: { cajas_creadas, alerta_actualizada } }
  changePaisTenant: (id, pais) =>
    api(`/api/super-admin/tenants/${id}/pais`, 'PATCH', { pais }),

  // PATCH /tenants/:id/comprobante-footer (#475) — setea el footer custom
  // plain-text del email de comprobante de venta retail. footer=null o ''
  // borra el override (vuelve al footer default del portal).
  //
  // Response 200: { tenant_id, comprobante_email_footer }
  updateComprobanteFooter: (id, footer) =>
    api(`/api/super-admin/tenants/${id}/comprobante-footer`, 'PATCH', { footer }),

  // DELETE /tenants/:id?confirm=<slug> — soft-delete tenant (feature #438).
  //
  // Anti-clicaccidental estilo GitHub: el caller debe pasar el slug del
  // tenant como query param `?confirm=`. El backend valida que coincida con
  // tenant.slug, sino devuelve 400. Esto fuerza al user a tipear el nombre
  // del tenant antes de habilitar el botón rojo (lo enforcea el modal).
  //
  // Idempotente: si ya estaba soft-deleted, responde 200 con
  // { ok: true, alreadyDeleted: true } (no falla doble-click).
  //
  // body: { reason?: string } — opcional pero recomendado para audit trail.
  deleteTenant: (id, slug, body = {}) =>
    api(
      `/api/super-admin/tenants/${id}?confirm=${encodeURIComponent(slug)}`,
      'DELETE',
      body
    ),

  // POST /tenants — crear tenant manual (#452). Onboarding desde el back office.
  // body: {
  //   tenant_nombre: string (1-255),
  //   nombre: string (1-255, nombre del owner),
  //   email: string (email del owner, normaliza a lowercase),
  //   plan: 'trial' | 'starter' | 'pro' | 'enterprise' (default 'trial'),
  //   custom_mrr_usd?: number  // REQUERIDO si plan='enterprise'
  //   reason?: string  // nota libre para audit trail
  // }
  // Response 201: { tenant: {...}, owner: {...}, password_setup_url_ttl_hours }
  // 409: email ya registrado (reason='email_taken')
  // 400: validation (Zod)
  // Backend envía email al owner con link "elegí tu password" (TTL 24h).
  createTenant: (body) =>
    api('/api/super-admin/tenants', 'POST', body),

  // ── Plan Prices (C.1.2 #353) ──────────────────────────────────────────
  // GET /plan-prices — lista los 4 planes con precio + notas + updated_by.
  // Devuelve { plan_prices: [{ plan, price_usd, active, notes, updated_at,
  // updated_by, updated_by_username }] }. Orden canónico: trial → starter
  // → pro → enterprise.
  getPlanPrices: () => api('/api/super-admin/plan-prices'),

  // PATCH /plan-prices/:plan — actualiza price_usd (+ notes opcional).
  // body: { price_usd: number|null, notes?: string|null, reason?: string }.
  // Reglas server-side:
  //   · trial NO se puede editar (400 con mensaje claro)
  //   · enterprise rechaza price_usd != null (custom per-tenant via
  //     tenants.custom_mrr_usd)
  //   · plan inexistente → 404
  //   · no-op (mismo valor) → 200 con noop:true
  // El backend hace refreshCache() post-commit, así que un GET inmediato
  // devuelve el valor nuevo.
  updatePlanPrice: (plan, body) =>
    api(`/api/super-admin/plan-prices/${encodeURIComponent(plan)}`, 'PATCH', body),

  // ── CMS Landing (2026-07-13, Fase 1: Contacto) ────────────────────────
  // GET /site-config → row de site_landing_config (para popular el form).
  // PATCH /site-config → actualiza campos parciales del contacto.
  // La landing pública consume GET /api/public/site-config (endpoint separado).
  getSiteConfig:    () => api('/api/super-admin/site-config'),
  updateSiteConfig: (body) => api('/api/super-admin/site-config', 'PATCH', body),

  // GET /google-reviews-status → estado + count del Google Business Profile
  // usado por la card "Reseñas de Google" (toggle enabled + status display).
  getGoogleReviewsStatus: () => api('/api/super-admin/google-reviews-status'),

  // ── CMS Landing Fase 4 (2026-07-18): Empresas que confiaron en Tecny ────
  // Grid/carrusel de logos editable desde el admin. Los logos se suben como
  // base64 (frontend convierte con FileReader antes del POST).
  //
  // GET /trusted-companies              → lista con metadata (sin base64)
  // POST /trusted-companies             → { nombre, logo_data, logo_mime, logo_nombre? }
  // PATCH /trusted-companies/:id        → { nombre?, position? } (reorder ↑↓)
  // DELETE /trusted-companies/:id       → soft-delete + R2 cleanup
  //
  // La landing pública consume GET /api/public/trusted-companies (metadata)
  // + /api/public/trusted-companies/:id/logo (blob individual con cache 24h).
  listTrustedCompanies:   () => api('/api/super-admin/trusted-companies'),
  createTrustedCompany:   (body) => api('/api/super-admin/trusted-companies', 'POST', body),
  updateTrustedCompany:   (id, body) =>
    api(`/api/super-admin/trusted-companies/${encodeURIComponent(id)}`, 'PATCH', body),
  deleteTrustedCompany:   (id) =>
    api(`/api/super-admin/trusted-companies/${encodeURIComponent(id)}`, 'DELETE'),

  // ── Métodos de pago (task #132, 2026-07-15) ──────────────────────────
  // Catálogo global editable. Cada tenant puede tener uno asignado
  // (tenants.metodo_pago_id). Se gestiona desde el modal del header de
  // Facturación, y se asigna con dropdown inline en cada fila.
  //
  // GET /payment-methods → { payment_methods: [{id, nombre, activo, orden,
  //                          en_uso, created_at, updated_at}] }
  //   Devuelve activos + inactivos (ordenados). en_uso = count de tenants.
  //
  // POST /payment-methods { nombre } → 201 con el método creado.
  //   409 si nombre duplicado (case-insensitive).
  //
  // PATCH /payment-methods/:id { nombre?, activo?, orden? } → 200 con el
  //   método actualizado. 404 si no existe. 409 si nombre duplicado.
  //
  // DELETE /payment-methods/:id → 200 { ok: true }. 409 si en_uso > 0
  //   (reasignar tenants primero, o usar PATCH activo=false para soft-delete).
  //
  // PATCH /tenants/:id/metodo-pago { metodo_pago_id } → asigna. metodo_pago_id
  //   puede ser null (desasigna). 409 si el método está inactivo.
  listPaymentMethods:   () => api('/api/super-admin/payment-methods'),
  createPaymentMethod:  (nombre) => api('/api/super-admin/payment-methods', 'POST', { nombre }),
  updatePaymentMethod:  (id, body) => api(`/api/super-admin/payment-methods/${encodeURIComponent(id)}`, 'PATCH', body),
  deletePaymentMethod:  (id) => api(`/api/super-admin/payment-methods/${encodeURIComponent(id)}`, 'DELETE'),
  setTenantMetodoPago:  (tenantId, metodoPagoId) =>
    api(`/api/super-admin/tenants/${tenantId}/metodo-pago`, 'PATCH', { metodo_pago_id: metodoPagoId }),

  // ── Facturación (2026-07-15 v2, task #131) ────────────────────────────
  // GET /facturacion → estado de cuenta de todos los tenants (no soft-deleted).
  // Refleja la realidad del cobro manual (WhatsApp/transferencia) — no
  // inventa facturas, deriva el estado de campos que ya usa Ficha
  // (paid_until, trial_until, suspended_at).
  //
  // Response: {
  //   kpis: {
  //     mrr_usd, total_clientes,
  //     al_dia_count, al_dia_usd,
  //     vencidos_count, vencidos_usd,
  //     trials_count, trials_por_vencer_7d,
  //     suspendidos_count, sin_config_count
  //   },
  //   clientes: [{ id, tenant_id, tenant_nombre, plan, plan_label,
  //                monto_usd, fecha_referencia, estado, suspended_reason,
  //                metodo_pago_id, metodo_pago_nombre }],
  //   metodos_disponibles: [{ id, nombre }]  // solo métodos activos
  // }
  //
  // estado ∈ { 'al_dia' | 'vencida' | 'trial' | 'trial_vencido' |
  //            'sin_config' | 'suspendida' }
  //
  // Orden de las filas: prioriza los que necesitan atención (vencida >
  // sin_config > trial_vencido > trial > al_dia > suspendida). Dentro de
  // cada estado, por fecha_referencia asc (más urgente primero).
  getFacturacion: () => api('/api/super-admin/facturacion'),

  // ── Clases duplicadas (2026-07-14) ────────────────────────────────────
  // Herramienta de mantenimiento cross-tenant: detectar y fusionar categorías
  // de producto (`clases_producto`) casi-duplicadas dentro de UN tenant.
  //
  // Caso típico: el tenant tiene ambos "iPads" (base, del catálogo Tecny) y
  // "ipad" (custom, creado por el cliente al importar XLSX o al tipear
  // manualmente). Ambos apuntan a productos separados → KPIs y filtros
  // fragmentados. La detección usa trigram similarity + containment.
  //
  // GET /tenants/:id/clases-duplicadas → { pairs: [{ a, b, similarity,
  //   contain_kind, score, confidence, canonica_suggested_id, duplicada_suggested_id }] }
  //
  // POST /tenants/:id/clases-merge → body { duplicada_id, canonica_id }.
  // Response 200: { productos_movidos, canonica_nombre, duplicada_nombre }.
  // Errors: 400 (mismo id, base/sin_categoría como duplicada), 404 (cross-tenant),
  // 409 (rules del negocio), 23514 CHECK (audit action inválida — evitado por
  // migration 20260714).
  getClasesDuplicadas: (tenantId) =>
    api(`/api/super-admin/tenants/${tenantId}/clases-duplicadas`),
  mergeClasesProducto: (tenantId, body) =>
    api(`/api/super-admin/tenants/${tenantId}/clases-merge`, 'POST', body),

  // ── Team (#499) — gestión de co-super-admins ────────────────────────────
  // GET  /team           → { super_admins, pending_invites }
  // POST /team/invite    → { invite, email_sent }
  // DELETE /team/invite/:id → { ok }
  // POST /team/invite/:id/resend → { ok, email_sent }
  // POST /team/revoke/:userId → { ok, user }
  team: {
    list:          () => api('/api/super-admin/team'),
    invite:        (body) => api('/api/super-admin/team/invite', 'POST', body),
    revokeInvite:  (id) => api(`/api/super-admin/team/invite/${id}`, 'DELETE'),
    resendInvite:  (id) => api(`/api/super-admin/team/invite/${id}/resend`, 'POST'),
    revokeAdmin:   (userId) => api(`/api/super-admin/team/revoke/${userId}`, 'POST'),
  },

  // ── Release notes / Novedades (task #141, 2026-07-16) ─────────────────
  // CRUD del CMS de novedades. Las notas son GLOBAL cross-tenant (mismas
  // notas para todos los clientes del portal). El backend las persiste
  // en la tabla `release_notes` sin RLS — reads públicas via
  // /api/release-notes (portal cliente), writes admin-only acá.
  //
  // Endpoints:
  //   GET    /release-notes           → { release_notes: [...] } ordenado DESC
  //   POST   /release-notes           → 201 { ...nota } | 400 { error, fields }
  //   PATCH  /release-notes/:id       → 200 { ...nota } | 404 | 400
  //   DELETE /release-notes/:id       → 200 { ok: true } | 404
  //
  // Body de create/update: { titulo, descripcion, tipo, publicado_en? }
  //   titulo:       string 1-60 chars (trim)
  //   descripcion:  string 1-280 chars (trim)
  //   tipo:         'feature' | 'mejora' | 'fix'
  //   publicado_en: ISO 8601 opcional (default NOW)
  releaseNotes: {
    list:   () => api('/api/super-admin/release-notes'),
    create: (body) => api('/api/super-admin/release-notes', 'POST', body),
    update: (id, body) => api(`/api/super-admin/release-notes/${encodeURIComponent(id)}`, 'PATCH', body),
    remove: (id) => api(`/api/super-admin/release-notes/${encodeURIComponent(id)}`, 'DELETE'),
  },
};

// ─── Public — aceptar invitación de super-admin (#499) ──────────────────
// Endpoints públicos: NO requieren JWT. El wrapper `api()` no manda
// header Authorization cuando getToken() devuelve null, así que este
// flow funciona antes de que el invitado tenga cuenta.
//
// verify: valida el token. Backend devuelve 200 si vigente, 404 (ambiguo)
//   si inválido/expirado/aceptado/revocado.
// accept: consume el token, crea el user, backend devuelve JWT.
//   El caller debe llamar saveToken(res.token) para persistir la sesión.
export const publicInvite = {
  verify: (token) =>
    api(`/api/public/super-admin-invite/${encodeURIComponent(token)}`),
  // hcaptchaResponse (2026-07-12): token del widget hCaptcha del cliente.
  // Opcional a nivel wire — el backend bypassa cuando HCAPTCHA_ENABLED!='true'
  // (dev/test), verifica en prod. Solo mandamos el field si el widget produjo
  // un token, sino omitimos (Zod .optional() lo acepta).
  accept: (token, password, hcaptchaResponse) =>
    api(
      `/api/public/super-admin-invite/${encodeURIComponent(token)}/accept`,
      'POST',
      {
        password,
        ...(hcaptchaResponse ? { hcaptcha_response: hcaptchaResponse } : {}),
      }
    ),
};

// ─── Auth account management (Mi cuenta — task #498) ─────────────────────
// Endpoints /api/auth/2fa/* y /api/auth/change-password son shared con
// el portal principal — el backend los mounta con requireAuth pero SIN
// requireSuperAdmin, así el super-admin puede gestionar su cuenta desde
// aquí sin quedar locked-out por el guard S-25 (audit 2026-06-30) que
// exige 2FA para llegar a /api/super-admin/*.
//
// Diseño: exportamos módulos separados (auth, twoFa) — mismo shape que el
// frontend principal para que el port de componentes sea mecánico y no
// tengamos que reescribir los call sites.

export const auth = {
  // POST /api/auth/change-password — cambia el password del user autenticado.
  // body: { currentPassword, newPassword, twofa_code? }
  // Responses:
  //   · 200 { ok: true }
  //   · 401 { code: 'TWOFA_REQUIRED', twofa_required: true }        → user tiene 2FA activo; re-submit con code
  //   · 401 { code: 'INVALID_TWOFA_CODE' }                           → 2FA code mal
  //   · 401 { code: 'INVALID_CURRENT_PASSWORD' }                     → password actual mal
  //   · 400 { error: 'Password policy fail...' }                     → nueva rechazada por policy
  //
  // Efecto side: backend bumpea password_changed_at → el JWT del cliente
  // queda inválido → forzar logout post-éxito.
  changePassword: (currentPassword, newPassword, twofaCode) =>
    api('/api/auth/change-password', 'POST', {
      currentPassword,
      newPassword,
      ...(twofaCode ? { twofa_code: twofaCode } : {}),
    }),

  // ─── Forgot password / Reset password (2026-07-04) ─────────────────────
  // Port del flow que ya existe en frontend/src/lib/api.js (TANDA 0 #321).
  // Endpoints /api/auth/forgot-password y /api/auth/reset-password son PÚBLICOS
  // (no requieren Bearer). El wrapper `api()` no manda Authorization cuando
  // getToken() es null, así que este flow funciona con el user deslogueado.
  //
  // Diferencia con el portal: acá NO usamos hCaptcha. Rationale — la superficie
  // de ataque es acotada (el pool de super-admins de Tecny es de <10 personas,
  // no un signup form público), y no queremos pedirle al backend un endpoint
  // "sin captcha" adicional. Si el backend enforcea captcha para todos, va a
  // devolver 400 y el error se surface como mensaje genérico. Trade-off aceptado:
  // volumen bajísimo, no vale la pena la fricción.
  //
  // forgotPassword: backend responde 200 idéntica para email existente vs
  //   no-existente (anti-enum). El frontend siempre muestra "si existe, mandamos".
  //   200 body opcional: { reset_token_ttl_hours: number } — usamos como default 1h.
  //
  // resetPassword: consume token del email + setea nueva pass. Errores:
  //   · 200 { ok: true }
  //   · 401 { code: 'INVALID_RESET_TOKEN' }  → link inválido
  //   · 401 { code: 'EXPIRED_RESET_TOKEN' }  → link vencido
  //   · 401 { code: 'USED_RESET_TOKEN' }     → link ya usado
  //   · 400 { fields: [{ field: 'newPassword', error: '...' }] } → policy fail
  //
  // OJO: forgotPassword hace un 200 → el wrapper api() NO limpia el token
  // (solo limpia en 401). Perfecto para nuestro caso.
  // resetPassword puede devolver 401, y el wrapper api() clearea el token
  // en 401 — pero el user no tenía token para arrancar (está deslogueado),
  // así que el clear es un no-op y no hace daño.
  forgotPassword: (email) =>
    api('/api/auth/forgot-password', 'POST', { email }),
  resetPassword: (token, newPassword) =>
    api('/api/auth/reset-password', 'POST', { token, newPassword }),
};

export const twoFa = {
  // GET /status → { configured, enabled, enabled_at, last_used_at, recovery_codes_remaining }
  status: () => api('/api/auth/2fa/status'),

  // POST /setup → { secret, otpauth_uri, recovery_codes: [8 strings] }
  // Genera el secret encriptado + recovery codes plain (mostrados UNA vez).
  // Idempotente: si el user ya llamó setup pero no enable, devuelve el mismo
  // secret. Si llama setup DESPUÉS de enable, error (hay que disable primero).
  setup: () => api('/api/auth/2fa/setup', 'POST'),

  // POST /enable { code } → { ok: true, enabled_at }
  // code = 6 dígitos TOTP. Verifica contra el secret guardado en /setup.
  // Marca enabled_at = NOW() → el guard requireSuperAdmin ahora deja entrar.
  enable: (code) => api('/api/auth/2fa/enable', 'POST', { code }),

  // POST /disable { code } → { ok: true }
  // code = 6 dígitos TOTP o recovery code. Verifica y marca enabled_at = NULL.
  disable: (code) => api('/api/auth/2fa/disable', 'POST', { code }),

  // POST /regenerate-recovery { code } → { recovery_codes: [8 strings] }
  // Rota los 8 recovery codes. Los anteriores quedan invalidados.
  regenerateRecovery: (code) =>
    api('/api/auth/2fa/regenerate-recovery', 'POST', { code }),

  // POST /cancel-setup → { ok: true }
  // Borra el row si enabled_at IS NULL (setup pendiente). Task #497 — UX
  // defensiva cuando el user abandonó el setup antes de confirmar el código.
  // Falla con 409 si ya está enabled (usar /disable en su lugar).
  cancelSetup: () => api('/api/auth/2fa/cancel-setup', 'POST'),
};

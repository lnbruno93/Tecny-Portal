// Helpers UI para clasificar/renderizar datos de tenant. Mantenidos acá
// centralizados para reuso en Resumen / Clientes / Ficha — toda derivación
// de estado/color/tone vive en un solo lugar.
//
// El backend devuelve los campos crudos (suspended_at, plan, trial_until,
// etc.). El "estado" mostrado al super-admin es una derivación canónica
// que combina varios de esos campos. Si en el futuro el backend agrega
// un campo `lifecycle_stage` o similar, solo cambia getTenantStatus.

export const TENANT_STATUS = {
  active:     { tone: 'pos',    label: 'Activa' },
  trial:      { tone: 'info',   label: 'Trial' },
  onboarding: { tone: 'accent', label: 'Onboarding' },
  suspended:  { tone: 'warn',   label: 'Suspendida' },
  cancelled:  { tone: 'muted',  label: 'Cancelada' },
};

export function getTenantStatus(tenant) {
  if (!tenant) return 'active';
  if (tenant.suspended_at) return 'suspended';
  if (tenant.plan === 'trial' || tenant.trial_until) return 'trial';
  // onboarding/cancelled vendrán en fases siguientes; por ahora todo lo
  // demás es "active". Devolvemos un valor canónico siempre — la UI nunca
  // debería tener que manejar undefined.
  return 'active';
}

export const PLAN_TONES = {
  starter: 'default',
  pro: 'info',
  business: 'info',
  enterprise: 'accent',
  trial: 'default',
};

export const planTone = (plan) =>
  PLAN_TONES[String(plan || '').toLowerCase()] || 'default';

// H-1 centralizado (audit 2026-06-22): antes había 5 copias byte-a-byte
// de esta función (Resumen, Clientes, Ficha, Planes, EditTenantModal).
// Refactor a un solo lugar — cambiar capitalización de planes es ahora
// editar una línea, no cinco.
export function planLabel(p) {
  if (!p) return '—';
  return p.charAt(0).toUpperCase() + p.slice(1);
}

// Health score → color. Umbrales pensados para "vista de pájaro" del
// super-admin, no para alertas finas (eso lo hace el backend).
//
// Categoría opcional (#440): si el backend nos manda category='onboarding'
// o 'suspended', forzamos el color asociado independiente del score
// (onboarding=accent azul, suspended=muted gris). Esto permite distinguir
// "es nuevo, dale tiempo" de "score bajo de verdad" sin mirar dos campos
// en el componente.
export const healthColor = (h, category) => {
  if (category === 'onboarding') return 'var(--accent)';
  if (category === 'suspended')  return 'var(--text-muted)';
  if (h >= 80) return 'var(--pos)';
  if (h >= 55) return 'var(--accent)';
  if (h >= 40) return 'var(--warn)';
  return 'var(--neg)';
};

// Categoría → etiqueta humana (esp). Backend devuelve las claves canónicas
// y acá decidimos cómo se muestran al super-admin en el badge.
export const HEALTH_CATEGORY_LABEL = {
  excellent:  'excelente',
  healthy:    'estable',
  'at-risk':  'en riesgo',
  cold:       'frío',
  onboarding: 'onboarding',
  suspended:  'suspendida',
};
export const healthCategoryLabel = (category) =>
  HEALTH_CATEGORY_LABEL[category] || '—';

export const tenantInitials = (name) => {
  if (!name) return '?';
  // T-? fix (audit 2026-06-22): trim antes del split. Sin esto, un nombre
  // con leading whitespace ("  Tecny SaaS") quedaba como ['', 'Tecny',
  // 'SaaS'], slice(0,2) agarraba ['', 'Tecny'] y devolvía solo 'T'.
  // Edge case en avatares cuando el operador copy-pastea el nombre desde
  // un email o documento con espacios al principio.
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase();
};

// Health score del tenant: 0-100. La fuente preferida es `tenant.health_score`
// que viene del backend (#440) calculado con 4 componentes ponderados:
// actividad (30%) + cobros (30%) + adopción (20%) + asientos (20%), con
// onboarding override <7d. Esto reemplaza el proxy viejo que solo miraba
// last_venta_at.
//
// Si el caller solo tiene el tenant — lo pasa entero y lo extraemos. Si
// solo tiene last_venta_at (callers viejos), aplicamos el fallback al
// proxy heurístico para no romper backwards compat.
//
// Firma soportada:
//   healthFromTenant(tenant)        → preferida (#440)
//   healthFromTenant(lastVentaAt)   → legacy proxy (string/Date)
//
// El nombre quedó `healthProxy` para compat con Resumen/Clientes que ya lo
// importan así; agregamos healthFromTenant como alias explícito.
export function healthFromTenant(input) {
  if (input && typeof input === 'object' && 'health_score' in input) {
    return Number(input.health_score) || 0;
  }
  return legacyHealthProxy(input);
}

// Legacy: usado cuando solo se tiene last_venta_at (sin score del backend).
// Mantener mientras no migremos todos los call-sites a pasar el tenant
// completo. Una vez todos lo hagan, se puede borrar.
function legacyHealthProxy(lastActivityAt) {
  if (!lastActivityAt) return 25;
  const ts = new Date(lastActivityAt).getTime();
  if (isNaN(ts)) return 25;
  const days = (Date.now() - ts) / 86400000;
  if (days < 1) return 95;
  if (days < 7) return 75;
  if (days < 30) return 50;
  return 25;
}

// Alias retro-compat: callers viejos pasaban directamente last_venta_at.
// La firma nueva acepta el tenant completo y prefiere health_score.
export const healthProxy = healthFromTenant;

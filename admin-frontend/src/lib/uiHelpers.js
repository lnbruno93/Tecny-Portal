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
export const healthColor = (h) => {
  if (h >= 80) return 'var(--pos)';
  if (h >= 55) return 'var(--accent)';
  if (h >= 40) return 'var(--warn)';
  return 'var(--neg)';
};

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

// Proxy 0–100 de "salud" del tenant basado SOLO en cuánto hace que no
// hay actividad de venta. Es una señal débil pero suficiente para una
// columna de "vista de pájaro" en el listado de Clientes / Top clientes
// del Resumen — el super-admin lo usa para detectar cuentas que se
// están enfriando, no como métrica formal.
//
// TODO (Salud real): definir fórmula combinada
//   uso producto (logins/eventos) + cobros al día + adopción features.
// Cuando exista, este helper se reemplaza pero la firma queda igual
// para no romper call-sites (Resumen, Clientes).
export function healthProxy(lastActivityAt) {
  if (!lastActivityAt) return 25;
  const ts = new Date(lastActivityAt).getTime();
  if (isNaN(ts)) return 25;
  const days = (Date.now() - ts) / 86400000;
  if (days < 1) return 95;
  if (days < 7) return 75;
  if (days < 30) return 50;
  return 25;
}

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
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase();
};

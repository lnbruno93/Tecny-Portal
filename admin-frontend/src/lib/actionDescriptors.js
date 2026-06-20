// Mapping centralizado de actions admin (audit trail del backend) a su
// presentación visual. Extraído de Resumen.jsx para reuso desde Ficha.jsx
// (Sub-fase B.3 #353) — el feed de "Actividad admin" aparece en dos
// contextos: cross-tenant (Resumen) y per-tenant (Ficha).
//
// El backend define 6 action types fijos:
//   suspend, reactivate, plan_change, trial_extend,
//   custom_mrr_update, note_update
//
// Cualquier action desconocida cae al default (Sparkle / muted) — esto
// nos da resiliencia ante deploys de backend que agreguen un tipo nuevo
// antes que el frontend lo conozca.

import { Icons } from '../components/Icons.jsx';

const ACTION_MAP = {
  suspend:           { icon: 'Lock',     tone: 'neg',    label: 'suspendió' },
  reactivate:        { icon: 'Refresh',  tone: 'pos',    label: 'reactivó' },
  plan_change:       { icon: 'TrendUp',  tone: 'accent', label: 'cambió plan de' },
  trial_extend:      { icon: 'Calendar', tone: 'info',   label: 'extendió trial de' },
  custom_mrr_update: { icon: 'Dollar',   tone: 'info',   label: 'actualizó MRR de' },
  note_update:       { icon: 'Edit',     tone: 'muted',  label: 'editó notas de' },
};

const DEFAULT_META = { icon: 'Sparkle', tone: 'muted', label: '?' };

/**
 * Devuelve { iconName, IconCmp, tone, label } para una action dada.
 * `iconName` (string) sirve si el caller quiere pasarlo a un wrapper que
 * resuelva el componente; `IconCmp` (componente React) es el atajo directo.
 */
export function describeAction(a) {
  const meta = ACTION_MAP[a?.action] || { ...DEFAULT_META, label: a?.action || '?' };
  return {
    iconName: meta.icon,
    IconCmp: Icons[meta.icon] || Icons.Sparkle,
    tone: meta.tone,
    label: meta.label,
  };
}

/**
 * Texto largo para feeds cross-tenant (Resumen):
 *   "lucas suspendió Aurora Mobile"
 * Si la action no tiene tenant_nombre (raro pero defensivo), cae al
 * fallback recibido y por último a "tenant #<id>".
 */
export function actionLongText(a, fallbackTenantName) {
  const meta = ACTION_MAP[a?.action];
  const label = meta?.label || a?.action || '?';
  const who = a?.super_admin_username || 'admin';
  const tenant = a?.tenant_nombre || fallbackTenantName || `tenant #${a?.tenant_id || '?'}`;
  return `${who} ${label} ${tenant}`;
}

/**
 * Texto corto para feeds per-tenant (Ficha):
 *   "lucas suspendió" (el "este tenant" se sobreentiende por contexto)
 * Sacamos el sufijo " de" porque visualmente queda colgado cuando no
 * lo seguimos con el nombre del tenant.
 */
export function actionShortText(a) {
  const meta = ACTION_MAP[a?.action];
  const label = (meta?.label || a?.action || '?').replace(/ de$/, '');
  const who = a?.super_admin_username || 'admin';
  return `${who} ${label}`;
}

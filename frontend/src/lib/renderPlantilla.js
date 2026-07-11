// Helper puro que renderiza plantillas de garantía sustituyendo placeholders
// por valores del tenant en runtime. Antes teníamos "Tecny" / "iPro | Tech
// Reseller" hardcoded en el texto de las plantillas guardadas en DB —
// resultado: los tenants nuevos veían el brand del SaaS en vez del suyo,
// aunque el owner haya setteado su nombre de negocio en Cotizador (#506).
//
// Diseño (2026-07-07):
//   - La plantilla en DB guarda `{{negocio}}` como placeholder.
//   - Al renderizar (PDF, preview modal, comprobante email) reemplazamos
//     `{{negocio}}` por `tenant.nombre` (owner-set). Si el tenant no tiene
//     nombre setteado, fallback a un placeholder neutro — evita que quede el
//     `{{negocio}}` literal en el output final.
//   - Migration 20260707000003 backfilleó plantillas existentes que tenían
//     "Tecny" / "iPro | Tech Reseller" hardcoded a la variante con el
//     placeholder.
//
// 2026-07-11 (bug Tek Haus): el fallback pasó de 'Tecny' → 'Tu comercio'.
// Si /me devolvía tenant:null por un cache miss del helper, el garantía del
// comprobante salía con "Tecny" en el pie — el cliente final del tenant
// asumía que la venta era de Tecny (SaaS), no de su comercio. Fix real en
// /me hace el fallback query directo a `tenants`; este string solo activa
// si TODO falla.
//
// El helper es puro (sin DOM, sin fetch) para poder unit-testear y usarlo
// en cualquier flow sin acoplar a React.

export const PLACEHOLDER_NEGOCIO = '{{negocio}}';
const NOMBRE_FALLBACK = 'Tu comercio';

/**
 * Renderiza un texto de plantilla reemplazando los placeholders conocidos.
 *
 * Reemplazos actuales:
 *   - `{{negocio}}` → `tenantNombre` (fallback 'Tu comercio' si no viene).
 *
 * Idempotente si `texto` no contiene el placeholder — devuelve el string tal
 * cual. Safe con `null`/`undefined` en cualquier argumento — devuelve string
 * vacío.
 *
 * @param {string} texto - Texto de la plantilla (puede tener `{{negocio}}`).
 * @param {string} [tenantNombre] - Nombre del negocio (owner-set). Fallback: 'Tu comercio'.
 * @returns {string}
 */
export function renderPlantilla(texto, tenantNombre) {
  if (texto == null) return '';
  const s = String(texto);
  const marca = (tenantNombre || '').trim() || NOMBRE_FALLBACK;
  // .split/.join para reemplazar TODAS las ocurrencias sin regex —
  // `{{negocio}}` es literal, no queremos que un tenant llamado "$1" haga
  // regex-injection al aparecer en el output. `.replaceAll` no soporta
  // targets older que Node 14 en algunos builds; split/join es universal.
  return s.split(PLACEHOLDER_NEGOCIO).join(marca);
}


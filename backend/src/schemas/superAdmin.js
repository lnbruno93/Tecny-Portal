/**
 * Schemas Zod para Super-Admin (#353 Fase 2).
 *
 * Validan los bodies de mutations PATCH/POST. Diseño defensivo:
 *   - `.strict()` para rechazar campos extra (no permitimos que el cliente
 *     mande campos no esperados — defense contra typos en frontend que
 *     silenciosamente no haga nada).
 *   - Reason opcional en cada acción — el frontend lo pide, pero si el
 *     admin lo deja vacío el endpoint igual procede (loguea sin reason).
 *   - Plan enum sincronizado con el CHECK constraint de tenants.plan.
 */

const { z } = require('zod');

const PLANES = ['trial', 'starter', 'pro', 'enterprise'];

// Slug regex: lowercase, números y hyphens. Sin hyphens consecutivos ni
// al principio/fin. Length 2-100. Mismo formato que el slug que genera
// signup.js a partir del nombre de la empresa — mantener consistencia
// permite rename a un valor que el sistema mismo habría generado.
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

// PATCH /api/super-admin/tenants/:id — mutate genérico.
// Todos los campos opcionales (al menos uno debe estar set, validado abajo).
const patchTenantSchema = z.object({
  plan:             z.enum(PLANES).optional(),
  // nombre: display del tenant en UI. Acepta cualquier string razonable
  // (incluye espacios, /, mayúsculas). Length 1-255 (matchea NOT NULL de DB).
  nombre:           z.string().trim().min(1, 'nombre no puede ser vacío').max(255).optional(),
  // slug: identificador URL-safe. Acción más delicada — está en UNIQUE
  // constraint y se referencia en audit trail histórico. Validamos formato
  // estricto acá para fail-fast antes de pegarle a PG (que rebotaría 23505).
  slug:             z.string().regex(
    SLUG_REGEX,
    'slug inválido: lowercase, números y hyphens; sin hyphens al inicio/fin; 2-100 chars'
  ).optional(),
  // suspended_at: aceptamos null (reactivar) o un ISO date (suspender ahora).
  // El frontend mandará null para reactivar; para suspender usa el shortcut.
  suspended_at:     z.string().datetime().nullable().optional(),
  suspended_reason: z.string().max(500).nullable().optional(),
  // trial_until: solo válido si plan='trial' — el CHECK de DB lo enforcea
  // pero validamos formato acá para 400 limpio en vez de 500 de PG.
  trial_until:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato YYYY-MM-DD').nullable().optional(),
  // custom_mrr_usd: solo válido si plan='enterprise'. Aceptamos números >= 0
  // o null (limpiar el valor cuando se baja de plan enterprise).
  custom_mrr_usd:   z.number().nonnegative().max(99999999.99).nullable().optional(),
  notes:            z.string().max(2000).nullable().optional(),
  // Reason: motivo del cambio, opcional pero recomendado. Se loguea a
  // tenant_admin_actions.reason.
  reason:           z.string().max(500).optional(),
}).strict().refine(
  (data) => {
    // Al menos UN campo mutable (no contando reason) debe estar set.
    // Sin esto, un PATCH {} sería no-op silencioso — peor UX.
    const mutables = ['plan', 'nombre', 'slug', 'suspended_at', 'suspended_reason',
                       'trial_until', 'custom_mrr_usd', 'notes'];
    return mutables.some((k) => k in data);
  },
  { message: 'Al menos un campo mutable debe estar presente' }
);

// POST /api/super-admin/tenants/:id/extend-trial — shortcut para extender trial.
// days: 1-365 (sanity bound). Reason obligatorio — extender trial es una
// concesión explícita, exige justificación documentada.
const extendTrialSchema = z.object({
  days:   z.number().int().min(1).max(365),
  reason: z.string().min(1, 'reason requerido').max(500),
}).strict();

// POST /api/super-admin/tenants/:id/suspend — suspender tenant.
// Reason obligatorio: suspender bloquea login, queremos audit trail
// claro de POR QUÉ.
const suspendTenantSchema = z.object({
  reason: z.string().min(1, 'reason requerido').max(500),
}).strict();

// POST /api/super-admin/tenants/:id/reactivate — reactivar tenant suspendido.
// Reason opcional (reactivar es siempre buena noticia, no exige justificación
// detallada — basta con "pagó" o similar si Lucas quiere).
const reactivateTenantSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();

// POST /api/super-admin/tenants/:id/set-paid-until — marca paid_until manual
// (TANDA 4.B billing pre-live 2026-06-25).
//
// Trigger: el operador recibió una transferencia y quiere extender el
// período pagado. Setea paid_until a una fecha futura.
//
// paid_until: fecha en formato YYYY-MM-DD. NULL permitido para "grandfather"
// un tenant (sin enforcement — útil para el tenant interno o enterprise con
// contrato papel anual).
//
// reason: obligatorio cuando paid_until es una fecha (require justificar el
// monto cobrado para audit) y opcional cuando es null (grandfathering manual).
const setPaidUntilSchema = z.object({
  paid_until: z.union([
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'paid_until debe ser YYYY-MM-DD'),
    z.null(),
  ]),
  reason: z.string().max(500).optional(),
}).strict().refine(
  d => d.paid_until == null || (typeof d.reason === 'string' && d.reason.length > 0),
  { message: 'reason requerido cuando paid_until es una fecha', path: ['reason'] }
);

// POST /api/super-admin/tenants — crear tenant manual (#452).
//
// Caso de uso: el super-admin onboardea un cliente desde el back office
// (típico: demo cerrada en sales call, tenant pre-creado antes del primer
// login del owner). Genera tenant + owner user + password setup token y
// envía email "elegí tu password" via Resend.
//
// Validaciones:
//   - tenant_nombre: display del tenant (lo verá el owner en su portal).
//     Length 1-255 (matchea NOT NULL tenants.nombre). El slug se deriva
//     automáticamente con uniqueSlug() — admin no lo elige.
//   - nombre: nombre completo del owner (lo verá en su perfil).
//   - email: del owner, valid email. Normalizado a lowercase + trim.
//   - plan: opcional, default 'trial'. Si es 'enterprise' se requiere
//     custom_mrr_usd (validado en .refine abajo).
//   - custom_mrr_usd: solo válido si plan='enterprise'. Si plan != enterprise,
//     se descarta silenciosamente (defense — la columna se setea null en el
//     INSERT cuando plan != enterprise).
//   - reason: nota libre del admin, va a tenant_admin_actions.reason. Útil
//     para "cerrado en demo del 15/jun" o similar.
const createTenantSchema = z.object({
  tenant_nombre:  z.string().trim().min(1, 'nombre de empresa requerido').max(255),
  nombre:         z.string().trim().min(1, 'nombre del owner requerido').max(255),
  email:          z.string().trim().toLowerCase().email('email inválido').max(255),
  plan:           z.enum(PLANES).default('trial'),
  custom_mrr_usd: z.number().nonnegative().max(99999999.99).optional(),
  reason:         z.string().max(500).optional(),
}).strict().refine(
  (data) => {
    // Enterprise sin custom_mrr_usd no tiene sentido — el MRR del tenant
    // sería 0 silenciosamente (PLAN_PRICES.enterprise = null) y el dashboard
    // mostraría "$0 MRR" para un cliente que en realidad paga. Mejor fail-fast
    // con 400 acá. Si admin quiere "enterprise gratis", puede setear 0
    // explícitamente.
    return data.plan !== 'enterprise' || typeof data.custom_mrr_usd === 'number';
  },
  { message: 'custom_mrr_usd es requerido para plan enterprise', path: ['custom_mrr_usd'] }
);

// DELETE /api/super-admin/tenants/:id — soft-delete tenant.
//
// Solo body — el slug de confirmación va por query param `?confirm=<slug>`
// validado en el handler (estilo GitHub repo delete: tipear el slug para
// confirmar la intención, evita clicks accidentales en el botón rojo).
//
// reason: opcional pero recomendado. Para "borré las cuentas de prueba
// del onboarding inicial" o similar. Va al audit trail.
const deleteTenantSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();

// PATCH /api/super-admin/plan-prices/:plan — cambiar precio de un plan (C.1.2 #353).
//
// price_usd: número >= 0 o null (para enterprise, que no tiene precio fijo).
// El CHECK chk_enterprise_no_fixed_price valida a nivel DB que enterprise
// solo acepte null — el endpoint enforcea lo mismo antes para 400 limpio.
//
// notes: opcional, libre — útil para auditoría manual ("subido 10% por
// inflación junio 2026"). Si no se manda, no se toca el valor actual.
//
// reason: opcional, va al audit trail tenant_admin_actions.reason.
const patchPlanPriceSchema = z.object({
  price_usd: z.number().nonnegative().max(99999999.99).nullable(),
  notes:     z.string().max(2000).nullable().optional(),
  reason:    z.string().max(500).optional(),
}).strict();

// PATCH /api/super-admin/tenants/:id/pais — cambia el país del tenant (#473).
//
// Acción manual del super-admin: solo hay 2 países hoy (AR/UY), el enum
// matchea exactamente el CHECK de tenants.pais. `.strict()` rechaza extras
// — si el frontend manda `reason` u otro campo, queremos 400 explícito para
// detectar mismatch contract (vs swallow silencioso).
//
// Reason NO incluido en este schema. El cambio de país es siempre por el
// mismo motivo (corregir signup equivocado) y los side-effects son
// determinísticos (cajas nuevas + alerta TC). Si en el futuro hace falta
// trazabilidad textual, agregar acá y propagar al audit.
const changePaisSchema = z.object({
  pais: z.enum(['AR', 'UY']),
}).strict();

// PATCH /api/super-admin/tenants/:id/comprobante-footer — actualiza el footer
// custom de los emails de comprobante de venta retail (#475).
//
// footer: string plain-text (no HTML — el render hace _esc antes de inyectar).
// max 500 chars (cap soft — coincide con el comment de la migration).
// null permitido: setear a null = revertir al footer default.
//
// trim primero → si después del trim queda string vacío, lo tratamos como
// null (intencionado por el endpoint). Razón: la UI envía '' cuando el
// operador limpia el textarea, y la semántica "vacío = sin override" es
// más limpia que persistir '' en DB.
const updateComprobanteFooterSchema = z.object({
  footer: z.union([
    z.string().trim().max(500, 'Máximo 500 caracteres'),
    z.null(),
  ]),
}).strict();

// 2026-07-13 (CMS Landing Fase 1): edición de la sección Contacto del sitio
// público tecnyapp.com desde el admin. Todos los campos son opcionales — el
// operador puede editarlos parcialmente. El schema acepta strings vacíos y
// los normaliza a null en el handler (misma semántica que footer arriba).
//
// Validaciones:
//   · email: regex pragmático (mismo que ventas cliente_email). Trim + lower.
//   · whatsapp: solo dígitos, 8-15 chars (E.164 crudo, ej. "5491126165007").
//     Sin `+` ni espacios — el frontend lo formatea para display.
//   · whatsapp_display: string libre para mostrar (ej. "+54 9 11 2616-5007").
//   · address: string libre max 200.
//   · instagram_handle: sin @, alfanumérico + `.` + `_`, max 30 (patrón real IG).
//   · instagram_url: URL válida http/https.
const CONTACT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IG_HANDLE_RE = /^[a-zA-Z0-9._]{1,30}$/;
const WHATSAPP_DIGITS_RE = /^\d{8,15}$/;

// 2026-07-13 (CMS Landing Fase 2): schema de un testimonio individual.
// Shape acordado con la landing (matchea el reviews[] hardcoded en App.tsx).
// - id: UUID que server genera si no viene (permite drag&drop stable + delete
//   por id sin ambigüedad).
// - initial: 1-2 chars max (típicamente 1 letra, la inicial del nombre).
// - color: HEX en formato #RRGGBB (validado con regex).
// - time: texto libre ("hace 3 días", "hace 1 mes", etc.). No parseamos
//   fechas: es display cosmético; el operador decide qué escribir.
const uuidLoose = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const testimonialItemSchema = z.object({
  id:       z.string().regex(uuidLoose, 'id inválido (debe ser UUID)').optional(),
  name:     z.string().trim().min(2, 'Nombre muy corto').max(100, 'Nombre muy largo'),
  initial:  z.string().trim().min(1, 'Falta la inicial').max(2, 'Máximo 2 caracteres'),
  color:    z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color debe ser hex #RRGGBB'),
  time:     z.string().trim().min(1, 'Falta el tiempo').max(30, 'Tiempo muy largo (ej. "hace 3 días")'),
  text:     z.string().trim().min(10, 'Texto muy corto').max(1000, 'Texto muy largo (máx 1000 chars)'),
}).strict();

// 2026-07-13 (CMS Landing Fase 3): schema de un item de FAQ.
// Shape (matchea el hardcoded en frontend/src/screens/Landing.jsx sección FAQ):
//   { id: uuid, question: string, answer: string }
// - question max 200 chars (headline en <summary>, más largo no wrap bien)
// - answer max 1000 chars (párrafo en <div class="a">)
const faqItemSchema = z.object({
  id:       z.string().regex(uuidLoose, 'id inválido (debe ser UUID)').optional(),
  question: z.string().trim().min(3, 'Pregunta muy corta').max(200, 'Pregunta muy larga'),
  answer:   z.string().trim().min(3, 'Respuesta muy corta').max(1000, 'Respuesta muy larga'),
}).strict();

const updateSiteLandingContactSchema = z.object({
  contact_email: z.union([
    z.string().trim().toLowerCase().regex(CONTACT_EMAIL_RE, 'Email inválido').max(254),
    z.literal(''),
    z.null(),
  ]).optional(),
  contact_whatsapp: z.union([
    z.string().trim().regex(WHATSAPP_DIGITS_RE, 'WhatsApp: solo dígitos, entre 8 y 15 (ej. 5491126165007)'),
    z.literal(''),
    z.null(),
  ]).optional(),
  contact_whatsapp_display: z.union([
    z.string().trim().max(50),
    z.literal(''),
    z.null(),
  ]).optional(),
  contact_address: z.union([
    z.string().trim().max(200),
    z.literal(''),
    z.null(),
  ]).optional(),
  contact_instagram_handle: z.union([
    z.string().trim().regex(IG_HANDLE_RE, 'Handle IG: solo letras/números/./_ (sin @)').max(30),
    z.literal(''),
    z.null(),
  ]).optional(),
  contact_instagram_url: z.union([
    z.string().trim().url('URL inválida').max(500),
    z.literal(''),
    z.null(),
  ]).optional(),
  // 2026-07-13 CMS Landing Fase 2: reseñas editables (max 50 para no explotar
  // el bundle de la landing; ~30 KB serializado a 50 reseñas de 500 chars).
  // Si viene, reemplaza el array completo (semántica "PUT sobre el field" —
  // add/edit/delete/reorder se resuelven en el frontend antes del PATCH).
  testimonials: z.array(testimonialItemSchema).max(50, 'Máximo 50 reseñas').optional(),
  // 2026-07-13 Toggle para pausar la integración con Google Business Profile.
  // false → backend deja de llamar a Places API, landing muestra solo manuales.
  // true (default en DB) → reseñas de Google visibles si hay ≥ threshold.
  google_reviews_enabled: z.boolean().optional(),

  // 2026-07-13 CMS Landing Fase 3: Hero editable.
  // - headline: título principal. Max 100 (2 líneas @ ~50 chars).
  // - subheadline: subtítulo debajo. Max 120.
  // - blurb: párrafo descriptivo bajo el subtítulo. Max 400 (~ 3 líneas).
  // Todos opcionales — null/vacío → landing usa fallback hardcoded del design.
  hero_headline:    z.union([z.string().trim().max(100, 'Headline muy largo (máx 100)'),
                             z.literal(''), z.null()]).optional(),
  hero_subheadline: z.union([z.string().trim().max(120, 'Subheadline muy largo (máx 120)'),
                             z.literal(''), z.null()]).optional(),
  hero_blurb:       z.union([z.string().trim().max(400, 'Blurb muy largo (máx 400)'),
                             z.literal(''), z.null()]).optional(),

  // 2026-07-13 CMS Landing Fase 3: CTA final editable.
  // - headline: el "Ordená tu negocio hoy" (max 80, 1 línea).
  // - body: subtítulo bajo el headline (max 250, 2 líneas).
  cta_headline: z.union([z.string().trim().max(80, 'CTA headline muy largo (máx 80)'),
                         z.literal(''), z.null()]).optional(),
  cta_body:     z.union([z.string().trim().max(250, 'CTA body muy largo (máx 250)'),
                         z.literal(''), z.null()]).optional(),

  // 2026-07-13 CMS Landing Fase 3: FAQ editable (max 20 items).
  // Mismo patrón que testimonials — si viene, reemplaza el array completo.
  // Server genera UUID para items sin id (nuevos).
  faq: z.array(faqItemSchema).max(20, 'Máximo 20 preguntas').optional(),
}).strict().refine(
  // Al menos un campo debe venir. Sin esto, PATCH con body {} pasaría el
  // Zod y haría un UPDATE no-op — patrón consistente con schemas del resto
  // del portal (schemas/cajas, schemas/contactos, etc.).
  (d) => Object.keys(d).length > 0,
  { message: 'Al menos un campo es requerido para actualizar' }
);

// 2026-07-14 (feature): merge de clases_producto duplicadas por tenant.
// Endpoint POST /super-admin/tenants/:id/clases-merge — recibe la clase
// duplicada (a mergear/soft-delete) y la canónica (donde van los productos).
// Ambas deben ser UUIDs válidos. El backend valida que pertenezcan al mismo
// tenant y que sean distintas.
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mergeClasesProductoSchema = z.object({
  duplicada_id: z.string().regex(uuidRegex, 'duplicada_id inválido (debe ser UUID)'),
  canonica_id:  z.string().regex(uuidRegex, 'canonica_id inválido (debe ser UUID)'),
}).strict().refine(
  (d) => d.duplicada_id !== d.canonica_id,
  { message: 'duplicada_id y canonica_id deben ser distintos' }
);

module.exports = {
  PLANES,
  mergeClasesProductoSchema,
  patchTenantSchema,
  extendTrialSchema,
  suspendTenantSchema,
  reactivateTenantSchema,
  setPaidUntilSchema,
  deleteTenantSchema,
  createTenantSchema,
  patchPlanPriceSchema,
  changePaisSchema,
  // #475
  updateComprobanteFooterSchema,
  // CMS Landing Fase 1
  updateSiteLandingContactSchema,
};

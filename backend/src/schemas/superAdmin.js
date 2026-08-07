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
//   · address_map_url: URL válida http/https (Google Maps), max 500.
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

// 2026-08-06 (CMS Landing Fase 5): schemas para 5 secciones adicionales
// editables desde admin.tecnyapp.com/sitio-publico. Feedback Lucas — quería
// sincronizar todo el copy nuevo del landing (rewrite del día) con el CMS.
//
// Cada uno matchea el shape del hardcoded en el respectivo componente
// Astro. Server genera UUID para items sin id (nuevos), mismo patrón que
// testimonials y faq. Límites max defensivos para no explotar el bundle.

// Modulos.astro — 7 cards de "Los módulos"
// - n: número visible arriba (01, 02, ..., 07)
// - tint: clase CSS del ícono (`tint-blue`, `tint-amber`, etc.)
// - iconKey: ID del SVG a renderar (uno de los 7 definidos en Modulos.astro)
// - wide: si `true`, el card ocupa 2 columnas (grid-column: span 2)
// - badges: chips debajo del body — cada uno opcional con `hi: true` para
//   destacar (color warn amber). Max 6 badges por card por espacio visual.
// - link: link "Ver cómo funciona →" — opcional
const TINT_RE = /^tint-(blue|amber|green|purple|cyan|pink|orange)$/;
const ICON_KEY_MODULOS = /^(inventario|cotizador|cuentascc|cajas|usados|comprobantes|envios)$/;
const moduloBadgeSchema = z.object({
  text: z.string().trim().min(1, 'Badge vacío').max(40, 'Badge muy largo'),
  hi:   z.boolean().optional(),
}).strict();
const moduloLinkSchema = z.object({
  text: z.string().trim().min(1).max(40),
  href: z.string().trim().min(1).max(200),
}).strict();
const moduloItemSchema = z.object({
  id:      z.string().regex(uuidLoose).optional(),
  n:       z.string().trim().min(1).max(3, 'n máx 3 chars (01-99)'),
  tint:    z.string().regex(TINT_RE, 'tint inválido (blue|amber|green|purple|cyan|pink|orange)'),
  title:   z.string().trim().min(3).max(60, 'Title máx 60'),
  body:    z.string().trim().min(3).max(400, 'Body máx 400'),
  iconKey: z.string().regex(ICON_KEY_MODULOS, 'iconKey inválido'),
  wide:    z.boolean().optional(),
  badges:  z.array(moduloBadgeSchema).max(6, 'Máx 6 badges').optional(),
  link:    moduloLinkSchema.optional(),
}).strict();

// ComoFunciona.astro — 4 steps
// icon: ID SVG (uno de los 4: inventario, venta, saldos, metricas)
const ICON_KEY_COMO = /^(inventario|venta|saldos|metricas)$/;
const comoFuncionaItemSchema = z.object({
  id:    z.string().regex(uuidLoose).optional(),
  n:     z.string().trim().min(1).max(3),
  title: z.string().trim().min(3).max(60),
  body:  z.string().trim().min(3).max(300),
  icon:  z.string().regex(ICON_KEY_COMO, 'icon inválido (inventario|venta|saldos|metricas)'),
}).strict();

// CanjeUsados.astro — 2 arrays anidados: steps (3) + catalogo (5)
const canjeStepSchema = z.object({
  id:    z.string().regex(uuidLoose).optional(),
  n:     z.string().trim().min(1).max(3),
  title: z.string().trim().min(3).max(80),
  body:  z.string().trim().min(3).max(300),
}).strict();
const canjeCatalogoItemSchema = z.object({
  id:     z.string().regex(uuidLoose).optional(),
  modelo: z.string().trim().min(1).max(60),
  cap:    z.string().trim().min(1).max(20),
  bat:    z.string().trim().min(1).max(10),
  toma:   z.string().trim().min(1).max(20),
}).strict();
const canjeSchema = z.object({
  steps:    z.array(canjeStepSchema).max(6, 'Máx 6 steps').optional(),
  catalogo: z.array(canjeCatalogoItemSchema).max(20, 'Máx 20 filas de catálogo').optional(),
}).strict();

// TusDatos.astro — 3 pilares (backups + export + soft-delete)
const tusDatosItemSchema = z.object({
  id:    z.string().regex(uuidLoose).optional(),
  title: z.string().trim().min(3).max(50),
  body:  z.string().trim().min(3).max(300),
}).strict();

// FeatureHighlight.astro (Cotizador) — catálogo + recargos
// productos: max 20 (razonable para un demo mock; más satura el <select>)
// recargos: 3 valores en %, entre 0 y 200 (defensa contra typo tipo 3000%)
const cotizadorProductoSchema = z.object({
  id:    z.string().regex(uuidLoose).optional(),
  label: z.string().trim().min(1).max(60),
  usd:   z.number().min(1, 'USD debe ser ≥ 1').max(20000, 'USD demasiado alto'),
}).strict();
const cotizadorRecargosSchema = z.object({
  transferencia: z.number().min(0).max(200).optional(),
  cuotas_3:      z.number().min(0).max(200).optional(),
  cuotas_6:      z.number().min(0).max(200).optional(),
}).strict();
const cotizadorSchema = z.object({
  productos: z.array(cotizadorProductoSchema).max(20, 'Máx 20 productos').optional(),
  recargos:  cotizadorRecargosSchema.optional(),
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
    // 2026-07-26 (audit 07-25 Track D P1-1): defense-in-depth XSS.
    // Zod's `.url()` acepta `javascript:alert(1)` (URL válida per WHATWG),
    // pero al renderear en `<a href={...}>` de Landing.jsx, React NO
    // sanitiza esquemas peligrosos. Un super-admin comprometido (o
    // supply chain attack) podía persistir un javascript: URL que
    // ejecutaría en cada visitante de la landing. Refine restringe a
    // esquemas seguros (http, https). Ver Landing.jsx: fallback rendered
    // como <span> si el URL no es http(s).
    z.string().trim().url('URL inválida').max(500).refine(
      (u) => /^https?:\/\//i.test(u),
      { message: 'URL debe empezar con http:// o https://' }
    ),
    z.literal(''),
    z.null(),
  ]).optional(),
  // 2026-08-07 (feedback Lucas): link a Google Maps del negocio en la card
  // Ubicación. Misma protección XSS que instagram_url — el hidrator del
  // landing solo acepta href http(s), pero defense-in-depth acá tampoco
  // molesta. Max 500 porque los URLs de Google Maps con lat/lng codificado
  // pueden ser largos (~300-400 chars típico).
  contact_address_map_url: z.union([
    z.string().trim().url('URL inválida').max(500).refine(
      (u) => /^https?:\/\//i.test(u),
      { message: 'URL debe empezar con http:// o https://' }
    ),
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

  // 2026-08-06 CMS Landing Fase 5: 5 secciones adicionales editables.
  // - modulos: los 7 cards de "Los módulos" (max 12 por si Lucas suma en el futuro)
  // - como_funciona: 4 steps (max 6)
  // - canje: objeto con {steps, catalogo}
  // - tus_datos: 3 pilares (max 6)
  // - cotizador: objeto con {productos, recargos}
  // Todos opcionales — null/no-viene → landing usa fallback hardcoded del design.
  modulos:        z.array(moduloItemSchema).max(12, 'Máx 12 módulos').optional(),
  como_funciona:  z.array(comoFuncionaItemSchema).max(6, 'Máx 6 steps').optional(),
  canje:          canjeSchema.optional(),
  tus_datos:      z.array(tusDatosItemSchema).max(6, 'Máx 6 pilares').optional(),
  cotizador:      cotizadorSchema.optional(),
}).strict().refine(
  // Al menos un campo debe venir. Sin esto, PATCH con body {} pasaría el
  // Zod y haría un UPDATE no-op — patrón consistente con schemas del resto
  // del portal (schemas/cajas, schemas/contactos, etc.).
  (d) => Object.keys(d).length > 0,
  { message: 'Al menos un campo es requerido para actualizar' }
);

// 2026-07-18 (CMS Landing Fase 4): "Empresas que confiaron en Tecny".
// POST /api/super-admin/trusted-companies — crear un logo nuevo.
// El frontend convierte el file a base64 antes de mandar.
//
// Límites de tamaño defensivos (protegen a PostgreSQL cuando driver=db, donde
// el base64 vive en la columna TEXT):
//   · nombre: 1-120 chars (razas típicas de nombres de empresa; suficiente
//     para "SociedadAnónima" con espacios).
//   · logo_data: base64, hard-cap ~4MB (base64 x 4/3 ≈ 5.4MB) — cubre logos
//     PNG de retina densidad + SVG con embedded fonts. Rechazamos más grande
//     para no dejar 20MB en la row (el admin siempre puede optimizar antes).
//   · logo_mime: solo image/*. SVG explícitamente incluido (algunos backends
//     lo rechazan por XSS de <script>; sanitizamos vía Content-Type headers
//     y CSP del sitio público, no acá).
const MIME_LOGO_RE = /^image\/(png|jpeg|jpg|gif|webp|svg\+xml)$/;
const createTrustedCompanySchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(120, 'Nombre muy largo (máx 120)'),
  logo_data: z.string().min(1, 'logo_data requerido')
    .max(5_600_000, 'Logo muy pesado (máx ~4MB). Optimizá antes de subir.'),
  logo_mime: z.string().regex(MIME_LOGO_RE,
    'Formato de imagen no soportado. Usá PNG, JPG, WebP, GIF o SVG.'),
  logo_nombre: z.string().trim().max(255, 'Nombre de archivo muy largo').optional(),
}).strict();

// PATCH /api/super-admin/trusted-companies/:id — editar nombre y/o posición.
// Position se usa para reordenar (flechas ↑↓ en el admin). Al menos un campo
// debe venir; sin eso el UPDATE sería no-op silencioso.
const updateTrustedCompanySchema = z.object({
  nombre:   z.string().trim().min(1, 'Nombre requerido').max(120, 'Nombre muy largo (máx 120)').optional(),
  position: z.number().int().min(0).max(9999).optional(),
}).strict().refine(
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

// ── Feature flags per-tenant — F2 (Rec proactiva #3, 2026-07-20) ────────

// PATCH /api/super-admin/features/:name — editar flag global (rollout_pct,
// description, enabled). Todos opcionales — al menos uno requerido.
//
// rollout_pct: null → sin rollout, se usa enabled global. 0-100 → porcentaje
// determinístico via hash. Ver `lib/featureFlags.js` bucketFor.
const patchFeatureFlagSchema = z.object({
  enabled:     z.boolean().optional(),
  rollout_pct: z.union([z.number().int().min(0).max(100), z.null()]).optional(),
  description: z.union([z.string().trim().max(500), z.null()]).optional(),
}).strict().refine(
  (d) => Object.keys(d).length > 0,
  { message: 'Al menos un campo es requerido' }
);

// POST /api/super-admin/features/:name/tenants/:tenantId — upsert override
// por tenant. `reason` opcional pero recomendado (audit trail más útil).
const upsertTenantOverrideSchema = z.object({
  enabled: z.boolean(),
  reason:  z.union([z.string().trim().max(200), z.null()]).optional(),
}).strict();

// POST /api/super-admin/features/:name/plans/:planId — upsert override por
// plan. plan_id valida contra PLANES.
const upsertPlanOverrideSchema = z.object({
  enabled: z.boolean(),
}).strict();

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
  // CMS Landing Fase 4 — Empresas que confiaron
  createTrustedCompanySchema,
  updateTrustedCompanySchema,
  // Feature flags per-tenant — F2 (Rec proactiva #3)
  patchFeatureFlagSchema,
  upsertTenantOverrideSchema,
  upsertPlanOverrideSchema,
};

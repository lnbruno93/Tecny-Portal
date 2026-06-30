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

// PATCH /api/super-admin/tc-defaults-pais — actualizar TC default por país
// (Multi-país F2). El super-admin ajusta el valor pre-rellenado en formularios
// de TODOS los tenants del país (ARS/USD para AR, UYU/USD para UY).
//
// pais: enum cerrado ('AR' | 'UY') — matchea el CHECK de la columna.
// par: enum cerrado por país; el handler hace el cross-check pais↔par.
// valor: positivo, max 1M (sanity cap — un TC arriba de 1M es claramente bug
//   de carga humana, ni hiperinflación cubre eso).
// reason: opcional, va al audit trail.
const updateTcDefaultPaisSchema = z.object({
  pais:   z.enum(['AR', 'UY']),
  par:    z.enum(['ARS/USD', 'UYU/USD']),
  valor:  z.coerce.number().positive().max(1_000_000),
  reason: z.string().max(500).optional(),
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

module.exports = {
  PLANES,
  patchTenantSchema,
  extendTrialSchema,
  suspendTenantSchema,
  reactivateTenantSchema,
  setPaidUntilSchema,
  deleteTenantSchema,
  createTenantSchema,
  patchPlanPriceSchema,
  updateTcDefaultPaisSchema,
  changePaisSchema,
};

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

// PATCH /api/super-admin/tenants/:id — mutate genérico.
// Todos los campos opcionales (al menos uno debe estar set, validado abajo).
const patchTenantSchema = z.object({
  plan:             z.enum(PLANES).optional(),
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
    const mutables = ['plan', 'suspended_at', 'suspended_reason',
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

module.exports = {
  PLANES,
  patchTenantSchema,
  extendTrialSchema,
  suspendTenantSchema,
  reactivateTenantSchema,
};

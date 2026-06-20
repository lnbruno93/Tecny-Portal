/**
 * planPricing — fuente única del precio USD/mes por plan.
 *
 * Usado por:
 *   - /api/admin/metrics: cálculo de MRR total.
 *   - /api/admin/tenants: cálculo de MRR per-tenant en el listado.
 *
 * Diseño (#353 Fase 1):
 *   - PLACEHOLDERS en $0 hasta que Lucas decida precios finales. El doc
 *     de diseño dejó esto como open question — la herramienta sirve sin
 *     precios reales (MRR muestra $0). Cuando Lucas pase los valores
 *     finales, cambiar acá y el resto del sistema queda al día.
 *   - `enterprise` siempre = null acá → se lee de `tenants.custom_mrr_usd`
 *     que el admin setea per-tenant al onboardear cuentas enterprise.
 *
 * Por qué no en DB (al menos por ahora):
 *   Mientras los precios estén hardcoded (no hay self-service ni billing
 *   automático), una constante JS es suficiente. Cuando integremos un
 *   payment provider (Stripe/MP), agregamos `plan_prices` con histórico
 *   (qué precio tenía cada plan en cada momento — útil para clientes
 *   "legacy" con precio viejo).
 */

const PLAN_PRICES_USD = Object.freeze({
  trial:      0,
  starter:    0, // TODO: setear precio final
  pro:        0, // TODO: setear precio final
  enterprise: null, // null = leer de tenants.custom_mrr_usd
});

/**
 * Devuelve el MRR USD/mes de un tenant dado su plan + custom_mrr_usd.
 *
 * @param {string} plan — uno de 'trial' | 'starter' | 'pro' | 'enterprise'
 * @param {number|null} customMrrUsd — solo se usa si plan === 'enterprise'
 * @returns {number} MRR del tenant en USD (0 para trial / sin precio).
 */
function getTenantMrr(plan, customMrrUsd) {
  if (plan === 'enterprise') {
    // Si no se cargó custom_mrr_usd, asumimos 0 (en práctica el admin lo
    // setea al onboardear; pero no queremos NaN en el dashboard).
    return Number(customMrrUsd) || 0;
  }
  const price = PLAN_PRICES_USD[plan];
  return typeof price === 'number' ? price : 0;
}

/**
 * Trial duration default — 14 días desde signup. Confirmado por Lucas
 * en design doc. Si se cambia, cambiar también el comentario del UI.
 */
const TRIAL_DURATION_DAYS = 14;

module.exports = {
  PLAN_PRICES_USD,
  TRIAL_DURATION_DAYS,
  getTenantMrr,
};

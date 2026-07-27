/**
 * Schemas compartidos entre módulos. Auditoría #M-07.
 *
 * Antes el refine "fecha no futura ni anterior al 2000" estaba duplicado en
 * cuentas.js, proveedores.js, cajas.js — con mensajes ligeramente distintos
 * ('anterior al año 2000' vs 'anterior al 2000'). Cualquier cambio de regla
 * obligaba a tocar N archivos.
 *
 * 2026-06-29 Multi-país F2:
 *   `MonedaEnum` centraliza el enum de monedas válidas en el sistema. Antes
 *   cada schema hardcodeaba `z.enum(['USD','ARS','USDT'])` (con variaciones).
 *   Ahora todas las rutas aceptan las 4 monedas (ARS/USDT/USD/UYU). La
 *   restricción POR PAÍS del tenant se hace en el handler vía
 *   `assertMonedaValidaParaPais` (lib/money.js) usando `req.tenantPais` —
 *   no en Zod, porque Zod no conoce el runtime context del request.
 */
const { z } = require('zod');

// Lista canónica de monedas habilitadas en el sistema (post multi-país F1).
// Orden estable para que los mensajes de error de Zod sean determinísticos.
const MONEDAS_PERMITIDAS = ['USD', 'ARS', 'USDT', 'UYU'];

const MonedaEnum = z.enum(
  MONEDAS_PERMITIDAS,
  { error: 'moneda debe ser una de: USD, ARS, USDT, UYU' }
);

// Monedas fiat locales que requieren tipo de cambio (TC) para convertirse a
// USD. USD y USDT no requieren TC (USDT es stable, se trata 1:1 con USD).
//
// 2026-07-08: antes cada schema/handler hardcodeaba `moneda === 'ARS'` para
// exigir TC — un pattern que se propagó a 6+ sitios. Al agregar UYU (multi-
// país F2), ninguno se actualizó → un tenant UY podía persistir cargos UYU
// sin TC → `toUsd(monto, 'UYU', null)` devolvía 0 → los KPIs mentían silen-
// ciosamente (dashboard mostraba $0 facturación en UYU, ganancia inflada por
// egresos "invisibles", etc). Ver `requiereTc()` abajo.
const MONEDAS_CON_TC = ['ARS', 'UYU'];

// Helper: devuelve true si `moneda` requiere TC para calcular su equivalente
// en USD. Usar en refines de schemas Zod y validaciones inline de handlers.
//
// Ejemplo:
//   .refine(d => !requiereTc(d.moneda) || (d.tc && d.tc > 0), {
//     message: 'TC requerido para montos en ARS o UYU', path: ['tc'],
//   })
function requiereTc(moneda) {
  return MONEDAS_CON_TC.includes(moneda);
}

// Fecha en string ISO (YYYY-MM-DD) que NO puede ser futura ni anterior al
// 2000-01-01. Comparación date-only contra "hoy UTC" — la misma base que usa
// el frontend con new Date().toLocaleDateString('sv').
const fechaNoFutura = z.string()
  .date('Fecha inválida — usar YYYY-MM-DD')
  .refine(d => {
    const todayUTC = new Date().toISOString().split('T')[0];
    return d >= '2000-01-01' && d <= todayUTC;
  }, 'La fecha no puede ser futura ni anterior al año 2000');

// ── Límites numéricos de Postgres ─────────────────────────────────────────
//
// 2026-07-27 (audit 07-25 Track A P2-5/P2-6): centralización del techo para
// NUMERIC(14,2) — 999_999_999_999.99 (~$1 billón). El límite es del schema
// de Postgres, no de negocio — usarlo como max defensive en cada campo que
// va a NUMERIC(14,2) evita el 500 crudo `value overflows numeric format`
// que sale al Sentry sin contexto útil.
//
// Antes estaba solo en schemas/cajas.js. Los schemas de tarjetas y
// cambio_movimientos no lo tenían — un `monto: 1e18` o `tc: 1e15` rompía
// silenciosamente en el INSERT.
//
// Ejemplo:
//   z.coerce.number().positive().max(NUMERIC_14_2_MAX, 'Monto absurdo').optional()
const NUMERIC_14_2_MAX = 999_999_999_999.99;
const NUMERIC_OVERFLOW_MSG = `Monto absurdo (>${NUMERIC_14_2_MAX.toLocaleString('en-US')}). Revisá si escribiste bien.`;

module.exports = {
  fechaNoFutura,
  MonedaEnum,
  MONEDAS_PERMITIDAS,
  MONEDAS_CON_TC,
  requiereTc,
  NUMERIC_14_2_MAX,
  NUMERIC_OVERFLOW_MSG,
};

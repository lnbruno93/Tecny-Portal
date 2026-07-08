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

module.exports = { fechaNoFutura, MonedaEnum, MONEDAS_PERMITIDAS, MONEDAS_CON_TC, requiereTc };

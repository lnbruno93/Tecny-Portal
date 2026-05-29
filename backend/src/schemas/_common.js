/**
 * Schemas compartidos entre módulos. Auditoría #M-07.
 *
 * Antes el refine "fecha no futura ni anterior al 2000" estaba duplicado en
 * cuentas.js, proveedores.js, cajas.js — con mensajes ligeramente distintos
 * ('anterior al año 2000' vs 'anterior al 2000'). Cualquier cambio de regla
 * obligaba a tocar N archivos.
 */
const { z } = require('zod');

// Fecha en string ISO (YYYY-MM-DD) que NO puede ser futura ni anterior al
// 2000-01-01. Comparación date-only contra "hoy UTC" — la misma base que usa
// el frontend con new Date().toLocaleDateString('sv').
const fechaNoFutura = z.string()
  .date('Fecha inválida — usar YYYY-MM-DD')
  .refine(d => {
    const todayUTC = new Date().toISOString().split('T')[0];
    return d >= '2000-01-01' && d <= todayUTC;
  }, 'La fecha no puede ser futura ni anterior al año 2000');

module.exports = { fechaNoFutura };

// Helpers locales del módulo Ventas. Lo que está acá NO es 100% específico
// pero tampoco está usado en otros screens hoy. Si en algún momento se reusa,
// promover a `frontend/src/lib/`.

// Símbolo de moneda — ARS = "$", UYU = "$U", USD/USDT = "u$s".
//
// 2026-07-08 (bug iOStoreUY): antes el default para todo lo que no era ARS
// era "u$s" — un pago Mercadopago UYU 2.744 se mostraba como "u$s2.744" en
// la tabla "Métodos de pago" del dashboard, dando la impresión de que eran
// dólares. Agregamos UYU al mapeo (mismo símbolo que usa lib/format.ts en
// fmtMoney para consistencia visual con Cotizador y Cambios).
export function sym(m) {
  if (m === 'ARS') return '$';
  if (m === 'UYU') return '$U';
  return 'u$s';
}

// 2026-06-10 — `toUsd` se promovió a frontend/src/lib/money.js para poder
// reusarla desde Envíos. Re-exportamos acá para no romper imports existentes
// del módulo Ventas.
export { toUsd } from '../../lib/money';

// Fecha de hoy en formato ISO YYYY-MM-DD (locale 'sv' devuelve siempre ese
// formato, sin importar timezone del browser — más confiable que toISOString).
export function todayStr() {
  return new Date().toLocaleDateString('sv');
}

// Suma N días a una fecha ISO. Devuelve YYYY-MM-DD.
// Usa T00:00:00 explícito para evitar parseo timezone-dependent.
export function shiftDate(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('sv');
}

// Primer día del mes actual en formato YYYY-MM-DD.
export function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('sv');
}

// Lunes de la semana actual en formato YYYY-MM-DD.
// `getDay()` devuelve 0=domingo..6=sábado. Ajustamos para que lunes=0
// (off = (day + 6) % 7) y restamos esos días al hoy.
export function weekStart() {
  const d = new Date();
  const off = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - off);
  return d.toLocaleDateString('sv');
}

// 2026-07-04 auditoría TANDA 0: extraído del useMemo `totales` de Ventas.jsx
// para poder testear la lógica contable sin montar el componente entero.
// Cambio importante del PR de auditoría 2026-07-04 (#506): el chequeo
// pagos-vs-venta usa BRUTO (no neto) — la comisión NO participa del "Cubierto ✓".
// La Ganancia real SÍ usa neto (para reflejar el impacto real de la comisión
// sobre el profit del negocio).
//
// Contrato:
//   Inputs:
//     cart      — array de items { cantidad, precio_vendido, costo, moneda }
//     pagos     — array de pagos { monto, moneda, tc, metodo_pago_id, es_cuenta_corriente }
//     canjes    — array de canjes { valor_toma } (asumidos USD)
//     metodos   — array de métodos de pago { id, es_tarjeta, es_financiera, comision_pct }
//     pctFinanciera — float, comisión default de financiera si el método es_financiera
//     tcVenta   — TC de la venta (para convertir montos no-USD)
//   Output: { items, cubierto, dif, canjeTotal, bruta, costoFin, real, pagosDetalle }
//
// Import de toUsd hardcoded al final del archivo para evitar circular deps
// con lib/money.js (utils.js ya re-exporta toUsd desde ahí).
export function computeVentaTotales(cart, pagos, canjes, metodos, pctFinanciera, tcVenta) {
  const tc = Number(tcVenta) || null;
  const items = (cart || []).reduce((acc, it) => {
    const qty = Number(it.cantidad) || 0;
    const precio = Number(it.precio_vendido) || 0;
    return acc + toUsdImpl(precio * qty, it.moneda, tc);
  }, 0);
  const costosUsd = (cart || []).reduce((acc, it) => {
    const qty = Number(it.cantidad) || 0;
    const costo = Number(it.costo) || 0;
    return acc + toUsdImpl(costo * qty, it.moneda, tc);
  }, 0);

  const pagosDetalle = (pagos || []).map(p => {
    const brutoUsd  = toUsdImpl(p.monto, p.moneda, p.tc || tc);
    const brutoOrig = Number(p.monto) || 0;
    let pct = 0;
    if (!p.es_cuenta_corriente && p.metodo_pago_id) {
      const m = (metodos || []).find(x => x.id === p.metodo_pago_id);
      if (m) {
        if (m.es_tarjeta && Number(m.comision_pct) > 0) pct = Number(m.comision_pct);
        else if (m.es_financiera && pctFinanciera > 0)  pct = pctFinanciera;
      }
    }
    const costoFinOrig = brutoOrig * pct / 100;
    const costoFinUsd  = brutoUsd  * pct / 100;
    const netoUsd      = brutoUsd  - costoFinUsd;
    const netoOrig     = brutoOrig - costoFinOrig;
    return { pct, brutoOrig, brutoUsd, costoFinOrig, costoFinUsd, netoOrig, netoUsd };
  });
  const brutoTotalUsd = pagosDetalle.reduce((a, d) => a + d.brutoUsd, 0);
  const netoTotalUsd  = pagosDetalle.reduce((a, d) => a + d.netoUsd,  0);
  const costoFinTotal = pagosDetalle.reduce((a, d) => a + d.costoFinUsd, 0);
  const canjeTotal    = (canjes || []).reduce((acc, c) => acc + (Number(c.valor_toma) || 0), 0);
  // Cubierto = BRUTO + canjes (chequeo pagos-vs-venta ignora comisión).
  const cubierto = brutoTotalUsd + canjeTotal;
  const bruta = items - costosUsd;
  // Ganancia real usa NETO para reflejar el impacto de la comisión.
  const real = (netoTotalUsd + canjeTotal) - costosUsd;
  return {
    items, cubierto, dif: cubierto - items, canjeTotal,
    bruta, costoFin: costoFinTotal, real, pagosDetalle,
  };
}

// Import interno inline para evitar circular con la re-export de toUsd arriba.
// Este toUsd es el mismo del lib/money.js — replicamos el import statement acá
// dentro para no depender del orden de evaluación de módulos.
import { toUsd as toUsdImpl } from '../../lib/money';

// Helpers de dinero compartidos por el módulo de ventas.

// Convierte un monto a USD. ARS usa el TC provisto; sin TC válido devuelve 0.
function toUsd(monto, moneda, tc) {
  const m = Number(monto) || 0;
  if (moneda === 'USD' || moneda === 'USDT') return m;
  if (moneda === 'ARS') return tc && Number(tc) > 0 ? m / Number(tc) : 0;
  return m;
}

// Redondeo a 2 decimales estable.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Cálculo bruto → comisión → neto usado por Tarjetas (cobros automáticos
// desde Ventas, cobros previos, edits). Antes el cálculo estaba duplicado en
// 4 lugares (lib/tarjetas.js, routes/tarjetas.js POST cobros-iniciales y
// PATCH liquidación, frontend Tarjetas.jsx). Helper único previene drift
// entre los call sites (un día alguien iba a cambiar el redondeo en un solo
// lado y romper la coherencia entre preview y persistencia).
//
//   bruto:    monto antes de comisión (positivo)
//   pct:      porcentaje 0..100 (puede ser null/undefined → asume 0)
// Devuelve { bruto, pct, comision, neto } — todos pasados por round2.
function computeNeto(bruto, pct) {
  const b = round2(Number(bruto) || 0);
  const p = round2(Number(pct) || 0);
  const comision = round2(b * p / 100);
  const neto = round2(b - comision);
  return { bruto: b, pct: p, comision, neto };
}

module.exports = { toUsd, round2, computeNeto };

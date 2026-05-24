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

module.exports = { toUsd, round2 };

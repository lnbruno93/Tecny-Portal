// Helpers locales del módulo Ventas. Lo que está acá NO es 100% específico
// pero tampoco está usado en otros screens hoy. Si en algún momento se reusa,
// promover a `frontend/src/lib/`.

// Símbolo de moneda — ARS = "$", USD/USDT = "u$s".
export function sym(m) {
  return m === 'ARS' ? '$' : 'u$s';
}

// Convierte un monto a USD usando el TC dado. Para USD/USDT devuelve el monto
// directo. Para ARS divide por el TC. Si el TC es inválido o cero, devuelve 0
// (evita divisiones que rompen UI con NaN/Infinity).
export function toUsd(monto, moneda, tc) {
  const m = Number(monto) || 0;
  if (moneda === 'USD' || moneda === 'USDT') return m;
  if (moneda === 'ARS') return tc && Number(tc) > 0 ? m / Number(tc) : 0;
  return m;
}

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

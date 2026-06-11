// Formateadores de montos y fechas — fuente única (evita duplicar `fmt`/`fmtFecha`
// en cada pantalla). Sin abreviación de miles (montos completos, separador es-AR).

// Monto en MAGNITUD (sin signo): el signo/color se muestra aparte en la UI.
// Para una venta de $45.000 → "45.000".
export function fmt(n) {
  return Math.round(Math.abs(Number(n)) || 0).toLocaleString('es-AR');
}

// Igual que `fmt` pero con 2 decimales — útil para montos donde los centavos
// importan (USD, USDT, recargos). Ej: 1234.5 → "1.234,50". Sin signo.
export function fmt2(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Monto CON signo explícito (+/−): para valores sueltos donde el signo importa
// y no hay otro indicador (ej. un "Neto"). Ej: -500 → "−500", 500 → "+500".
export function fmtSigned(n) {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toLocaleString('es-AR');
  return v < 0 ? `−${s}` : v > 0 ? `+${s}` : s;
}

// Fecha YYYY-MM-DD o ISO → dd/mm/aa (es-AR). Tolera null y formatos con/sin hora.
export function fmtFecha(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : iso + 'T00:00:00');
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// Monto con prefijo de moneda — DRY de los wrappers `money(n, moneda)` que
// vivían duplicados en Inventario.jsx y Desglose360.jsx (U-05 auditoría
// 2026-06-10). Convención visual del portal:
//   · ARS  → "$"
//   · USD  → "u$s"
//   · USDT → "USDT "  (con espacio para que no quede pegado al número)
// Cualquier moneda distinta cae al símbolo USD ("u$s") por compatibilidad
// histórica con los wrappers locales que se reemplazan acá.
// Magnitud completa (sin abreviar miles), sin signo: el signo se maneja
// aparte (fmtSigned o clases CSS .pos/.neg) — misma política que `fmt`.
export function fmtMoney(n, moneda) {
  let prefix;
  if (moneda === 'ARS') prefix = '$';
  else if (moneda === 'USDT') prefix = 'USDT ';
  else prefix = 'u$s'; // USD y default
  return prefix + fmt(n);
}

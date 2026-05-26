// Formateadores de montos y fechas — fuente única (evita duplicar `fmt`/`fmtFecha`
// en cada pantalla). Sin abreviación de miles (montos completos, separador es-AR).

// Monto en MAGNITUD (sin signo): el signo/color se muestra aparte en la UI.
// Para una venta de $45.000 → "45.000".
export function fmt(n) {
  return Math.round(Math.abs(Number(n)) || 0).toLocaleString('es-AR');
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

// Formateadores de montos y fechas — fuente única (evita duplicar `fmt`/`fmtFecha`
// en cada pantalla). Sin abreviación de miles (montos completos, separador es-AR).

// Tipo compartido para las monedas que maneja el portal. Lo exportamos desde
// acá porque `fmtMoney` lo necesita y money.ts lo reusa (DRY).
// El portal soporta los 3 oficialmente; `fmtMoney` cae a "u$s" para cualquier
// otro string por compat con wrappers locales viejos, así que el parámetro
// acepta `string` además del union para no romper call sites .js no migrados.
export type Moneda = 'ARS' | 'USD' | 'USDT';

// Cualquier cosa que pueda entrar como "monto" desde un .jsx legacy: número
// de la API, string del input, null/undefined cuando todavía no se cargó.
// Las funciones se defienden con `Number(n) || 0`.
type MontoInput = number | string | null | undefined;

// Monto en MAGNITUD (sin signo): el signo/color se muestra aparte en la UI.
// Para una venta de $45.000 → "45.000".
export function fmt(n: MontoInput): string {
  return Math.round(Math.abs(Number(n)) || 0).toLocaleString('es-AR');
}

// Igual que `fmt` pero con 2 decimales — útil para montos donde los centavos
// importan (USD, USDT, recargos). Ej: 1234.5 → "1.234,50". Sin signo.
export function fmt2(n: MontoInput): string {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Monto CON signo explícito (+/−): para valores sueltos donde el signo importa
// y no hay otro indicador (ej. un "Neto"). Ej: -500 → "−500", 500 → "+500".
export function fmtSigned(n: MontoInput): string {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toLocaleString('es-AR');
  return v < 0 ? `−${s}` : v > 0 ? `+${s}` : s;
}

// Fecha YYYY-MM-DD o ISO → dd/mm/aa (es-AR). Tolera null y formatos con/sin hora.
export function fmtFecha(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? String(iso) : iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '—';
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
// Aceptamos `string` además de `Moneda` porque los call sites legacy (.jsx)
// pasan strings sin estrechar el tipo. El default sigue siendo "u$s".
export function fmtMoney(n: MontoInput, moneda?: Moneda | string | null): string {
  let prefix: string;
  if (moneda === 'ARS') prefix = '$';
  else if (moneda === 'USDT') prefix = 'USDT ';
  else prefix = 'u$s'; // USD y default
  return prefix + fmt(n);
}

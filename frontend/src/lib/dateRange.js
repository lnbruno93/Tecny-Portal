// Helpers para los filtros de período (Hoy / Este mes / Mes pasado / Todo /
// Personalizado) usados en Financiera y Tarjetas. Extraído acá para no
// duplicar lógica (drift de bordes de mes, de zona horaria, etc.).
//
// El "preset" identifica qué cubre el rango; `desde` y `hasta` (YYYY-MM-DD)
// solo se usan cuando preset === 'custom'. El backend ya parsea DATE sin
// shift de zona (fix TZ del sprint anterior).
//
// API:
//   resolveRange(r)  → { desde, hasta }  ('todo' devuelve null/null)
//   rangeToParams(r) → objeto para query params (omite desde/hasta si son null)
//   rangeLabel(r)    → string corto para mostrar en KPIs y headers
//
// Estado típico: { preset: 'hoy'|'mes_actual'|'mes_pasado'|'todo'|'custom',
//                  desde: 'YYYY-MM-DD', hasta: 'YYYY-MM-DD' }

const todayLocal = () => new Date().toLocaleDateString('sv');

export function resolveRange(r) {
  if (r.preset === 'todo') return { desde: null, hasta: null };
  const today = todayLocal();
  if (r.preset === 'custom') return { desde: r.desde || today, hasta: r.hasta || today };
  const now = new Date();
  if (r.preset === 'mes_actual') {
    const y = now.getFullYear(), m = now.getMonth();
    return {
      desde: new Date(y, m, 1).toLocaleDateString('sv'),
      hasta: new Date(y, m + 1, 0).toLocaleDateString('sv'),
    };
  }
  if (r.preset === 'mes_pasado') {
    const y = now.getFullYear(), m = now.getMonth();
    return {
      desde: new Date(y, m - 1, 1).toLocaleDateString('sv'),
      hasta: new Date(y, m, 0).toLocaleDateString('sv'),
    };
  }
  // 'hoy' (default)
  return { desde: today, hasta: today };
}

// Construye los query params para el endpoint. Si desde/hasta son null
// (preset 'todo'), los OMITE — el backend interpreta su ausencia como
// "sin filtro de fecha" y devuelve todo el histórico.
export function rangeToParams(r) {
  const { desde, hasta } = resolveRange(r);
  const params = {};
  if (desde) params.desde = desde;
  if (hasta) params.hasta = hasta;
  return params;
}

export function rangeLabel(r) {
  if (r.preset === 'todo') return 'todo el período';
  if (r.preset === 'hoy') return 'hoy';
  if (r.preset === 'mes_actual') return 'este mes';
  if (r.preset === 'mes_pasado') return 'mes pasado';
  const { desde, hasta } = resolveRange(r);
  return desde === hasta ? desde : `${desde} → ${hasta}`;
}

// Presets para usar en las barras de UI. Cada caller hace .map() y pinta los
// botones con el mismo estilo. La forma `{ v, l }` se mantiene por compat con
// el código existente.
export const RANGE_PRESETS = [
  { v: 'hoy',         l: 'Hoy' },
  { v: 'mes_actual',  l: 'Este mes' },
  { v: 'mes_pasado',  l: 'Mes pasado' },
  { v: 'todo',        l: 'Todo el período' },
  { v: 'custom',      l: 'Personalizado' },
];

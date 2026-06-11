// Helpers numéricos compartidos para conversiones de moneda.
//
// Hygiene H1 auditoría 2026-06-06: `round2` estaba duplicado idéntico en
// Financiera.jsx, Tarjetas.jsx (y futuras pantallas USD×TC). DRY.
//
// Conversiones USD ↔ ARS reales — usamos Number.EPSILON para evitar artefactos
// de IEEE 754 (e.g. 0.1 + 0.2 = 0.30000000000000004). Math.round con + EPSILON
// es el patrón canónico para "redondear 2 decimales como espera el contador".

import type { Moneda } from './format';

// Reusable: cualquier cosa que llegue desde la API o un input — el call site
// no siempre estrecha a number. Number(x) || 0 hace la defensa.
type NumInput = number | string | null | undefined;

// Redondea a 2 decimales con guarda contra epsilon de coma flotante.
// Devuelve Number. Si la entrada no es finita, devuelve 0.
export function round2(x: NumInput): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Convierte un monto a USD usando el TC dado.
//   · USD/USDT → devuelve el monto tal cual (no necesita TC).
//   · ARS      → divide por el TC; si el TC es 0 o inválido, devuelve 0
//                (evita NaN/Infinity en la UI).
// Promovido desde frontend/src/screens/ventas/utils.js (2026-06-10) para
// poder reusarlo desde Envíos sin un cross-module import feo.
// `moneda` acepta `Moneda | string` por compat con call sites .jsx que pasan
// el valor sin estrechar el tipo (mismo patrón que fmtMoney).
export function toUsd(monto: NumInput, moneda: Moneda | string | null | undefined, tc: NumInput): number {
  const m = Number(monto) || 0;
  if (moneda === 'USD' || moneda === 'USDT') return m;
  if (moneda === 'ARS') return tc && Number(tc) > 0 ? m / Number(tc) : 0;
  return m;
}

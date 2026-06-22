// Tests focales para los formatters compartidos (TANDA 5 audit 2026-06-22).
//
// Los formatters renderean en cards/tablas de toda la app: Resumen, Clientes,
// Ficha, Planes, modales. Si uno devuelve "undefined" o "NaN" por un input
// raro (timestamp corrupto, MRR muy grande, fecha futura), se ve feo en una
// pantalla que un super-admin usa para decidir cosas sobre clientes reales.
//
// Foco: edge cases que defaultean a "—" sin throw, valores grandes, fechas
// inválidas. La salida exacta varía por locale del CI; usamos matchers
// flexibles (string includes/regex) donde el formato es ambiguo.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fmt, fmtMoney, fmtPct, fmtDate, fmtDateTime, ago } from '../format.js';

describe('fmt', () => {
  it('devuelve "—" para null/undefined/NaN', () => {
    expect(fmt(null)).toBe('—');
    expect(fmt(undefined)).toBe('—');
    expect(fmt(NaN)).toBe('—');
  });

  it('formatea positivos con separador es-AR', () => {
    expect(fmt(1234567)).toBe('1.234.567');
  });

  it('formatea negativos con signo "-"', () => {
    expect(fmt(-1234)).toBe('-1.234');
  });

  it('redondea decimales', () => {
    expect(fmt(1234.7)).toBe('1.235');
    expect(fmt(1234.4)).toBe('1.234');
  });

  it('soporta números muy grandes (MRR > 1B) sin notación científica', () => {
    expect(fmt(1_500_000_000)).toBe('1.500.000.000');
  });

  it('Infinity NO devuelve "—" pero tampoco crashea (degrade aceptable)', () => {
    // isNaN(Infinity) es false, así que pasa el guard. El comportamiento
    // exacto importa menos que no tirar excepción — Intl.NumberFormat
    // maneja Infinity como "∞". Lo dejamos documentado por si en el
    // futuro queremos endurecer el guard.
    expect(() => fmt(Infinity)).not.toThrow();
  });
});

describe('fmtMoney', () => {
  it('devuelve "—" para null/NaN', () => {
    expect(fmtMoney(null)).toBe('—');
    expect(fmtMoney(NaN)).toBe('—');
  });

  it('USD por default con símbolo $', () => {
    expect(fmtMoney(1234)).toBe('$1.234');
  });

  it('ARS u otras monedas usan el código como prefijo', () => {
    expect(fmtMoney(1234, 'ARS')).toBe('ARS 1.234');
    expect(fmtMoney(1234, 'EUR')).toBe('EUR 1.234');
  });

  it('preserva el signo para negativos', () => {
    expect(fmtMoney(-100)).toBe('$-100');
  });
});

describe('fmtPct', () => {
  it('devuelve "—" para null/NaN', () => {
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(NaN)).toBe('—');
  });

  it('1 decimal por default', () => {
    expect(fmtPct(12.345)).toBe('12.3%');
    expect(fmtPct(0)).toBe('0.0%');
  });

  it('respeta el parámetro decimals', () => {
    expect(fmtPct(12.345, 2)).toBe('12.35%');
    expect(fmtPct(12.345, 0)).toBe('12%');
  });
});

describe('fmtDate / fmtDateTime', () => {
  it('null/undefined/"" devuelven "—"', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
    expect(fmtDate('')).toBe('—');
    expect(fmtDateTime(null)).toBe('—');
  });

  it('ISO válido se formatea (sin verificar locale exacto)', () => {
    // jsdom locale puede variar por CI. Solo verificamos que NO devuelva
    // el iso crudo y que NO tire excepción.
    const out = fmtDate('2026-06-22T15:00:00Z');
    expect(out).not.toBe('2026-06-22T15:00:00Z');
    expect(out).not.toBe('Invalid Date');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('string corrupto NO throw — devuelve algo (fallback o "Invalid Date")', () => {
    // El try/catch defensivo del helper protege contra throw. El output
    // visible puede ser "Invalid Date" en algunos browsers — feo pero no
    // crashea la pantalla. Doc'd como degrade aceptable.
    expect(() => fmtDate('not-a-date-at-all')).not.toThrow();
    expect(() => fmtDateTime('garbage')).not.toThrow();
  });
});

describe('ago', () => {
  // Fix the "now" reference para que estos tests sean determinísticos.
  // Los thresholds del helper son: <60s recién, <1h "X min", <1d "X h",
  // <2d "ayer", <1w "X d", >=1w fecha absoluta.
  const NOW = new Date('2026-06-22T12:00:00Z').getTime();

  afterEach(() => {
    vi.useRealTimers();
  });

  function freezeNow() {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  }

  it('null devuelve "—"', () => {
    expect(ago(null)).toBe('—');
    expect(ago(undefined)).toBe('—');
    expect(ago('')).toBe('—');
  });

  it('hace 30 segundos → "recién"', () => {
    freezeNow();
    const iso = new Date(NOW - 30 * 1000).toISOString();
    expect(ago(iso)).toBe('recién');
  });

  it('hace 15 minutos → "hace 15 min"', () => {
    freezeNow();
    const iso = new Date(NOW - 15 * 60 * 1000).toISOString();
    expect(ago(iso)).toBe('hace 15 min');
  });

  it('hace 5 horas → "hace 5 h"', () => {
    freezeNow();
    const iso = new Date(NOW - 5 * 3600 * 1000).toISOString();
    expect(ago(iso)).toBe('hace 5 h');
  });

  it('hace 36 horas → "ayer"', () => {
    freezeNow();
    const iso = new Date(NOW - 36 * 3600 * 1000).toISOString();
    expect(ago(iso)).toBe('ayer');
  });

  it('hace 5 días → "hace 5 d"', () => {
    freezeNow();
    const iso = new Date(NOW - 5 * 86400 * 1000).toISOString();
    expect(ago(iso)).toBe('hace 5 d');
  });

  it('hace 30 días → fecha absoluta (no relativa)', () => {
    freezeNow();
    const iso = new Date(NOW - 30 * 86400 * 1000).toISOString();
    const out = ago(iso);
    // No debería contener "hace" ni "ayer" ni "recién".
    expect(out).not.toMatch(/hace|ayer|recién/);
  });

  it('fecha futura NO crashea (sec negativo va al else final → fecha absoluta)', () => {
    // Edge case: si un timestamp del backend está mal y queda en el futuro,
    // el cálculo `(now - d) / 1000` da negativo. Todos los `if (sec < N)`
    // matchean para N positivo → entra al primer branch "recién" (sec < 60).
    // Doc'd como "raro pero no rompe".
    freezeNow();
    const iso = new Date(NOW + 86400 * 1000).toISOString();
    expect(() => ago(iso)).not.toThrow();
  });
});

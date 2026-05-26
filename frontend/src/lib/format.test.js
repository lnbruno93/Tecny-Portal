import { describe, it, expect } from 'vitest';
import { fmt, fmtSigned, fmtFecha } from './format';

describe('format', () => {
  it('fmt: monto completo en magnitud, sin abreviar', () => {
    expect(fmt(45000)).toBe('45.000');
    expect(fmt(1234567)).toBe('1.234.567');
    expect(fmt(-500)).toBe('500');   // magnitud (el signo se muestra aparte)
    expect(fmt(0)).toBe('0');
    expect(fmt(null)).toBe('0');
    expect(fmt('abc')).toBe('0');
  });

  it('fmtSigned: signo explícito', () => {
    expect(fmtSigned(500)).toBe('+500');
    expect(fmtSigned(-500)).toBe('−500'); // signo menos tipográfico
    expect(fmtSigned(0)).toBe('0');
    expect(fmtSigned(1234)).toBe('+1.234');
  });

  it('fmtFecha: YYYY-MM-DD e ISO → dd/mm/aa', () => {
    expect(fmtFecha('2026-05-26')).toBe('26/05/26');
    expect(fmtFecha('2026-05-26T03:00:00.000Z')).toMatch(/^\d{2}\/\d{2}\/26$/);
    expect(fmtFecha(null)).toBe('—');
    expect(fmtFecha('basura')).toBe('—');
  });
});

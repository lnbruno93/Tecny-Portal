import { describe, it, expect } from 'vitest';
import { fmt, fmtSigned, fmtFecha, fmtMoney, fmtImei } from './format';

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

  it('fmtMoney: prefijo según moneda', () => {
    expect(fmtMoney(45000, 'ARS')).toBe('$45.000');
    expect(fmtMoney(950, 'USD')).toBe('u$s950');
    expect(fmtMoney(100, 'USDT')).toBe('USDT 100');
    expect(fmtMoney(0, 'ARS')).toBe('$0');
    expect(fmtMoney(null, 'USD')).toBe('u$s0');
    // Moneda desconocida → cae al símbolo USD por compat con wrappers locales viejos.
    expect(fmtMoney(50, 'EUR')).toBe('u$s50');
  });

  // 2026-06-29 Multi-país F3: UYU para tenants UY. Convención visual: "$U"
  // (sin espacio) para diferenciar del "$" argentino sin gastar ancho extra
  // en grillas densas. Mismo separador miles que ARS (locale es-AR reusado).
  it('fmtMoney: UYU usa símbolo $U y mismo separador que ARS', () => {
    expect(fmtMoney(1234.56, 'UYU')).toBe('$U1.235');  // fmt redondea a entero
    expect(fmtMoney(45000, 'UYU')).toBe('$U45.000');
    expect(fmtMoney(0, 'UYU')).toBe('$U0');
    expect(fmtMoney(null, 'UYU')).toBe('$U0');
    expect(fmtMoney(-500, 'UYU')).toBe('$U500'); // magnitud, sin signo
  });

  // 2026-07-04: IMEI en notación científica desde XLSX importado (Google Sheets
  // guarda enteros de 15 dígitos como float con notación científica).
  it('fmtImei: convierte notación científica a dígitos limpios', () => {
    expect(fmtImei('3.50332842758552E14')).toBe('350332842758552');
    expect(fmtImei('3.53242103343951E14')).toBe('353242103343951');
    expect(fmtImei('3.52574677881995E14')).toBe('352574677881995');
    expect(fmtImei('1.23E15')).toBe('1230000000000000');
    // Con e minúscula también
    expect(fmtImei('3.5e14')).toBe('350000000000000');
  });

  it('fmtImei: IMEI normal pasa sin cambio (idempotente)', () => {
    expect(fmtImei('356938035643809')).toBe('356938035643809');
    expect(fmtImei('  356938035643809  ')).toBe('356938035643809'); // trim
    expect(fmtImei('')).toBe('');
    expect(fmtImei(null)).toBe('');
    expect(fmtImei(undefined)).toBe('');
  });

  it('fmtImei: serial alfanumérico pasa sin cambio', () => {
    expect(fmtImei('SJW0KF7C5P6')).toBe('SJW0KF7C5P6');
    expect(fmtImei('SKCFDW2WQ4T')).toBe('SKCFDW2WQ4T');
  });

  it('fmtImei: números pasados como number type se convierten a string', () => {
    expect(fmtImei(350332842758552)).toBe('350332842758552');
  });
});

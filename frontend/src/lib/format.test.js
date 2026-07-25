import { describe, it, expect } from 'vitest';
import { fmt, fmtSigned, fmtSignedParts, fmtFecha, fmtMoney, fmtImei } from './format';

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

  // 2026-07-25 fix P0 bug: fmtSignedParts descompone en sign/magnitude/cls
  // para renderizar montos que pueden ser +/− con signo visible + color
  // CSS correcto. Bug reportado por cliente: ganancia_neta_usd = -19 se
  // mostraba como "u$s19" en verde (className="pos" hardcoded + fmt magnitud).
  describe('fmtSignedParts', () => {
    it('positivo → sin signo, cls="pos"', () => {
      expect(fmtSignedParts(500)).toEqual({ sign: '', magnitude: '500', cls: 'pos' });
      expect(fmtSignedParts(1234)).toEqual({ sign: '', magnitude: '1.234', cls: 'pos' });
    });

    it('negativo → signo "−" (U+2212), cls="neg"', () => {
      expect(fmtSignedParts(-19)).toEqual({ sign: '−', magnitude: '19', cls: 'neg' });
      expect(fmtSignedParts(-1500)).toEqual({ sign: '−', magnitude: '1.500', cls: 'neg' });
    });

    it('cero → sin signo, cls="pos" (verde tenue, no hay pérdida)', () => {
      expect(fmtSignedParts(0)).toEqual({ sign: '', magnitude: '0', cls: 'pos' });
    });

    it('null / undefined / string inválido → { sign:"", magnitude:"0", cls:"pos" }', () => {
      expect(fmtSignedParts(null)).toEqual({ sign: '', magnitude: '0', cls: 'pos' });
      expect(fmtSignedParts(undefined)).toEqual({ sign: '', magnitude: '0', cls: 'pos' });
      expect(fmtSignedParts('abc')).toEqual({ sign: '', magnitude: '0', cls: 'pos' });
    });

    it('string numérico → parsea', () => {
      expect(fmtSignedParts('-19')).toEqual({ sign: '−', magnitude: '19', cls: 'neg' });
      expect(fmtSignedParts('42')).toEqual({ sign: '', magnitude: '42', cls: 'pos' });
    });

    // El signo usa U+2212 MINUS SIGN (no U+002D HYPHEN-MINUS ASCII) — misma
    // convención que fmtSigned. Test explícito para catchar regresiones si
    // alguien cambia el minus por ASCII (visual sutil pero rompe alineación
    // en fonts monoespaciadas).
    it('signo negativo usa U+2212 MINUS SIGN (no ASCII hyphen)', () => {
      const { sign } = fmtSignedParts(-1);
      expect(sign).toBe('−');
      expect(sign).not.toBe('-'); // ASCII hyphen U+002D
    });

    // Fix root case del bug: ganancia_neta_usd = -19 (backend calcula bien),
    // pero fmt() devuelve "19" y className="pos" muestra verde. Este test
    // documenta la fórmula correcta para renderizar el KPI:
    //   <span className={cls}>{sign}u$s{magnitude}</span>  → "−u$s19" (rojo)
    it('caso del bug reportado 2026-07-25: -19 → sign="−", magnitude="19", cls="neg"', () => {
      const { sign, magnitude, cls } = fmtSignedParts(-19);
      expect(`${sign}u$s${magnitude}`).toBe('−u$s19');
      expect(cls).toBe('neg');
    });
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

/**
 * Tests unitarios de sanitizeForPdf (Externa P1-5 audit 2026-07-12).
 *
 * Verifica que:
 *   · Control chars se strippan (\x00-\x1F menos \n, \t).
 *   · RTL override chars se strippan (spoofing filename/layout).
 *   · Runs de \n colapsan.
 *   · Truncado a maxLen preserva ellipsis.
 *   · Null/undefined → string vacío.
 */

const { _sanitizeForPdf: sanitizeForPdf } = require('../src/lib/comprobantePdf');

describe('sanitizeForPdf — Externa P1-5', () => {
  it('preserva strings normales sin cambios', () => {
    expect(sanitizeForPdf('iPhone 15 Pro')).toBe('iPhone 15 Pro');
    expect(sanitizeForPdf('Cliente: Juan Pérez')).toBe('Cliente: Juan Pérez');
    expect(sanitizeForPdf('Notas con acento: ñ, á, é')).toBe('Notas con acento: ñ, á, é');
  });

  it('strip control chars (\\x00-\\x1F) excepto \\n y \\t', () => {
    expect(sanitizeForPdf('hola\x00mundo')).toBe('holamundo');
    expect(sanitizeForPdf('a\x1Bb\x07c')).toBe('abc');
    // \n (\x0A) y \t (\x09) se preservan
    expect(sanitizeForPdf('linea1\nlinea2')).toBe('linea1\nlinea2');
    expect(sanitizeForPdf('col1\tcol2')).toBe('col1\tcol2');
  });

  it('strip RTL override + directional isolate chars (spoofing)', () => {
    // U+202E (RLO) usado para spoofing "iPhonefdp.21" → "iPhone12.pdf"
    expect(sanitizeForPdf('iPhone‮21.pdf')).toBe('iPhone21.pdf');
    expect(sanitizeForPdf('legit⁦hidden⁩')).toBe('legithidden');
  });

  it('colapsa runs de 3+ \\n a solo \\n\\n', () => {
    expect(sanitizeForPdf('a\n\n\n\n\nb')).toBe('a\n\nb');
    // 2 \n se preserva (no colapsa)
    expect(sanitizeForPdf('a\n\nb')).toBe('a\n\nb');
    // Escenario adversarial: 100 \n
    expect(sanitizeForPdf('start' + '\n'.repeat(100) + 'end')).toBe('start\n\nend');
  });

  it('trunca a maxLen y agrega ellipsis', () => {
    const long = 'x'.repeat(300);
    const result = sanitizeForPdf(long, { maxLen: 100 });
    expect(result.length).toBe(100);
    expect(result.endsWith('…')).toBe(true);
  });

  it('maxLen respeta el default de 200', () => {
    const long = 'a'.repeat(500);
    const result = sanitizeForPdf(long);
    expect(result.length).toBe(200);
  });

  it('null/undefined → string vacío', () => {
    expect(sanitizeForPdf(null)).toBe('');
    expect(sanitizeForPdf(undefined)).toBe('');
    expect(sanitizeForPdf('')).toBe('');
  });

  it('coerce non-strings a string', () => {
    expect(sanitizeForPdf(123)).toBe('123');
    expect(sanitizeForPdf(true)).toBe('true');
  });

  it('escenario adversarial combinado', () => {
    // Tenant llamado con control chars + RTL + newlines infinitos + muy largo
    const evil = 'iPro\x00Reseller‮' + '\n'.repeat(50) + 'x'.repeat(500);
    const result = sanitizeForPdf(evil, { maxLen: 100 });
    expect(result).not.toContain('\x00');
    expect(result).not.toContain('‮');
    expect(result).not.toContain('\n\n\n');
    expect(result.length).toBeLessThanOrEqual(100);
  });
});

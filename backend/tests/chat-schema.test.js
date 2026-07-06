/**
 * Tests unitarios del schema Zod del chat (`src/schemas/chat.js`).
 *
 * Foco de esta ronda (audit 2026-07-06 P1 — prompt injection hardening):
 *   - Verificar el strip de control chars antes del trim.
 *   - Verificar que los chars visibles y espacios se preservan.
 *   - Regresión: max length + trim + refine no-empty siguen funcionando.
 */

const {
  sendMessageSchema,
  MAX_USER_MESSAGE_CHARS,
} = require('../src/schemas/chat');

describe('sendMessageSchema — validaciones básicas (regresión)', () => {
  it('acepta texto normal', () => {
    const r = sendMessageSchema.parse({ text: 'Hola bot, ¿cuánto vendí hoy?' });
    expect(r.text).toBe('Hola bot, ¿cuánto vendí hoy?');
  });

  it('rechaza texto vacío', () => {
    expect(() => sendMessageSchema.parse({ text: '' })).toThrow();
  });

  it('rechaza texto que solo tiene espacios (post-trim)', () => {
    expect(() => sendMessageSchema.parse({ text: '   \t  \n ' })).toThrow();
  });

  it('rechaza texto que excede el máximo', () => {
    const tooLong = 'a'.repeat(MAX_USER_MESSAGE_CHARS + 1);
    expect(() => sendMessageSchema.parse({ text: tooLong })).toThrow();
  });

  it('rechaza campos extra (.strict)', () => {
    expect(() =>
      sendMessageSchema.parse({ text: 'hola', extra: 'field' })
    ).toThrow();
  });
});

describe('sendMessageSchema — prompt injection strip (audit 2026-07-06)', () => {
  it('strippea null bytes \\x00', () => {
    const r = sendMessageSchema.parse({ text: 'hola\x00mundo' });
    expect(r.text).toBe('holamundo');
    expect(r.text).not.toContain('\x00');
  });

  it('strippea ESC/CSI de ANSI (\\x1B[)', () => {
    const r = sendMessageSchema.parse({ text: 'texto\x1B[31m rojo\x1B[0m' });
    expect(r.text).toBe('texto[31m rojo[0m'); // ESC removido, resto queda
  });

  it('strippea el rango 0x00-0x08 (BEL, BS, etc.)', () => {
    const r = sendMessageSchema.parse({ text: '\x01\x02\x03\x04\x05\x06\x07\x08hola' });
    expect(r.text).toBe('hola');
  });

  it('strippea DEL (\\x7F)', () => {
    const r = sendMessageSchema.parse({ text: 'hola\x7Fmundo' });
    expect(r.text).toBe('holamundo');
  });

  it('preserva \\n, \\t, \\r (útiles para formateo)', () => {
    const r = sendMessageSchema.parse({ text: 'línea 1\nlínea 2\tcolumna\rretorno' });
    // \n, \t, \r se conservan; trim solo pela los espacios de los extremos.
    expect(r.text).toBe('línea 1\nlínea 2\tcolumna\rretorno');
  });

  it('preserva emojis + unicode', () => {
    const r = sendMessageSchema.parse({ text: 'hola 👋 café ñandú' });
    expect(r.text).toBe('hola 👋 café ñandú');
  });

  it('rechaza si el mensaje queda vacío tras strippear control chars', () => {
    // Un ataque teórico: mandar solo control chars para bypass del min length.
    expect(() => sendMessageSchema.parse({ text: '\x00\x01\x02\x03' })).toThrow();
  });

  it('normaliza (strip + trim) sin duplicar el post-procesado', () => {
    const r = sendMessageSchema.parse({ text: '  \x00\x00 hola \x00 ' });
    expect(r.text).toBe('hola'); // control chars + espacios de los extremos
  });
});

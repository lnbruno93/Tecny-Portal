import { describe, it, expect } from 'vitest';
import { friendlyError } from './friendlyError';

const FALLBACK = 'Hubo un problema. Probá de nuevo en un momento.';

describe('friendlyError', () => {
  it('null/undefined → fallback', () => {
    expect(friendlyError(null)).toBe(FALLBACK);
    expect(friendlyError(undefined)).toBe(FALLBACK);
  });

  it('Error sin message → fallback', () => {
    expect(friendlyError(new Error())).toBe(FALLBACK);
  });

  it('string vacío como message → fallback', () => {
    const err = new Error('');
    expect(friendlyError(err)).toBe(FALLBACK);
  });

  it('NO_AUTH se intercepta antes que llegue al toast', () => {
    // El api() wrapper tira 'NO_AUTH' en 401 + redirige vía session-expired.
    // El friendlyError NO debe filtrar 'NO_AUTH' literal al usuario.
    const err = new Error('NO_AUTH');
    expect(friendlyError(err)).toMatch(/sesión expiró/i);
    expect(friendlyError(err)).not.toMatch(/NO_AUTH/);
  });

  it('TypeError tipo "Cannot read property" → fallback genérico', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'x')");
    expect(friendlyError(err)).toBe(FALLBACK);
  });

  it('"is not a function" → fallback genérico', () => {
    const err = new TypeError('foo.bar is not a function');
    expect(friendlyError(err)).toBe(FALLBACK);
  });

  it('mensaje del backend (válido) pasa intacto', () => {
    const err = new Error('Saldo insuficiente en la caja Pesos');
    expect(friendlyError(err)).toBe('Saldo insuficiente en la caja Pesos');
  });

  it('mensaje de network del wrapper api() pasa intacto', () => {
    const err = new Error('Sin conexión con el servidor. Verificá tu red e intentá de nuevo.');
    expect(friendlyError(err)).toMatch(/sin conexión/i);
  });

  it('acepta string directo (defensivo)', () => {
    expect(friendlyError('Algún mensaje')).toBe('Algún mensaje');
    expect(friendlyError('')).toBe(FALLBACK);
  });

  it('mensaje genérico de error con palabras técnicas pero útiles pasa intacto', () => {
    // "saldo de la caja" tiene "de la" — no debe matchear ningún heurístico.
    const err = new Error('No se pudo actualizar el saldo de la caja');
    expect(friendlyError(err)).toBe('No se pudo actualizar el saldo de la caja');
  });
});

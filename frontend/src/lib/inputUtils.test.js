import { describe, it, expect, vi } from 'vitest';
import { blockInvalidNumberKeys, numberInputProps, normalizeDecimal } from './inputUtils';

function mkEvent(key, opts = {}) {
  return { key, ctrlKey: false, metaKey: false, preventDefault: vi.fn(), ...opts };
}

describe('blockInvalidNumberKeys', () => {
  it.each(['e', 'E', '+'])('bloquea la tecla %s por default', (k) => {
    const e = mkEvent(k);
    blockInvalidNumberKeys(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it.each(['0', '1', '9', '.', 'Backspace', 'ArrowLeft', 'Tab'])('deja pasar %s', (k) => {
    const e = mkEvent(k);
    blockInvalidNumberKeys(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('por default deja pasar el menos (allowNegative=true)', () => {
    const e = mkEvent('-');
    blockInvalidNumberKeys(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('con allowNegative=false bloquea el menos', () => {
    const e = mkEvent('-');
    blockInvalidNumberKeys(e, { allowNegative: false });
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it('por default deja pasar la coma (#F-3, LATAM)', () => {
    const e = mkEvent(',');
    blockInvalidNumberKeys(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('con allowComma=false bloquea la coma', () => {
    const e = mkEvent(',');
    blockInvalidNumberKeys(e, { allowComma: false });
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it('respeta ctrl/cmd combos (no bloquea Ctrl+A, Cmd+V, etc.)', () => {
    const e1 = mkEvent('a', { ctrlKey: true });
    blockInvalidNumberKeys(e1);
    expect(e1.preventDefault).not.toHaveBeenCalled();
    const e2 = mkEvent('e', { metaKey: true });
    blockInvalidNumberKeys(e2);
    expect(e2.preventDefault).not.toHaveBeenCalled();
  });
});

describe('numberInputProps', () => {
  it('devuelve type=number y un onKeyDown', () => {
    const props = numberInputProps();
    expect(props.type).toBe('number');
    expect(typeof props.onKeyDown).toBe('function');
  });

  it('el onKeyDown bloquea "e"', () => {
    const props = numberInputProps();
    const e = mkEvent('e');
    props.onKeyDown(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it('forwardea opciones (allowComma=false bloquea)', () => {
    const props = numberInputProps({ allowComma: false });
    const e = mkEvent(',');
    props.onKeyDown(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });
});

describe('normalizeDecimal', () => {
  it.each([
    ['1,50',     '1.50'],
    ['1234,5',   '1234.5'],
    ['1.234,5',  '1234.5'],  // miles+decimal es-AR
    ['1.234.567,89', '1234567.89'],
    ['1234',     '1234'],
    ['1234.5',   '1234.5'],  // ya es JS-parseable
    ['',         ''],
    ['  ',       ''],
  ])('normaliza "%s" → "%s"', (input, expected) => {
    expect(normalizeDecimal(input)).toBe(expected);
  });

  it('null y undefined → cadena vacía', () => {
    expect(normalizeDecimal(null)).toBe('');
    expect(normalizeDecimal(undefined)).toBe('');
  });

  it('input con múltiples comas y sin puntos: solo la primera se convierte (no-op semántico — input inválido del user)', () => {
    // No es nuestro problema validar formato; el usuario verá NaN al parsear.
    // Documentamos el comportamiento para que el caller sepa qué esperar.
    expect(normalizeDecimal('12,34,56')).toBe('12.34,56');
    expect(Number.isNaN(Number(normalizeDecimal('12,34,56')))).toBe(true);
  });

  it('Number(normalizeDecimal(x)) funciona para valores LATAM típicos', () => {
    expect(Number(normalizeDecimal('1,50'))).toBe(1.5);
    expect(Number(normalizeDecimal('1.234,56'))).toBe(1234.56);
    expect(Number(normalizeDecimal('0'))).toBe(0);
    // Number('') → 0 en JS (no NaN). Si querés distinguir "vacío" de "0" usá
    // !value antes de parsear. Documentamos:
    expect(Number(normalizeDecimal(''))).toBe(0);
  });
});

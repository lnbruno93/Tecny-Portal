import { describe, it, expect, vi } from 'vitest';
import { blockInvalidNumberKeys, numberInputProps } from './inputUtils';

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

  it('por default bloquea la coma', () => {
    const e = mkEvent(',');
    blockInvalidNumberKeys(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it('con allowComma=true deja pasar la coma', () => {
    const e = mkEvent(',', {});
    blockInvalidNumberKeys(e, { allowComma: true });
    expect(e.preventDefault).not.toHaveBeenCalled();
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

  it('forwardea opciones (allowComma)', () => {
    const props = numberInputProps({ allowComma: true });
    const e = mkEvent(',');
    props.onKeyDown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

// Tests del hook useFormFields (task #145, 2026-07-16).
//
// Cubre las 5 mecánicas clave:
//   1. setField actualiza form Y limpia el error del key.
//   2. validate() con validator OK devuelve true y limpia errors.
//   3. validate() con errores setea fieldErrors y devuelve false.
//   4. setFieldErrors permite inyectar errores del backend.
//   5. resetErrors limpia sin tocar form.

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useFormFields from './useFormFields';

describe('useFormFields', () => {
  it('inicializa con el form provisto y sin errores', () => {
    const { result } = renderHook(() => useFormFields({ a: '1', b: '2' }));
    expect(result.current.form).toEqual({ a: '1', b: '2' });
    expect(result.current.fieldErrors).toEqual({});
  });

  it('setField actualiza el campo Y limpia su error', () => {
    const { result } = renderHook(() => useFormFields({ a: '', b: '' }));

    // Simular error previo del validate
    act(() => { result.current.setFieldErrors({ a: 'Requerido.', b: 'Requerido.' }); });
    expect(result.current.fieldErrors).toEqual({ a: 'Requerido.', b: 'Requerido.' });

    act(() => { result.current.setField('a', 'valor'); });
    expect(result.current.form).toEqual({ a: 'valor', b: '' });
    // Error de `a` limpiado, `b` intacto
    expect(result.current.fieldErrors).toEqual({ b: 'Requerido.' });
  });

  it('validate() con validator OK devuelve true y limpia errors', () => {
    const validator = (f) => (f.a ? null : { a: 'Requerido.' });
    const { result } = renderHook(() => useFormFields({ a: 'algo' }, validator));

    // Setear errores previos
    act(() => { result.current.setFieldErrors({ a: 'viejo error' }); });
    let ok;
    act(() => { ok = result.current.validate(); });
    expect(ok).toBe(true);
    expect(result.current.fieldErrors).toEqual({});
  });

  it('validate() con validator que devuelve errores setea fieldErrors y devuelve false', () => {
    const validator = (f) => {
      const errs = {};
      if (!f.a) errs.a = 'Requerido.';
      if (!f.b) errs.b = 'También requerido.';
      return Object.keys(errs).length ? errs : null;
    };
    const { result } = renderHook(() => useFormFields({ a: '', b: '' }, validator));

    let ok;
    act(() => { ok = result.current.validate(); });
    expect(ok).toBe(false);
    expect(result.current.fieldErrors).toEqual({ a: 'Requerido.', b: 'También requerido.' });
  });

  it('validate() sin validator devuelve true (opt-in)', () => {
    const { result } = renderHook(() => useFormFields({ a: '' }));
    let ok;
    act(() => { ok = result.current.validate(); });
    expect(ok).toBe(true);
  });

  it('setFieldErrors permite inyectar errores del backend (400 con fields)', () => {
    const { result } = renderHook(() => useFormFields({ a: '' }));
    act(() => { result.current.setFieldErrors({ a: 'El backend dice que no' }); });
    expect(result.current.fieldErrors).toEqual({ a: 'El backend dice que no' });
  });

  it('resetErrors limpia errors sin tocar el form', () => {
    const { result } = renderHook(() => useFormFields({ a: 'val' }));
    act(() => { result.current.setFieldErrors({ a: 'error' }); });
    act(() => { result.current.resetErrors(); });
    expect(result.current.fieldErrors).toEqual({});
    expect(result.current.form).toEqual({ a: 'val' });
  });

  it('setForm reemplaza el form entero (para load-edit)', () => {
    const { result } = renderHook(() => useFormFields({ a: '', b: '' }));
    act(() => { result.current.setForm({ a: '1', b: '2' }); });
    expect(result.current.form).toEqual({ a: '1', b: '2' });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useLoadingAction from './useLoadingAction';

describe('useLoadingAction', () => {
  it('arranca con loading=false', () => {
    const { result } = renderHook(() => useLoadingAction());
    expect(result.current.loading).toBe(false);
  });

  it('setea loading=true durante la ejecución y false al terminar', async () => {
    const { result } = renderHook(() => useLoadingAction());
    let resolveFn;
    const promise = new Promise(r => { resolveFn = r; });

    let runPromise;
    act(() => {
      runPromise = result.current.run(() => promise);
    });
    expect(result.current.loading).toBe(true);

    await act(async () => { resolveFn('hecho'); await runPromise; });
    expect(result.current.loading).toBe(false);
  });

  it('devuelve el valor de la promise', async () => {
    const { result } = renderHook(() => useLoadingAction());
    let value;
    await act(async () => {
      value = await result.current.run(async () => 42);
    });
    expect(value).toBe(42);
  });

  it('ignora segundo click mientras está loading (anti-click-spam)', async () => {
    const { result } = renderHook(() => useLoadingAction());
    const fn = vi.fn(() => new Promise(r => setTimeout(r, 10)));

    // Disparamos el primero. NO await aún — queremos atrapar el momento loading.
    let firstPromise;
    act(() => { firstPromise = result.current.run(fn); });

    // Segundo click mientras loading=true → debería devolver undefined sin invocar.
    let second;
    await act(async () => { second = await result.current.run(fn); });
    expect(second).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => { await firstPromise; });
    expect(result.current.loading).toBe(false);
  });

  it('libera loading=false aunque la promise rechace', async () => {
    const { result } = renderHook(() => useLoadingAction());
    await act(async () => {
      await expect(
        result.current.run(() => Promise.reject(new Error('boom')))
      ).rejects.toThrow('boom');
    });
    expect(result.current.loading).toBe(false);
  });
});

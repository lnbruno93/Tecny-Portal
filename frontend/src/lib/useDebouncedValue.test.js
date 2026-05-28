import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue', () => {
  it('devuelve el valor inicial inmediatamente', () => {
    const { result } = renderHook(() => useDebouncedValue('hola', 300));
    expect(result.current).toBe('hola');
  });

  it('no actualiza hasta que pasa el delay', async () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
        initialProps: { v: 'a' },
      });
      expect(result.current).toBe('a');

      rerender({ v: 'b' });
      expect(result.current).toBe('a'); // todavía no pasó el debounce

      act(() => vi.advanceTimersByTime(150));
      expect(result.current).toBe('a');

      act(() => vi.advanceTimersByTime(150));
      expect(result.current).toBe('b'); // pasados los 300ms, ya actualizó
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancela el timer al cambiar de valor antes del delay (último valor gana)', async () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
        initialProps: { v: 'a' },
      });
      rerender({ v: 'b' });
      act(() => vi.advanceTimersByTime(200));
      rerender({ v: 'c' });
      // todavía 'a' (el de 'b' se canceló, el de 'c' arranca de cero)
      act(() => vi.advanceTimersByTime(200));
      expect(result.current).toBe('a');
      act(() => vi.advanceTimersByTime(100));
      expect(result.current).toBe('c');
    } finally {
      vi.useRealTimers();
    }
  });
});

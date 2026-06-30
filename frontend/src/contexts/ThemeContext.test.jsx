/**
 * Tests del ThemeContext (#338).
 *
 * API pública cubierta:
 *   - theme (estado actual: 'vault' | 'linen')
 *   - isDark / isLight (derivados convenientes)
 *   - setTheme(next) — set explícito, ignora valores inválidos
 *   - toggle() — alterna entre vault y linen
 *   - Persistencia en localStorage('tecny_theme')
 *   - Side-effect: documentElement.data-theme se sincroniza
 *   - Default 'vault' si no hay valor guardado
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from './ThemeContext';

function wrap({ children }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset attr del documentElement por las dudas — vitest jsdom comparte
    // el document entre tests del mismo file.
    document.documentElement.removeAttribute('data-theme');
  });

  it('default es "vault" (dark) cuando no hay valor en localStorage', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: wrap });
    expect(result.current.theme).toBe('vault');
    expect(result.current.isDark).toBe(true);
    expect(result.current.isLight).toBe(false);
  });

  it('restaura el tema guardado en localStorage al montar', () => {
    localStorage.setItem('tecny_theme', 'linen');
    const { result } = renderHook(() => useTheme(), { wrapper: wrap });
    expect(result.current.theme).toBe('linen');
    expect(result.current.isLight).toBe(true);
  });

  it('ignora valores inválidos en localStorage (cae al default)', () => {
    localStorage.setItem('tecny_theme', 'inventado');
    const { result } = renderHook(() => useTheme(), { wrapper: wrap });
    expect(result.current.theme).toBe('vault');
  });

  it('persist en localStorage cada vez que cambia', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: wrap });
    act(() => { result.current.setTheme('linen'); });
    expect(localStorage.getItem('tecny_theme')).toBe('linen');
    act(() => { result.current.setTheme('vault'); });
    expect(localStorage.getItem('tecny_theme')).toBe('vault');
  });

  it('aplica data-theme al documentElement como side effect', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: wrap });
    expect(document.documentElement.getAttribute('data-theme')).toBe('vault');
    act(() => { result.current.setTheme('linen'); });
    expect(document.documentElement.getAttribute('data-theme')).toBe('linen');
  });

  it('toggle() alterna vault ↔ linen', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: wrap });
    expect(result.current.theme).toBe('vault');
    act(() => { result.current.toggle(); });
    expect(result.current.theme).toBe('linen');
    act(() => { result.current.toggle(); });
    expect(result.current.theme).toBe('vault');
  });

  it('setTheme con valor inválido no rompe, solo warnea y mantiene estado', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useTheme(), { wrapper: wrap });
    expect(result.current.theme).toBe('vault');
    act(() => { result.current.setTheme('rainbow'); });
    expect(result.current.theme).toBe('vault'); // unchanged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Tema inválido'));
    warnSpy.mockRestore();
  });

  it('useTheme fuera del provider tira error claro', () => {
    // Suprimimos el error de React DevTools — esperamos el throw.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useTheme())).toThrow(/dentro de <ThemeProvider>/);
    errSpy.mockRestore();
  });

  // Auditoría 2026-06-30 F-22: el value del provider memoizado con useMemo.
  // Re-render sin cambios → misma referencia. Si esto rompe, todos los
  // consumers de useTheme re-renderean innecesariamente.
  it('F-22: value es referencialmente estable entre re-renders sin cambios', () => {
    const { result, rerender } = renderHook(() => useTheme(), { wrapper: wrap });
    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });
});

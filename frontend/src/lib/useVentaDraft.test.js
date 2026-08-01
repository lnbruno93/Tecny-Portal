// Tests del hook useVentaDraft (persistencia de borrador de venta).
// task #267 — bug Nook Tech: modal Nueva venta se cerraba y perdía todo.
//
// Cubre las funciones puras (readDraft, clearDraft) + smoke del hook con
// renderHook. No abrimos el modal completo (integration test) — eso lo
// cubre Ventas.test.jsx por separado.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readDraft, clearDraft, useVentaDraft } from './useVentaDraft';

const STORAGE_KEY = 'venta:draft:v1';
const TTL_MS = 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

// ── readDraft / clearDraft ──────────────────────────────────────────

describe('readDraft', () => {
  it('devuelve null si localStorage vacío', () => {
    expect(readDraft()).toBeNull();
  });

  it('devuelve el draft parseado si existe y no expiró', () => {
    const payload = { savedAt: Date.now(), state: { vForm: { fecha: '2026-07-31' } } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    const got = readDraft();
    expect(got).not.toBeNull();
    expect(got.state.vForm.fecha).toBe('2026-07-31');
  });

  it('devuelve null y limpia si el draft expiró (>24h)', () => {
    const oldPayload = { savedAt: Date.now() - TTL_MS - 1000, state: { vForm: {} } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(oldPayload));
    expect(readDraft()).toBeNull();
    // Cleanup automático — no debería quedar la basura.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('devuelve null si el JSON está corrupto', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json-{{{');
    expect(readDraft()).toBeNull();
  });

  it('devuelve null si falta savedAt o state', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: {} }));
    expect(readDraft()).toBeNull();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now() }));
    expect(readDraft()).toBeNull();
  });
});

describe('clearDraft', () => {
  it('borra el draft de localStorage', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), state: {} }));
    clearDraft();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('es idempotente si no hay draft', () => {
    expect(() => clearDraft()).not.toThrow();
  });
});

// ── useVentaDraft hook ─────────────────────────────────────────────

describe('useVentaDraft', () => {
  it('hasDraft=false si no hay draft persistente', () => {
    const { result } = renderHook(() => useVentaDraft({ enabled: true }));
    expect(result.current.hasDraft).toBe(false);
    expect(result.current.draftPreview).toBeNull();
  });

  it('hasDraft=true + draftPreview cuando enabled y hay draft', () => {
    const payload = {
      savedAt: Date.now() - 5 * 60 * 1000, // 5 min atrás
      state: { vForm: {}, cart: [{ id: 1 }, { id: 2 }, { id: 3 }], pagos: [] },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    const { result } = renderHook(() => useVentaDraft({ enabled: true }));
    expect(result.current.hasDraft).toBe(true);
    expect(result.current.draftPreview.itemsCount).toBe(3);
  });

  it('hasDraft=false si enabled=false (edit o rápida) aunque haya draft', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      savedAt: Date.now(), state: { cart: [{ id: 1 }] },
    }));
    const { result } = renderHook(() => useVentaDraft({ enabled: false }));
    expect(result.current.hasDraft).toBe(false);
  });

  it('saveDraft escribe a localStorage (debounced 500ms)', () => {
    const { result } = renderHook(() => useVentaDraft({ enabled: true }));
    act(() => {
      result.current.saveDraft({ vForm: { cliente_nombre: 'Ana' } });
    });
    // Antes del debounce: nada persistido aún.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS + 10);
    });
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(persisted.state.vForm.cliente_nombre).toBe('Ana');
  });

  it('saveDraft no persiste si enabled=false', () => {
    const { result } = renderHook(() => useVentaDraft({ enabled: false }));
    act(() => {
      result.current.saveDraft({ vForm: { cliente_nombre: 'X' } });
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS + 10);
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('restoreDraft devuelve el state y oculta el banner', () => {
    const state = { vForm: { cliente_nombre: 'Ana' }, cart: [], pagos: [] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), state }));
    const { result } = renderHook(() => useVentaDraft({ enabled: true }));
    expect(result.current.hasDraft).toBe(true);
    let restored;
    act(() => { restored = result.current.restoreDraft(); });
    expect(restored.vForm.cliente_nombre).toBe('Ana');
    expect(result.current.hasDraft).toBe(false);
  });

  it('discardDraft borra localStorage y oculta el banner', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      savedAt: Date.now(), state: { cart: [{ id: 1 }] },
    }));
    const { result } = renderHook(() => useVentaDraft({ enabled: true }));
    expect(result.current.hasDraft).toBe(true);
    act(() => { result.current.discardDraft(); });
    expect(result.current.hasDraft).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('debounce: 2 saves rápidos → 1 solo escribe (el último gana)', () => {
    const { result } = renderHook(() => useVentaDraft({ enabled: true }));
    act(() => { result.current.saveDraft({ v: 1 }); });
    act(() => { vi.advanceTimersByTime(100); });
    act(() => { result.current.saveDraft({ v: 2 }); });
    act(() => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS + 10); });
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(persisted.state.v).toBe(2);
  });
});

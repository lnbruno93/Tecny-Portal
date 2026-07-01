import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getStoredTc, saveStoredTc, subscribeTcChange } from './cotizadorTc';

const STORAGE_KEY = 'cotizador_tc_ars_usd_v1';

describe('lib/cotizadorTc', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getStoredTc', () => {
    it('devuelve null si no hay valor persistido', () => {
      expect(getStoredTc()).toBeNull();
    });

    it('devuelve el número guardado si existe', () => {
      localStorage.setItem(STORAGE_KEY, '1530');
      expect(getStoredTc()).toBe(1530);
    });

    it('devuelve null si el valor persistido es basura (no numérico)', () => {
      localStorage.setItem(STORAGE_KEY, 'no-es-numero');
      expect(getStoredTc()).toBeNull();
    });

    it('devuelve null si el valor es 0 o negativo (TC inválido)', () => {
      localStorage.setItem(STORAGE_KEY, '0');
      expect(getStoredTc()).toBeNull();
      localStorage.setItem(STORAGE_KEY, '-100');
      expect(getStoredTc()).toBeNull();
    });
  });

  describe('saveStoredTc', () => {
    it('persiste el valor en localStorage', () => {
      saveStoredTc(1530);
      expect(localStorage.getItem(STORAGE_KEY)).toBe('1530');
    });

    it('ignora silenciosamente valores inválidos (no numéricos)', () => {
      saveStoredTc('abc');
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('ignora silenciosamente valores <= 0', () => {
      saveStoredTc(0);
      saveStoredTc(-5);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('dispatch custom event cotizador-tc-changed con el valor', () => {
      const spy = vi.fn();
      window.addEventListener('cotizador-tc-changed', spy);
      saveStoredTc(1234);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].detail).toEqual({ value: 1234 });
      window.removeEventListener('cotizador-tc-changed', spy);
    });
  });

  describe('subscribeTcChange', () => {
    it('notifica cuando saveStoredTc se ejecuta en la misma pestaña', () => {
      const cb = vi.fn();
      const unsub = subscribeTcChange(cb);
      saveStoredTc(1600);
      expect(cb).toHaveBeenCalledWith(1600);
      unsub();
    });

    it('unsubscribe deja de recibir eventos', () => {
      const cb = vi.fn();
      const unsub = subscribeTcChange(cb);
      unsub();
      saveStoredTc(1700);
      expect(cb).not.toHaveBeenCalled();
    });

    it('reacciona al evento storage nativo (simulación cross-tab)', () => {
      const cb = vi.fn();
      const unsub = subscribeTcChange(cb);
      // StorageEvent con la key correcta.
      window.dispatchEvent(new StorageEvent('storage', {
        key: STORAGE_KEY,
        newValue: '1800',
      }));
      expect(cb).toHaveBeenCalledWith(1800);
      unsub();
    });

    it('ignora eventos storage con key distinta', () => {
      const cb = vi.fn();
      const unsub = subscribeTcChange(cb);
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'otra_key',
        newValue: '9999',
      }));
      expect(cb).not.toHaveBeenCalled();
      unsub();
    });
  });
});

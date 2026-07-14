import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { shouldDelayReload, startAutoReloadWatcher } from './swAutoReload';

// 2026-07-14: tests de la lógica del auto-reload post-SW-update.
// Cubren el criterio "delay reload si el user está editando algo".

describe('shouldDelayReload', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('sin ningún input en el DOM → false (safe to reload)', () => {
    expect(shouldDelayReload()).toBe(false);
  });

  it('input vacío → false', () => {
    document.body.innerHTML = '<input type="text" />';
    expect(shouldDelayReload()).toBe(false);
  });

  it('input con value pre-poblado igual al defaultValue → false (server-populated, no edit)', () => {
    document.body.innerHTML = '<input type="text" value="TekHaus" />';
    // En HTML puro, value setea también defaultValue → considerado no-dirty.
    expect(shouldDelayReload()).toBe(false);
  });

  it('input con value distinto al defaultValue → true (dirty, user editó)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.defaultValue = 'valor original';
    input.value = 'valor editado por el user';
    document.body.appendChild(input);
    expect(shouldDelayReload()).toBe(true);
  });

  it('textarea con value nuevo → true', () => {
    const ta = document.createElement('textarea');
    ta.defaultValue = '';
    ta.value = 'algo que el user escribió';
    document.body.appendChild(ta);
    expect(shouldDelayReload()).toBe(true);
  });

  it('input type=hidden con value → false (no es data del user)', () => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.defaultValue = '';
    input.value = 'csrf-token-o-algo';
    document.body.appendChild(input);
    expect(shouldDelayReload()).toBe(false);
  });

  it('input type=submit / button / reset → false (no son data)', () => {
    // Nota: type=file no incluido porque el spec HTML impide setear .value
    // programáticamente (InvalidStateError) — imposible reproducir "file con
    // value" en jsdom. El código igual lo skipea por el NON_DATA_TYPES set.
    for (const t of ['submit', 'button', 'reset']) {
      document.body.innerHTML = '';
      const input = document.createElement('input');
      input.type = t;
      input.defaultValue = '';
      input.value = 'X';
      document.body.appendChild(input);
      expect(shouldDelayReload()).toBe(false);
    }
  });

  it('checkbox/radio checked → false (no cuentan como dirty por criterio value)', () => {
    for (const t of ['checkbox', 'radio']) {
      document.body.innerHTML = '';
      const input = document.createElement('input');
      input.type = t;
      input.value = 'on';
      input.checked = true;
      document.body.appendChild(input);
      expect(shouldDelayReload()).toBe(false);
    }
  });

  it('input con focus → true (aunque value === defaultValue, user está tipeando)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(shouldDelayReload()).toBe(true);
  });

  it('textarea con focus → true', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    expect(shouldDelayReload()).toBe(true);
  });

  it('select con focus → true', () => {
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="a">a</option>';
    document.body.appendChild(sel);
    sel.focus();
    expect(shouldDelayReload()).toBe(true);
  });

  it('contentEditable con focus → true (rich text editors)', () => {
    // jsdom no implementa `isContentEditable` correctamente al setear via
    // property (queda false aunque hagamos setAttribute + focus). Mockeamos
    // el activeElement con un objeto que responda isContentEditable=true —
    // igual que lo haría un browser real con un rich text editor focuseado.
    const fakeEditable = { tagName: 'DIV', isContentEditable: true };
    const spy = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(fakeEditable);
    try {
      expect(shouldDelayReload()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('múltiples inputs, todos limpios excepto uno → true', () => {
    document.body.innerHTML = `
      <input type="text" value="original" />
      <input type="text" value="" />
    `;
    // Segundo input: value=='' → skip por vacío. Primero: value===defaultValue → skip.
    expect(shouldDelayReload()).toBe(false);
    // Ahora ensuciamos el segundo.
    const inputs = document.querySelectorAll('input');
    inputs[1].defaultValue = 'previo';
    inputs[1].value = 'editado';
    expect(shouldDelayReload()).toBe(true);
  });

  it('trim: whitespace-only no cuenta como dirty', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.defaultValue = '';
    input.value = '   ';
    document.body.appendChild(input);
    expect(shouldDelayReload()).toBe(false);
  });
});

describe('startAutoReloadWatcher', () => {
  beforeEach(() => { document.body.innerHTML = ''; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('user idle >idleMs + sin dirty forms → dispara onReady', () => {
    const onReady = vi.fn();
    const cleanup = startAutoReloadWatcher(onReady, {
      idleMs: 100,
      checkIntervalMs: 10,
      shouldDelay: () => false,
    });
    expect(onReady).not.toHaveBeenCalled();
    // Avanzamos el tiempo pasando el idle threshold.
    vi.advanceTimersByTime(200);
    expect(onReady).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('user activo (evento mousemove) resetea el idle timer', () => {
    const onReady = vi.fn();
    const cleanup = startAutoReloadWatcher(onReady, {
      idleMs: 100,
      checkIntervalMs: 10,
      shouldDelay: () => false,
    });
    // Simular actividad justo antes del threshold.
    vi.advanceTimersByTime(80);
    window.dispatchEvent(new Event('mousemove'));
    vi.advanceTimersByTime(50);
    // Total 130ms pero solo 50ms desde el último mousemove → NO dispara.
    expect(onReady).not.toHaveBeenCalled();
    // Ahora sí dejamos pasar el threshold sin más actividad.
    vi.advanceTimersByTime(100);
    expect(onReady).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('shouldDelay() true → NO dispara aunque esté idle', () => {
    const onReady = vi.fn();
    const cleanup = startAutoReloadWatcher(onReady, {
      idleMs: 100,
      checkIntervalMs: 10,
      shouldDelay: () => true, // siempre delay (user editando)
    });
    vi.advanceTimersByTime(500);
    expect(onReady).not.toHaveBeenCalled();
    cleanup();
  });

  it('dispara UNA sola vez, no re-dispara en ticks siguientes', () => {
    const onReady = vi.fn();
    const cleanup = startAutoReloadWatcher(onReady, {
      idleMs: 100,
      checkIntervalMs: 10,
      shouldDelay: () => false,
    });
    vi.advanceTimersByTime(500);
    expect(onReady).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('cleanup: remueve listeners y timer', () => {
    const onReady = vi.fn();
    const cleanup = startAutoReloadWatcher(onReady, {
      idleMs: 100,
      checkIntervalMs: 10,
      shouldDelay: () => false,
    });
    cleanup();
    vi.advanceTimersByTime(500);
    expect(onReady).not.toHaveBeenCalled();
  });
});

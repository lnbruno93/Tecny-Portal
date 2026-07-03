import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadBlob } from './downloadBlob';

// Audit 2026-07-04 P3: helper compartido para descargar Blobs. Antes había 6
// duplicaciones del mismo pattern. Este test cubre el contrato clave:
//   - crea object URL
//   - dispara click en anchor con download=filename
//   - remueve el anchor + revoca URL después de un tick
//   - rechaza input inválido (blob/filename vacíos)

describe('downloadBlob', () => {
  let createSpy, revokeSpy, clickSpy, appendSpy, removeSpy;

  beforeEach(() => {
    createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    // Espiamos click en el prototype porque el anchor se crea internamente.
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    appendSpy = vi.spyOn(document.body, 'appendChild');
    removeSpy = vi.spyOn(document.body, 'removeChild');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('crea object URL, hace click y adjunta/remueve el anchor', () => {
    const blob = new Blob(['data']);
    downloadBlob(blob, 'test.txt');
    expect(createSpy).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalled();
    expect(appendSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    // La URL se revoca después de un tick (no sincrónico).
    expect(revokeSpy).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-url');
  });

  it('el anchor tiene href = object URL y download = filename', () => {
    const blob = new Blob(['data']);
    downloadBlob(blob, 'reporte-2026-07.xlsx');
    // El primer arg del appendChild spy es el anchor creado.
    const anchor = appendSpy.mock.calls.at(-1)?.[0];
    expect(anchor).toBeTruthy();
    expect(anchor.tagName).toBe('A');
    // href relativo: jsdom lo resuelve contra baseURI. Basta con verificar que
    // termina con el mock url — no queremos hardcodear el baseURI.
    expect(anchor.getAttribute('href')).toBe('blob:mock-url');
    expect(anchor.download).toBe('reporte-2026-07.xlsx');
  });

  it('rechaza blob null/undefined', () => {
    expect(() => downloadBlob(null, 'a.txt')).toThrow(/blob requerido/);
    expect(() => downloadBlob(undefined, 'a.txt')).toThrow(/blob requerido/);
  });

  it('rechaza filename vacío', () => {
    const blob = new Blob(['data']);
    expect(() => downloadBlob(blob, '')).toThrow(/filename requerido/);
    expect(() => downloadBlob(blob, null)).toThrow(/filename requerido/);
  });
});

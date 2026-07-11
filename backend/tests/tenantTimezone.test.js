// tenantTimezone.test.js — 2026-07-11 (auditoría Red B2B P0-2).
//
// Tests unitarios del helper de derivación de timezone tenant-aware.

const { getTenantTimezone, TZ_POR_PAIS } = require('../src/lib/tenantTimezone');

describe('getTenantTimezone', () => {
  test('AR → America/Argentina/Buenos_Aires', () => {
    expect(getTenantTimezone('AR')).toBe('America/Argentina/Buenos_Aires');
  });

  test('UY → America/Montevideo', () => {
    expect(getTenantTimezone('UY')).toBe('America/Montevideo');
  });

  test('case-insensitive (ar/uy)', () => {
    expect(getTenantTimezone('ar')).toBe('America/Argentina/Buenos_Aires');
    expect(getTenantTimezone('uy')).toBe('America/Montevideo');
  });

  test('unknown country → fallback AR (defensivo)', () => {
    expect(getTenantTimezone('CL')).toBe('America/Argentina/Buenos_Aires');
    expect(getTenantTimezone('XX')).toBe('America/Argentina/Buenos_Aires');
  });

  test('null / undefined / empty → fallback AR', () => {
    expect(getTenantTimezone(null)).toBe('America/Argentina/Buenos_Aires');
    expect(getTenantTimezone(undefined)).toBe('America/Argentina/Buenos_Aires');
    expect(getTenantTimezone('')).toBe('America/Argentina/Buenos_Aires');
  });

  test('TZ_POR_PAIS mapping export es inmutable a nivel referencia', () => {
    // Los tests deben leer el mapping pero no modificarlo — validamos que
    // el export mantiene las claves esperadas.
    expect(Object.keys(TZ_POR_PAIS).sort()).toEqual(['AR', 'UY']);
  });
});

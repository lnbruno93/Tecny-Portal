// schemas-common.test.js — 2026-07-08
//
// Tests unitarios del helper `requiereTc()` y la constante `MONEDAS_CON_TC`
// que centralizan el "qué moneda necesita tipo de cambio para convertir a USD".
//
// Contexto: antes de este helper, 6+ sitios chequeaban `moneda === 'ARS'` para
// exigir TC. Al agregar UYU (multi-país F2), ninguno se actualizó → un tenant
// UY podía persistir cargos UYU sin TC → `toUsd(m, 'UYU', null) = 0` → KPIs
// mentían silenciosamente. Este archivo lockea la nueva fuente de verdad.
//
// NO requiere DB — son unit tests puros.

const { requiereTc, MONEDAS_CON_TC } = require('../src/schemas/_common');

describe('requiereTc()', () => {
  it('devuelve true para ARS (fiat local que necesita conversión)', () => {
    expect(requiereTc('ARS')).toBe(true);
  });

  it('devuelve true para UYU (multi-país F2)', () => {
    expect(requiereTc('UYU')).toBe(true);
  });

  it('devuelve false para USD (base del sistema)', () => {
    expect(requiereTc('USD')).toBe(false);
  });

  it('devuelve false para USDT (stablecoin, 1:1 con USD)', () => {
    expect(requiereTc('USDT')).toBe(false);
  });

  it('devuelve false para monedas desconocidas (defensivo — nunca crashea)', () => {
    expect(requiereTc('EUR')).toBe(false);
    expect(requiereTc('BRL')).toBe(false);
    expect(requiereTc('BTC')).toBe(false);
  });

  it('devuelve false para valores falsy — sin crash', () => {
    expect(requiereTc(undefined)).toBe(false);
    expect(requiereTc(null)).toBe(false);
    expect(requiereTc('')).toBe(false);
  });
});

describe('MONEDAS_CON_TC', () => {
  it('es un array con las monedas fiat locales soportadas (ARS + UYU)', () => {
    expect(MONEDAS_CON_TC).toEqual(['ARS', 'UYU']);
  });

  it('NO incluye USD (es la moneda base — no requiere conversión)', () => {
    expect(MONEDAS_CON_TC).not.toContain('USD');
  });

  it('NO incluye USDT (stablecoin — se trata 1:1 con USD)', () => {
    expect(MONEDAS_CON_TC).not.toContain('USDT');
  });
});

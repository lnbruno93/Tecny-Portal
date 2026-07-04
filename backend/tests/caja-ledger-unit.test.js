// Tests unitarios de lib/cajaLedger.js — regresión BLOCKER 2026-07-05.
//
// El bug: `grupoMoneda('UYU')` retornaba 'USD' porque el helper era
// `return m === 'ARS' ? 'ARS' : 'USD'`. Efecto: un pago UYU podía aceptarse
// en una caja USD/USDT (el check `grupoMoneda(pago) === grupoMoneda(caja)`
// pasaba con ambos como 'USD'), y el `saldo` nativo de la caja quedaba
// sumando UYU como si fueran dólares → saldos absurdos.

const { grupoMoneda } = require('../src/lib/cajaLedger');

describe('lib/cajaLedger — grupoMoneda', () => {
  it('ARS es su propio grupo', () => {
    expect(grupoMoneda('ARS')).toBe('ARS');
  });

  it('UYU es su propio grupo (CRÍTICO — regresión BLOCKER 2026-07-05)', () => {
    // Antes retornaba 'USD' → permitía mezclar UYU con USD/USDT en la misma caja.
    expect(grupoMoneda('UYU')).toBe('UYU');
  });

  it('USD y USDT son mismo grupo (1:1)', () => {
    expect(grupoMoneda('USD')).toBe('USD');
    expect(grupoMoneda('USDT')).toBe('USD');
  });

  it('UYU y USD son grupos DISTINTOS (no pueden mezclarse en misma caja)', () => {
    expect(grupoMoneda('UYU')).not.toBe(grupoMoneda('USD'));
    expect(grupoMoneda('UYU')).not.toBe(grupoMoneda('USDT'));
  });

  it('UYU y ARS son grupos distintos', () => {
    expect(grupoMoneda('UYU')).not.toBe(grupoMoneda('ARS'));
  });

  it('moneda desconocida cae al bucket USD (defensive)', () => {
    // Si en el futuro alguien agrega una moneda sin actualizar cajaLedger,
    // preferimos que caiga al bucket "más común" (USD) que retornar undefined
    // y romper todos los saldos. El fail-loud es responsabilidad de otros
    // helpers (assertMonedaValidaParaPais, Zod validators).
    expect(grupoMoneda('EUR')).toBe('USD');
    expect(grupoMoneda(undefined)).toBe('USD');
  });
});

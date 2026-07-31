/**
 * Tests unitarios de computeVueltoUsd (backend) — espejo del frontend.
 *
 * Feature (2026-07-30, pedido Lautaro Bisman): el vuelto entregado en la
 * venta debe aparecer como línea informativa en el resumen del comprobante
 * PDF descargado desde el botón rojo (backend genera PDF y sirve archivo).
 *
 * El helper `computeVueltoUsd` está exportado desde
 * backend/src/lib/comprobantePdf.js — mismo contract que el homónimo del
 * frontend en frontend/src/lib/generarComprobantePdf.js.
 */
const { computeVueltoUsd } = require('../src/lib/comprobantePdf');

describe('computeVueltoUsd (backend)', () => {
  test('sin vuelto: devuelve 0', () => {
    expect(computeVueltoUsd({ vuelto_monto: null })).toBe(0);
    expect(computeVueltoUsd({})).toBe(0);
    expect(computeVueltoUsd(null)).toBe(0);
    expect(computeVueltoUsd(undefined)).toBe(0);
  });

  test('vuelto USD: monto tal cual', () => {
    expect(computeVueltoUsd({ vuelto_monto: 10, vuelto_moneda: 'USD' })).toBe(10);
    expect(computeVueltoUsd({ vuelto_monto: 25.5, vuelto_moneda: 'USDT' })).toBe(25.5);
  });

  test('vuelto ARS: divide por vuelto_tc (NO tc_venta)', () => {
    // Cliente pagó $1000 USD por producto $990, se devuelve 15.000 ARS
    // al TC del vuelto 1500 → $10 USD. Nota: `tc_venta` puede diferir del
    // `vuelto_tc` (el vuelto se paga al TC del momento de la devolución).
    const vueltoUsd = computeVueltoUsd({
      vuelto_monto: 15000,
      vuelto_moneda: 'ARS',
      vuelto_tc: 1500,
      tc_venta: 1200,  // diferente, no se usa
    });
    expect(vueltoUsd).toBe(10);
  });

  test('vuelto UYU: divide por vuelto_tc', () => {
    expect(computeVueltoUsd({
      vuelto_monto: 400,
      vuelto_moneda: 'UYU',
      vuelto_tc: 40,
    })).toBe(10);
  });

  test('vuelto ARS sin tc (defensive): devuelve 0', () => {
    expect(computeVueltoUsd({
      vuelto_monto: 15000, vuelto_moneda: 'ARS',
    })).toBe(0);
    expect(computeVueltoUsd({
      vuelto_monto: 15000, vuelto_moneda: 'ARS', vuelto_tc: 0,
    })).toBe(0);
  });

  test('monto <= 0: devuelve 0', () => {
    expect(computeVueltoUsd({ vuelto_monto: 0, vuelto_moneda: 'USD' })).toBe(0);
    expect(computeVueltoUsd({ vuelto_monto: -5, vuelto_moneda: 'USD' })).toBe(0);
  });

  test('moneda case-insensitive (ars vs ARS)', () => {
    expect(computeVueltoUsd({
      vuelto_monto: 15000, vuelto_moneda: 'ars', vuelto_tc: 1500,
    })).toBe(10);
  });
});

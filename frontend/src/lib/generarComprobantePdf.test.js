// Tests de los cálculos del comprobante (task #140, 2026-07-16).
//
// El generador PDF completo no se testea acá (jsPDF + autoTable son
// difíciles de estubbear y el output binario no aporta valor). Sí testeamos
// los helpers PUROS de cálculo — que es donde vivía el bug reportado.
//
// Bug reproducido: venta con canje → total_cobrado subvaluado → aparece
// "diferencia en contra" falsa. Fix: sumar canjes (convertidos a USD).

import { describe, it, expect } from 'vitest';
import { sumPagosUsd, sumCanjesUsd, computeVueltoUsd } from './generarComprobantePdf.js';

describe('sumPagosUsd', () => {
  it('suma monto_usd de todos los pagos', () => {
    const pagos = [
      { monto_usd: 849.67 },
      { monto_usd: 50.33 },
    ];
    expect(sumPagosUsd(pagos)).toBeCloseTo(900, 2);
  });

  it('devuelve 0 si el array está vacío', () => {
    expect(sumPagosUsd([])).toBe(0);
  });

  it('devuelve 0 si no es array (defensivo)', () => {
    expect(sumPagosUsd(null)).toBe(0);
    expect(sumPagosUsd(undefined)).toBe(0);
  });

  it('trata monto_usd inválido como 0', () => {
    const pagos = [
      { monto_usd: 100 },
      { monto_usd: 'ABC' },   // string inválido
      { monto_usd: null },
    ];
    expect(sumPagosUsd(pagos)).toBe(100);
  });
});

describe('sumCanjesUsd', () => {
  it('canje en USD: usa valor_toma directo', () => {
    const canjes = [
      { valor_toma: 250, moneda: 'USD' },
    ];
    expect(sumCanjesUsd(canjes, 1530)).toBe(250);
  });

  it('canje en ARS: divide por tc_venta', () => {
    const canjes = [
      { valor_toma: 382500, moneda: 'ARS' },
    ];
    // 382500 / 1530 = 250
    expect(sumCanjesUsd(canjes, 1530)).toBeCloseTo(250, 2);
  });

  it('canje en UYU: divide por tc_venta (mismo path que ARS)', () => {
    const canjes = [
      { valor_toma: 10000, moneda: 'UYU' },
    ];
    // 10000 / 40 = 250
    expect(sumCanjesUsd(canjes, 40)).toBeCloseTo(250, 2);
  });

  it('canje sin moneda: asume USD', () => {
    const canjes = [
      { valor_toma: 250 },  // sin moneda
    ];
    expect(sumCanjesUsd(canjes, 1530)).toBe(250);
  });

  it('canje ARS sin tc_venta (o tc=0): usa valor tal cual (evita div/0)', () => {
    const canjes = [
      { valor_toma: 382500, moneda: 'ARS' },
    ];
    expect(sumCanjesUsd(canjes, 0)).toBe(382500);
    expect(sumCanjesUsd(canjes, null)).toBe(382500);
  });

  it('múltiples canjes: suma cada uno con su conversión propia', () => {
    const canjes = [
      { valor_toma: 250, moneda: 'USD' },       // 250 USD directo
      { valor_toma: 306000, moneda: 'ARS' },    // 306000/1530 = 200 USD
    ];
    expect(sumCanjesUsd(canjes, 1530)).toBeCloseTo(450, 2);
  });

  it('devuelve 0 si el array está vacío o no es array', () => {
    expect(sumCanjesUsd([], 1530)).toBe(0);
    expect(sumCanjesUsd(null, 1530)).toBe(0);
    expect(sumCanjesUsd(undefined, 1530)).toBe(0);
  });
});

describe('Escenario del bug reportado (2026-07-16)', () => {
  it('venta con iPhone 17 Pro u$s1150 + canje iPhone 14 Pro u$s250 → dif=0', () => {
    // Datos exactos de la screenshot que mandó Lucas:
    //   Total venta: u$s 1.150,00
    //   Pagos:
    //     - Efectivo Pesos: $1.300.000 al TC 1530 → u$s 849,67
    //     - Transferencia ARS TUTECORP: $77.000 al TC 1530 → u$s 50,33
    //   Canje: iPhone 14 Pro 128GB Black, valor_toma 250 USD
    //
    // Bug: comprobante mostraba total_cobrado=900 y "Diferencia en contra -250"
    // Fix: total_cobrado = 900 (pagos) + 250 (canje) = 1150, diferencia = 0.
    const venta = {
      total_usd: 1150,
      tc_venta: 1530,
      pagos: [
        { monto_usd: 849.67 },
        { monto_usd: 50.33 },
      ],
      canjes: [
        { valor_toma: 250, moneda: 'USD', descripcion: 'iPhone 14 Pro' },
      ],
    };
    const totalCobrado = sumPagosUsd(venta.pagos) + sumCanjesUsd(venta.canjes, venta.tc_venta);
    expect(totalCobrado).toBeCloseTo(1150, 2);
    expect(totalCobrado - venta.total_usd).toBeCloseTo(0, 2);
  });

  it('venta con canje en ARS: también se computa bien', () => {
    // Variante: canje registrado en ARS (por si el usuario lo cargó así)
    const venta = {
      total_usd: 1150,
      tc_venta: 1530,
      pagos: [{ monto_usd: 900 }],
      canjes: [{ valor_toma: 382500, moneda: 'ARS' }], // 382500/1530=250
    };
    const totalCobrado = sumPagosUsd(venta.pagos) + sumCanjesUsd(venta.canjes, venta.tc_venta);
    expect(totalCobrado).toBeCloseTo(1150, 2);
  });
});

// Vuelto entregado en el comprobante (2026-07-30 pedido Lautaro Bisman).
describe('computeVueltoUsd', () => {
  it('sin vuelto: 0', () => {
    expect(computeVueltoUsd({ vuelto_monto: null })).toBe(0);
    expect(computeVueltoUsd({})).toBe(0);
    expect(computeVueltoUsd(null)).toBe(0);
  });

  it('vuelto USD: monto tal cual', () => {
    expect(computeVueltoUsd({ vuelto_monto: 10, vuelto_moneda: 'USD' })).toBe(10);
    expect(computeVueltoUsd({ vuelto_monto: 25.5, vuelto_moneda: 'USDT' })).toBe(25.5);
  });

  it('vuelto ARS: se divide por vuelto_tc (NO por tc_venta)', () => {
    // Cliente pagó $1000 USD, se le devuelve 15.000 ARS al TC 1500 = $10 USD
    expect(computeVueltoUsd({
      vuelto_monto: 15000, vuelto_moneda: 'ARS', vuelto_tc: 1500,
      tc_venta: 1200,  // otro TC — el vuelto usa el SUYO
    })).toBe(10);
  });

  it('vuelto UYU: se divide por vuelto_tc', () => {
    expect(computeVueltoUsd({
      vuelto_monto: 400, vuelto_moneda: 'UYU', vuelto_tc: 40,
    })).toBe(10);
  });

  it('vuelto ARS sin tc (defensive): 0', () => {
    expect(computeVueltoUsd({ vuelto_monto: 15000, vuelto_moneda: 'ARS' })).toBe(0);
    expect(computeVueltoUsd({ vuelto_monto: 15000, vuelto_moneda: 'ARS', vuelto_tc: 0 })).toBe(0);
  });

  it('monto negativo o 0: devuelve 0', () => {
    expect(computeVueltoUsd({ vuelto_monto: 0, vuelto_moneda: 'USD' })).toBe(0);
    expect(computeVueltoUsd({ vuelto_monto: -5, vuelto_moneda: 'USD' })).toBe(0);
  });
});

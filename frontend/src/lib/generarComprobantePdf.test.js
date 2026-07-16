// Tests de los cálculos del comprobante (task #140, 2026-07-16).
//
// El generador PDF completo no se testea acá (jsPDF + autoTable son
// difíciles de estubbear y el output binario no aporta valor). Sí testeamos
// los helpers PUROS de cálculo — que es donde vivía el bug reportado.
//
// Bug reproducido: venta con canje → total_cobrado subvaluado → aparece
// "diferencia en contra" falsa. Fix: sumar canjes (convertidos a USD).

import { describe, it, expect } from 'vitest';
import { sumPagosUsd, sumCanjesUsd } from './generarComprobantePdf.js';

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

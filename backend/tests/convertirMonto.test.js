/**
 * Tests del helper convertirMonto + validarMonedasPagoCaja (lib/money.js).
 *
 * Contexto (fix #4 audit 2026-07-07 Fase A):
 * `syncVentaCaja` copia `venta_pagos.monto` al `caja_movimientos.monto`
 * SIN convertir cuando la moneda difiere de la caja. Esto rompe la
 * contabilidad porque el saldo se calcula sumando montos crudos y asume
 * la moneda de la caja.
 *
 * `convertirMonto()` es el helper puro que hace la conversión correcta.
 * `validarMonedasPagoCaja()` es el chequeo que corre el POST/PUT de venta
 * antes de dispararsync.
 *
 * Estos tests son la fuente de verdad del comportamiento esperado —
 * si algún día alguien "optimiza" el helper y rompe estas expectativas,
 * salta el test antes que la contabilidad de un tenant.
 */
const { convertirMonto, validarMonedasPagoCaja } = require('../src/lib/money');

describe('convertirMonto — helper puro pago→caja', () => {
  describe('misma moneda (passthrough)', () => {
    it.each([
      ['USD', 'USD', 100, null, 100],
      ['ARS', 'ARS', 5000, null, 5000],
      ['UYU', 'UYU', 500, null, 500],
      ['USDT', 'USDT', 42.5, null, 42.5],
    ])('%s → %s: %d sin tc = %d', (src, dst, monto, tc, expected) => {
      expect(convertirMonto(monto, src, dst, tc)).toBe(expected);
    });
  });

  describe('USD/USDT paridad 1:1', () => {
    it('USD → USDT sin tc = mismo monto', () => {
      expect(convertirMonto(100, 'USD', 'USDT', null)).toBe(100);
    });
    it('USDT → USD sin tc = mismo monto', () => {
      expect(convertirMonto(50.25, 'USDT', 'USD', null)).toBe(50.25);
    });
  });

  describe('USD/USDT → ARS/UYU (multiplica por tc)', () => {
    it('USD → ARS con tc=1400: 100 = 140000', () => {
      expect(convertirMonto(100, 'USD', 'ARS', 1400)).toBe(140000);
    });
    it('USD → UYU con tc=40: 100 = 4000', () => {
      expect(convertirMonto(100, 'USD', 'UYU', 40)).toBe(4000);
    });
    it('USDT → ARS con tc=1400: 50 = 70000', () => {
      expect(convertirMonto(50, 'USDT', 'ARS', 1400)).toBe(70000);
    });
    it('redondea a 2 decimales estables', () => {
      // 1.23 × 1400.5 = 1722.615 → round2 = 1722.62
      expect(convertirMonto(1.23, 'USD', 'ARS', 1400.5)).toBe(1722.62);
    });
  });

  describe('ARS/UYU → USD/USDT (divide por tc)', () => {
    it('ARS → USD con tc=1400: 140000 = 100', () => {
      expect(convertirMonto(140000, 'ARS', 'USD', 1400)).toBe(100);
    });
    it('UYU → USD con tc=40: 4000 = 100', () => {
      expect(convertirMonto(4000, 'UYU', 'USD', 40)).toBe(100);
    });
    it('ARS → USDT con tc=1400: 70000 = 50', () => {
      expect(convertirMonto(70000, 'ARS', 'USDT', 1400)).toBe(50);
    });
  });

  describe('casos inválidos → null', () => {
    it('tc faltante en conversión fiat/USD → null', () => {
      expect(convertirMonto(100, 'USD', 'ARS', null)).toBe(null);
      expect(convertirMonto(100, 'USD', 'ARS', undefined)).toBe(null);
      expect(convertirMonto(100, 'USD', 'ARS', 0)).toBe(null);
      expect(convertirMonto(100, 'USD', 'ARS', -1)).toBe(null);
      expect(convertirMonto(100, 'USD', 'ARS', 'invalid')).toBe(null);
    });
    it('ARS ↔ UYU sin USD intermedio no soportado en Fase A → null', () => {
      expect(convertirMonto(1000, 'ARS', 'UYU', 40)).toBe(null);
      expect(convertirMonto(500, 'UYU', 'ARS', 1400)).toBe(null);
    });
    it('moneda desconocida → null', () => {
      expect(convertirMonto(100, 'EUR', 'USD', 1)).toBe(null);
      expect(convertirMonto(100, 'USD', 'BTC', 1)).toBe(null);
    });
    it('monto 0 en moneda válida devuelve 0 (no null — es válido)', () => {
      expect(convertirMonto(0, 'USD', 'ARS', 1400)).toBe(0);
      expect(convertirMonto(0, 'USD', 'USD', null)).toBe(0);
    });
  });
});

describe('validarMonedasPagoCaja — chequeo pre-sync', () => {
  it('OK cuando pago y caja tienen misma moneda (tc opcional)', () => {
    expect(validarMonedasPagoCaja('USD', 'USD', null)).toEqual({ ok: true });
    expect(validarMonedasPagoCaja('ARS', 'ARS', 1400)).toEqual({ ok: true });
    expect(validarMonedasPagoCaja('UYU', 'UYU', 40)).toEqual({ ok: true });
  });

  it('OK cuando pago USD y caja ARS/UYU con tc válido', () => {
    expect(validarMonedasPagoCaja('USD', 'ARS', 1400)).toEqual({ ok: true });
    expect(validarMonedasPagoCaja('USD', 'UYU', 40)).toEqual({ ok: true });
  });

  it('FAIL cuando pago USD y caja ARS/UYU sin tc', () => {
    const r = validarMonedasPagoCaja('USD', 'ARS', null);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/TC/i);
  });

  it('FAIL cuando ARS ↔ UYU sin USD intermedio', () => {
    const r = validarMonedasPagoCaja('ARS', 'UYU', 40);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/USD.*intermedio/i);
  });

  it('OK con USD ↔ USDT (paridad 1:1)', () => {
    expect(validarMonedasPagoCaja('USD', 'USDT', null)).toEqual({ ok: true });
    expect(validarMonedasPagoCaja('USDT', 'USD', null)).toEqual({ ok: true });
  });
});

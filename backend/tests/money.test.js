// Tests unitarios de lib/money.js — regresión BLOCKER 2026-07-05 (multi-país
// UYU). Estos tests habrían atrapado el bug crítico donde `toUsd(monto,'UYU',tc)`
// caía a `return m` como fallback silencioso, persistiendo `total_usd` inflado
// ~40x en TODOS los tenants Uruguay.
//
// La suite se enfoca en INVARIANTES matemáticos: para un TC dado, la conversión
// tiene una expectativa única y estable. Sin dependencias de DB — puros helpers.

const {
  toUsd,
  round2,
  computeNeto,
  isMonedaValidaParaPais,
  getMonedaLocalPais,
  MONEDAS_POR_PAIS,
  TODAS_LAS_MONEDAS,
} = require('../src/lib/money');

describe('lib/money — toUsd', () => {
  // ── USD / USDT: 1:1, tc irrelevante ───────────────────────────────────
  it('USD retorna monto tal cual (1:1)', () => {
    expect(toUsd(100, 'USD', 1400)).toBe(100);
    expect(toUsd(100, 'USD', null)).toBe(100);
    expect(toUsd(0.5, 'USD', 40)).toBe(0.5);
  });

  it('USDT retorna monto tal cual (1:1, mismo tratamiento que USD)', () => {
    expect(toUsd(250, 'USDT', 1400)).toBe(250);
    expect(toUsd(250, 'USDT', 40)).toBe(250);
  });

  // ── ARS: divide por TC ────────────────────────────────────────────────
  it('ARS divide por tc (ejemplo: 1400 ARS/USD)', () => {
    expect(toUsd(14000, 'ARS', 1400)).toBe(10);
    expect(toUsd(1400000, 'ARS', 1400)).toBe(1000);
  });

  it('ARS sin tc válido retorna 0 (no leak)', () => {
    expect(toUsd(14000, 'ARS', 0)).toBe(0);
    expect(toUsd(14000, 'ARS', null)).toBe(0);
    expect(toUsd(14000, 'ARS', undefined)).toBe(0);
    expect(toUsd(14000, 'ARS', -100)).toBe(0);
    expect(toUsd(14000, 'ARS', 'texto')).toBe(0);
  });

  // ── UYU: divide por TC — BLOCKER 2026-07-05 ──────────────────────────
  // ANTES: `toUsd(40000, 'UYU', 40)` retornaba 40000 (falback `return m`).
  // AHORA: retorna 1000 (correcto: 40000 UYU / 40 UYU_por_USD = 1000 USD).
  it('UYU divide por tc (ejemplo: 40 UYU/USD)', () => {
    expect(toUsd(40000, 'UYU', 40)).toBe(1000);
    expect(toUsd(4000, 'UYU', 40)).toBe(100);
    expect(toUsd(200, 'UYU', 40)).toBe(5);
  });

  it('UYU con TC decimal (ejemplo: 39.5)', () => {
    // 40000 / 39.5 ≈ 1012.66
    const result = toUsd(40000, 'UYU', 39.5);
    expect(result).toBeCloseTo(1012.66, 1);
  });

  it('UYU sin tc válido retorna 0 (no leak — CRÍTICO)', () => {
    // Regresión directa del bug 2026-07-05.
    expect(toUsd(40000, 'UYU', 0)).toBe(0);
    expect(toUsd(40000, 'UYU', null)).toBe(0);
    expect(toUsd(40000, 'UYU', undefined)).toBe(0);
    expect(toUsd(40000, 'UYU', -100)).toBe(0);
  });

  // ── Fallback defensivo ────────────────────────────────────────────────
  it('moneda desconocida retorna 0 (defensive — mejor cero visible que corrupto)', () => {
    // Si alguien agrega una moneda nueva y olvida actualizar toUsd, preferimos
    // que el dashboard muestre "$0" (bug visible) antes que persistir el
    // monto crudo como si fuera USD (bug silencioso).
    expect(toUsd(100, 'EUR', 1)).toBe(0);
    expect(toUsd(100, 'BRL', 5)).toBe(0);
    expect(toUsd(100, undefined, 1)).toBe(0);
    expect(toUsd(100, null, 1)).toBe(0);
    expect(toUsd(100, '', 1)).toBe(0);
  });

  // ── Coerción numérica ────────────────────────────────────────────────
  it('acepta monto/tc como strings numéricos', () => {
    expect(toUsd('14000', 'ARS', '1400')).toBe(10);
    expect(toUsd('40000', 'UYU', '40')).toBe(1000);
  });

  it('monto NaN o basura retorna 0 (via Number(monto)||0)', () => {
    expect(toUsd(NaN, 'USD', 1)).toBe(0);
    expect(toUsd('texto', 'USD', 1)).toBe(0);
    expect(toUsd(undefined, 'USD', 1)).toBe(0);
  });

  it('monto 0 retorna 0 en cualquier moneda', () => {
    expect(toUsd(0, 'USD')).toBe(0);
    expect(toUsd(0, 'ARS', 1400)).toBe(0);
    expect(toUsd(0, 'UYU', 40)).toBe(0);
  });
});

describe('lib/money — round2', () => {
  it('redondea a 2 decimales', () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(1.235)).toBe(1.24);
    expect(round2(1)).toBe(1);
  });

  it('estable en boundaries de FP (usa Number.EPSILON)', () => {
    // 1.005 en FP suele dar 1.00499999... — el epsilon corrige.
    expect(round2(1.005)).toBe(1.01);
  });
});

describe('lib/money — isMonedaValidaParaPais', () => {
  it('AR permite ARS/USD/USDT, NO UYU', () => {
    expect(isMonedaValidaParaPais('ARS', 'AR')).toBe(true);
    expect(isMonedaValidaParaPais('USD', 'AR')).toBe(true);
    expect(isMonedaValidaParaPais('USDT', 'AR')).toBe(true);
    expect(isMonedaValidaParaPais('UYU', 'AR')).toBe(false);
  });

  it('UY permite UYU/USD/USDT, NO ARS', () => {
    expect(isMonedaValidaParaPais('UYU', 'UY')).toBe(true);
    expect(isMonedaValidaParaPais('USD', 'UY')).toBe(true);
    expect(isMonedaValidaParaPais('USDT', 'UY')).toBe(true);
    expect(isMonedaValidaParaPais('ARS', 'UY')).toBe(false);
  });

  it('país desconocido: solo monedas globales (USD/USDT)', () => {
    expect(isMonedaValidaParaPais('USD', 'BR')).toBe(true);
    expect(isMonedaValidaParaPais('USDT', 'BR')).toBe(true);
    expect(isMonedaValidaParaPais('ARS', 'BR')).toBe(false);
    expect(isMonedaValidaParaPais('UYU', 'BR')).toBe(false);
  });
});

describe('lib/money — getMonedaLocalPais', () => {
  it('AR → ARS', () => {
    expect(getMonedaLocalPais('AR')).toBe('ARS');
  });
  it('UY → UYU', () => {
    expect(getMonedaLocalPais('UY')).toBe('UYU');
  });
  it('fallback: no-UY → ARS (default histórico)', () => {
    expect(getMonedaLocalPais('BR')).toBe('ARS');
    expect(getMonedaLocalPais(undefined)).toBe('ARS');
  });
});

describe('lib/money — invariantes de matriz países↔monedas', () => {
  it('TODAS_LAS_MONEDAS incluye ARS/UYU/USD/USDT (sin cambios)', () => {
    expect(TODAS_LAS_MONEDAS.sort()).toEqual(['ARS', 'USD', 'USDT', 'UYU']);
  });

  it('MONEDAS_POR_PAIS.AR y .UY son disjuntas en fiat (ARS vs UYU)', () => {
    expect(MONEDAS_POR_PAIS.AR).toContain('ARS');
    expect(MONEDAS_POR_PAIS.AR).not.toContain('UYU');
    expect(MONEDAS_POR_PAIS.UY).toContain('UYU');
    expect(MONEDAS_POR_PAIS.UY).not.toContain('ARS');
  });
});

describe('lib/money — computeNeto (sin cambios, regresión)', () => {
  it('cálculo bruto → neto con comisión %', () => {
    const r = computeNeto(100, 5); // 100 - 5% = 95
    expect(r.bruto).toBe(100);
    expect(r.pct).toBe(5);
    expect(r.comision).toBe(5);
    expect(r.neto).toBe(95);
  });

  it('sin comisión (pct=null) → comision=0, neto=bruto', () => {
    const r = computeNeto(200, null);
    expect(r.comision).toBe(0);
    expect(r.neto).toBe(200);
  });
});

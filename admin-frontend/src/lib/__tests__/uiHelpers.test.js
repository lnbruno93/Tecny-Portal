// Tests de derivaciones canónicas de tenant (TANDA 5 audit 2026-06-22).
//
// Estos helpers son la única fuente de "estado del tenant" que ve el
// super-admin. Si getTenantStatus devuelve un valor inválido o healthProxy
// retorna NaN, las badges en Resumen/Clientes/Ficha muestran color random.
// Foco en defaults defensivos + edge cases de timestamps malformados.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getTenantStatus,
  planTone,
  planLabel,
  healthColor,
  tenantInitials,
  healthProxy,
  TENANT_STATUS,
  PLAN_TONES,
} from '../uiHelpers.js';

describe('getTenantStatus', () => {
  it('null/undefined → "active" (nunca devuelve undefined)', () => {
    // Contract: UI nunca debería tener que manejar undefined. El helper
    // devuelve un valor canónico que matchea una key de TENANT_STATUS.
    expect(getTenantStatus(null)).toBe('active');
    expect(getTenantStatus(undefined)).toBe('active');
  });

  it('suspended_at presente → "suspended" (gana sobre plan/trial)', () => {
    expect(getTenantStatus({ suspended_at: '2026-06-01', plan: 'pro' })).toBe('suspended');
    expect(getTenantStatus({ suspended_at: '2026-06-01', plan: 'trial' })).toBe('suspended');
  });

  it('plan="trial" → "trial"', () => {
    expect(getTenantStatus({ plan: 'trial' })).toBe('trial');
  });

  it('trial_until presente (cualquier plan) → "trial"', () => {
    // Edge: tenant pro con trial_until residual sigue siendo "trial"
    // hasta que se limpie. Mostrar "trial" es más conservador que
    // "active" para alertar al admin del dato sucio.
    expect(getTenantStatus({ plan: 'pro', trial_until: '2026-07-01' })).toBe('trial');
  });

  it('plan="pro" sin trial_until → "active"', () => {
    expect(getTenantStatus({ plan: 'pro' })).toBe('active');
    expect(getTenantStatus({ plan: 'starter' })).toBe('active');
  });

  it('todos los status devueltos existen en TENANT_STATUS', () => {
    // Property test: si alguien agrega un nuevo branch sin agregar la
    // entry correspondiente en TENANT_STATUS, este test atrapa el missing.
    const samples = [
      null,
      {},
      { suspended_at: 'x' },
      { plan: 'trial' },
      { plan: 'pro' },
      { trial_until: 'x' },
    ];
    for (const s of samples) {
      expect(TENANT_STATUS).toHaveProperty(getTenantStatus(s));
    }
  });
});

describe('planTone', () => {
  it('plan conocido → tone correcto', () => {
    expect(planTone('starter')).toBe('default');
    expect(planTone('pro')).toBe('info');
    expect(planTone('enterprise')).toBe('accent');
    expect(planTone('trial')).toBe('default');
  });

  it('plan en mayúsculas se normaliza (lowercase)', () => {
    expect(planTone('PRO')).toBe('info');
    expect(planTone('Enterprise')).toBe('accent');
  });

  it('null/undefined/desconocido → "default" (nunca undefined)', () => {
    expect(planTone(null)).toBe('default');
    expect(planTone(undefined)).toBe('default');
    expect(planTone('xxx-no-existe')).toBe('default');
    expect(planTone('')).toBe('default');
  });

  it('todos los tones devueltos son strings válidos', () => {
    for (const key of Object.keys(PLAN_TONES)) {
      expect(typeof planTone(key)).toBe('string');
    }
  });
});

describe('planLabel', () => {
  it('null/undefined/"" → "—"', () => {
    expect(planLabel(null)).toBe('—');
    expect(planLabel(undefined)).toBe('—');
    expect(planLabel('')).toBe('—');
  });

  it('capitaliza la primera letra', () => {
    expect(planLabel('starter')).toBe('Starter');
    expect(planLabel('PRO')).toBe('PRO'); // ya está capitalizada
    expect(planLabel('enterprise')).toBe('Enterprise');
  });
});

describe('healthColor', () => {
  it('devuelve un string CSS var en todos los rangos', () => {
    expect(healthColor(95)).toBe('var(--pos)');
    expect(healthColor(80)).toBe('var(--pos)');
    expect(healthColor(70)).toBe('var(--accent)');
    expect(healthColor(55)).toBe('var(--accent)');
    expect(healthColor(45)).toBe('var(--warn)');
    expect(healthColor(40)).toBe('var(--warn)');
    expect(healthColor(20)).toBe('var(--neg)');
    expect(healthColor(0)).toBe('var(--neg)');
  });

  it('negativo o > 100 NO crashea (devuelve algún color)', () => {
    expect(() => healthColor(-50)).not.toThrow();
    expect(() => healthColor(999)).not.toThrow();
  });
});

describe('tenantInitials', () => {
  it('null/"" → "?"', () => {
    expect(tenantInitials(null)).toBe('?');
    expect(tenantInitials(undefined)).toBe('?');
    expect(tenantInitials('')).toBe('?');
  });

  it('una palabra → primera letra', () => {
    expect(tenantInitials('Tecny')).toBe('T');
  });

  it('dos palabras → 2 iniciales', () => {
    expect(tenantInitials('Tecny SaaS')).toBe('TS');
  });

  it('tres+ palabras → solo las primeras 2', () => {
    expect(tenantInitials('Banco Industrial Argentino')).toBe('BI');
  });

  it('uppercase', () => {
    expect(tenantInitials('acme inc')).toBe('AI');
  });

  it('whitespace múltiple no rompe', () => {
    expect(tenantInitials('  Tecny    SaaS  ')).toBe('TS');
  });
});

describe('healthProxy', () => {
  const NOW = new Date('2026-06-22T12:00:00Z').getTime();

  afterEach(() => {
    vi.useRealTimers();
  });

  function freezeNow() {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  }

  it('null/undefined → 25 (señal "unknown")', () => {
    expect(healthProxy(null)).toBe(25);
    expect(healthProxy(undefined)).toBe(25);
    expect(healthProxy('')).toBe(25);
  });

  it('string corrupto que da NaN → 25 (defensive)', () => {
    // Bug clase: si lastActivityAt viene como string raro, new Date() da
    // Invalid Date, .getTime() devuelve NaN. Sin el guard isNaN(ts), el
    // cálculo `days = (Date.now() - NaN) / 86400000` da NaN, y los
    // `if (days < N)` dan TODOS false → entrarías al return 25 igual,
    // pero solo por accidente. El guard explícito previene confusión.
    expect(healthProxy('not-a-timestamp')).toBe(25);
    expect(healthProxy('garbage-XYZ')).toBe(25);
  });

  it('hace < 1 día → 95', () => {
    freezeNow();
    const iso = new Date(NOW - 2 * 3600 * 1000).toISOString();
    expect(healthProxy(iso)).toBe(95);
  });

  it('hace 3 días → 75', () => {
    freezeNow();
    const iso = new Date(NOW - 3 * 86400 * 1000).toISOString();
    expect(healthProxy(iso)).toBe(75);
  });

  it('hace 15 días → 50', () => {
    freezeNow();
    const iso = new Date(NOW - 15 * 86400 * 1000).toISOString();
    expect(healthProxy(iso)).toBe(50);
  });

  it('hace 60 días → 25 (cuenta enfriándose)', () => {
    freezeNow();
    const iso = new Date(NOW - 60 * 86400 * 1000).toISOString();
    expect(healthProxy(iso)).toBe(25);
  });
});

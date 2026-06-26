/**
 * Tests para lib/tenantHealth.js (#440).
 *
 * Función pura — sin DB ni mocks. Cubre:
 *   · Casos extremos (suspendido, sin datos, tenant nuevo)
 *   · Cada sub-scorer en sus thresholds clave
 *   · Promedio ponderado con la fórmula completa
 *   · Onboarding override
 *   · Categorización a etiquetas humanas
 *
 * Convención: fechas en tests usan offset relativo a NOW() para no
 * volverse stale. Si congelamos Date.now() en algún test, lo limpiamos
 * en afterEach.
 */

const {
  computeHealthScore,
  WEIGHTS,
  SEATS_BY_PLAN,
} = require('../src/lib/tenantHealth');

// Helper: tenant con created_at viejo (no onboarding) y sin suspended.
function makeTenant(overrides = {}) {
  return {
    id: 1,
    plan: 'pro',
    created_at: new Date(Date.now() - 90 * 86400000).toISOString(), // 90d atrás
    suspended_at: null,
    trial_until: null,
    paid_until: new Date(Date.now() + 30 * 86400000).toISOString(), // 30d adelante
    custom_mrr_usd: null,
    ...overrides,
  };
}

function makeStats(overrides = {}) {
  return {
    ventas_30d: 0,
    bot_msgs_30d: 0,
    users_count: 0,
    productos_count: 0,
    contactos_count: 0,
    cajas_count: 0,
    ventas_total: 0,
    alertas_count: 0,
    ...overrides,
  };
}

describe('tenantHealth.computeHealthScore', () => {
  describe('casos extremos', () => {
    it('tenant suspendido → score 0 y category=suspended', () => {
      const r = computeHealthScore({
        tenant: makeTenant({ suspended_at: new Date().toISOString() }),
        stats: makeStats({ ventas_30d: 100, users_count: 5 }), // datos saludables
      });
      expect(r.score).toBe(0);
      expect(r.category).toBe('suspended');
      // Breakdown todo en 0 — no calculamos sub-scorers.
      expect(r.breakdown).toEqual({
        actividad: 0, cobros: 0, adopcion: 0, asientos: 0,
      });
    });

    it('tenant sin datos y >7d desde signup → score bajo, category=cold', () => {
      const r = computeHealthScore({
        tenant: makeTenant({ paid_until: null }),
        stats: makeStats(),
      });
      // actividad=0 (sin ventas/bot), cobros=50 (neutro sin fecha),
      // adopcion=0, asientos=0 → 0.3*0 + 0.3*50 + 0.2*0 + 0.2*0 = 15
      expect(r.score).toBe(15);
      expect(r.category).toBe('cold');
    });

    it('tenant ideal: actividad alta + pago lejano + features + asientos', () => {
      const r = computeHealthScore({
        tenant: makeTenant(),
        stats: makeStats({
          ventas_30d: 25,
          users_count: 10,
          productos_count: 50,
          contactos_count: 30,
          cajas_count: 3,
          ventas_total: 80,
          alertas_count: 2,
        }),
      });
      // Todos los componentes en 100. Score esperado = 100.
      expect(r.score).toBe(100);
      expect(r.category).toBe('excellent');
    });
  });

  describe('onboarding override', () => {
    it('tenant <7 días → category=onboarding y score >= 50 aunque todo esté en 0', () => {
      const r = computeHealthScore({
        tenant: makeTenant({
          created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
          paid_until: null,
        }),
        stats: makeStats(),
      });
      expect(r.category).toBe('onboarding');
      expect(r.score).toBeGreaterThanOrEqual(50);
    });

    it('tenant <7 días con score natural alto → mantiene su score', () => {
      const r = computeHealthScore({
        tenant: makeTenant({
          created_at: new Date(Date.now() - 1 * 86400000).toISOString(),
        }),
        stats: makeStats({
          ventas_30d: 25, users_count: 10, productos_count: 5,
          contactos_count: 5, cajas_count: 1, ventas_total: 25, alertas_count: 1,
        }),
      });
      expect(r.category).toBe('onboarding');
      expect(r.score).toBe(100); // alto natural — no se topea
    });

    it('tenant exactamente 7 días → ya NO es onboarding', () => {
      const r = computeHealthScore({
        tenant: makeTenant({
          created_at: new Date(Date.now() - 7 * 86400000 - 1000).toISOString(),
          paid_until: null,
        }),
        stats: makeStats(),
      });
      expect(r.category).not.toBe('onboarding');
    });
  });

  describe('sub-scorer: actividad', () => {
    const baseTenant = makeTenant({ paid_until: null }); // cobros=50 fijo

    it('sin ventas ni bot → 0', () => {
      const r = computeHealthScore({ tenant: baseTenant, stats: makeStats() });
      expect(r.breakdown.actividad).toBe(0);
    });

    it('1 venta → 40 ("hay vida")', () => {
      const r = computeHealthScore({ tenant: baseTenant, stats: makeStats({ ventas_30d: 1 }) });
      expect(r.breakdown.actividad).toBe(40);
    });

    it('5 ventas → 70', () => {
      const r = computeHealthScore({ tenant: baseTenant, stats: makeStats({ ventas_30d: 5 }) });
      expect(r.breakdown.actividad).toBe(70);
    });

    it('20+ ventas → 100', () => {
      const r = computeHealthScore({ tenant: baseTenant, stats: makeStats({ ventas_30d: 50 }) });
      expect(r.breakdown.actividad).toBe(100);
    });

    it('100+ bot messages aunque sin ventas → 100', () => {
      const r = computeHealthScore({ tenant: baseTenant, stats: makeStats({ bot_msgs_30d: 150 }) });
      expect(r.breakdown.actividad).toBe(100);
    });

    it('toma el max entre ventas y bot', () => {
      const r = computeHealthScore({
        tenant: baseTenant,
        stats: makeStats({ ventas_30d: 1, bot_msgs_30d: 50 }),
      });
      // ventas=40, bot=70 → max=70
      expect(r.breakdown.actividad).toBe(70);
    });
  });

  describe('sub-scorer: cobros', () => {
    const baseStats = makeStats();

    it('paid_until vencido → 0', () => {
      const r = computeHealthScore({
        tenant: makeTenant({ paid_until: new Date(Date.now() - 5 * 86400000).toISOString() }),
        stats: baseStats,
      });
      expect(r.breakdown.cobros).toBe(0);
    });

    it('paid_until en <3 días → 30 (crítico)', () => {
      const r = computeHealthScore({
        tenant: makeTenant({ paid_until: new Date(Date.now() + 2 * 86400000).toISOString() }),
        stats: baseStats,
      });
      expect(r.breakdown.cobros).toBe(30);
    });

    it('paid_until en >=30 días → 100', () => {
      const r = computeHealthScore({
        tenant: makeTenant({ paid_until: new Date(Date.now() + 60 * 86400000).toISOString() }),
        stats: baseStats,
      });
      expect(r.breakdown.cobros).toBe(100);
    });

    it('sin paid_until ni trial_until → 50 (neutro)', () => {
      const r = computeHealthScore({
        tenant: makeTenant({ paid_until: null, plan: 'pro' }),
        stats: baseStats,
      });
      expect(r.breakdown.cobros).toBe(50);
    });

    it('trial con trial_until vigente >=30d → 100', () => {
      const r = computeHealthScore({
        tenant: makeTenant({
          plan: 'trial',
          trial_until: new Date(Date.now() + 45 * 86400000).toISOString(),
          paid_until: null,
        }),
        stats: baseStats,
      });
      expect(r.breakdown.cobros).toBe(100);
    });

    it('enterprise grandfathered (sin paid_until + con custom_mrr_usd) → 100', () => {
      const r = computeHealthScore({
        tenant: makeTenant({ plan: 'enterprise', paid_until: null, custom_mrr_usd: 500 }),
        stats: baseStats,
      });
      expect(r.breakdown.cobros).toBe(100);
    });
  });

  describe('sub-scorer: adopcion', () => {
    const baseTenant = makeTenant({ paid_until: null });

    it('sin nada → 0', () => {
      const r = computeHealthScore({ tenant: baseTenant, stats: makeStats() });
      expect(r.breakdown.adopcion).toBe(0);
    });

    it('un feature usado → 20', () => {
      const r = computeHealthScore({
        tenant: baseTenant,
        stats: makeStats({ productos_count: 5 }),
      });
      expect(r.breakdown.adopcion).toBe(20);
    });

    it('los 5 features → 100', () => {
      const r = computeHealthScore({
        tenant: baseTenant,
        stats: makeStats({
          productos_count: 1, contactos_count: 1, cajas_count: 1,
          ventas_total: 1, alertas_count: 1,
        }),
      });
      expect(r.breakdown.adopcion).toBe(100);
    });
  });

  describe('sub-scorer: asientos', () => {
    const baseTenant = makeTenant({ paid_until: null });

    it('plan trial con 1 user (cap=2) → 50', () => {
      const r = computeHealthScore({
        tenant: makeTenant({ plan: 'trial', paid_until: null }),
        stats: makeStats({ users_count: 1 }),
      });
      expect(r.breakdown.asientos).toBe(50);
    });

    it('plan pro con 5 users (cap=10) → 50', () => {
      const r = computeHealthScore({
        tenant: baseTenant,
        stats: makeStats({ users_count: 5 }),
      });
      expect(r.breakdown.asientos).toBe(50);
    });

    it('plan pro con 10 users (cap=10) → 100', () => {
      const r = computeHealthScore({
        tenant: baseTenant,
        stats: makeStats({ users_count: 10 }),
      });
      expect(r.breakdown.asientos).toBe(100);
    });

    it('plan pro con 20 users (over cap) → clamped a 100', () => {
      const r = computeHealthScore({
        tenant: baseTenant,
        stats: makeStats({ users_count: 20 }),
      });
      expect(r.breakdown.asientos).toBe(100);
    });
  });

  describe('categorización', () => {
    const baseStats = makeStats();
    // Construimos un score "casi puro" del componente cobros para ir variando.

    it('score >= 80 → excellent', () => {
      // Cobros=100 + actividad=100 + asientos=100 + adopcion=100 = 100
      const r = computeHealthScore({
        tenant: makeTenant(),
        stats: makeStats({
          ventas_30d: 100, users_count: 100,
          productos_count: 1, contactos_count: 1, cajas_count: 1,
          ventas_total: 1, alertas_count: 1,
        }),
      });
      expect(r.category).toBe('excellent');
    });

    it('score 55-79 → healthy', () => {
      const r = computeHealthScore({
        tenant: makeTenant(),
        stats: makeStats({ ventas_30d: 5, users_count: 5, productos_count: 1, contactos_count: 1 }),
      });
      // actividad=70, cobros=100, asientos=50, adopcion=40
      // = 0.3*70 + 0.3*100 + 0.2*40 + 0.2*50 = 21 + 30 + 8 + 10 = 69
      expect(r.score).toBeGreaterThanOrEqual(55);
      expect(r.score).toBeLessThan(80);
      expect(r.category).toBe('healthy');
    });

    it('score 40-54 → at-risk', () => {
      const r = computeHealthScore({
        tenant: makeTenant({ paid_until: null }),
        stats: makeStats({ ventas_30d: 1, productos_count: 1, contactos_count: 1 }),
      });
      // actividad=40, cobros=50 (sin fecha), adopcion=40, asientos=0
      // = 12 + 15 + 8 + 0 = 35  — hmm muy bajo. Bumpear users.
      // Subo users a 5 (asientos 50). Sería 12 + 15 + 8 + 10 = 45.
      const r2 = computeHealthScore({
        tenant: makeTenant({ paid_until: null }),
        stats: makeStats({
          ventas_30d: 1, productos_count: 1, contactos_count: 1, users_count: 5,
        }),
      });
      expect(r2.score).toBeGreaterThanOrEqual(40);
      expect(r2.score).toBeLessThan(55);
      expect(r2.category).toBe('at-risk');
    });

    it('score <40 → cold', () => {
      const r = computeHealthScore({
        tenant: makeTenant({ paid_until: null }),
        stats: makeStats(),
      });
      expect(r.score).toBeLessThan(40);
      expect(r.category).toBe('cold');
    });
  });

  describe('invariantes', () => {
    it('WEIGHTS suman 1.0', () => {
      const sum = WEIGHTS.actividad + WEIGHTS.cobros + WEIGHTS.adopcion + WEIGHTS.asientos;
      expect(sum).toBeCloseTo(1.0, 5);
    });

    it('SEATS_BY_PLAN tiene los 4 planes canónicos', () => {
      expect(Object.keys(SEATS_BY_PLAN).sort()).toEqual(
        ['enterprise', 'pro', 'starter', 'trial']
      );
    });

    it('score siempre está en [0, 100]', () => {
      // Caso extremo: todos los inputs al máximo.
      const r = computeHealthScore({
        tenant: makeTenant(),
        stats: makeStats({
          ventas_30d: 1e6, bot_msgs_30d: 1e6, users_count: 1e6,
          productos_count: 1e6, contactos_count: 1e6, cajas_count: 1e6,
          ventas_total: 1e6, alertas_count: 1e6,
        }),
      });
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    });
  });

  describe('robustez ante datos faltantes', () => {
    it('tenant null/undefined no rompe', () => {
      expect(() => computeHealthScore({ tenant: null, stats: makeStats() })).not.toThrow();
      expect(() => computeHealthScore({ tenant: undefined, stats: makeStats() })).not.toThrow();
    });

    it('stats vacíos no rompen', () => {
      expect(() => computeHealthScore({ tenant: makeTenant(), stats: {} })).not.toThrow();
      const r = computeHealthScore({ tenant: makeTenant(), stats: {} });
      expect(Number.isFinite(r.score)).toBe(true);
    });

    it('fechas inválidas no rompen (tratan como ausentes)', () => {
      const r = computeHealthScore({
        tenant: makeTenant({ paid_until: 'not-a-date', created_at: 'también-no' }),
        stats: makeStats(),
      });
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.breakdown.cobros).toBe(50); // fallback neutro
    });
  });
});

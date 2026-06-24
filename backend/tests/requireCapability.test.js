/**
 * Tests del middleware requireCapability (Permisos F1).
 *
 * Mock de DB — el middleware ejerce 3 paths:
 *   1. Bypass por role legacy admin → next() sin DB.
 *   2. Bypass por tenant_cap_rol (owner/admin tenant) en JWT → next().
 *   3. Fast path: caps embebidas en JWT → check O(1) en memoria.
 *   4. Fallback DB: query a tenant_user_roles + user_capabilities.
 *
 * Validamos cada path con un req mock y next/res spies.
 */

// Mock TOTAL del módulo de DB ANTES de cargar el middleware.
jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withTenant: jest.fn(),
}));
jest.mock('../src/lib/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const db = require('../src/config/database');
const requireCapability = require('../src/middleware/requireCapability');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('requireCapability — bypass legacy admin', () => {
  it('users.role=admin pasa sin pegar a DB', async () => {
    const mw = requireCapability('ventas.eliminar');
    const req = { user: { id: 1, role: 'admin' } };
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(db.withTenant).not.toHaveBeenCalled();
  });
});

describe('requireCapability — bypass tenant_cap_rol', () => {
  it('tenant_cap_rol=owner pasa sin pegar a DB', async () => {
    const mw = requireCapability('proyectos.eliminar');
    const req = { user: { id: 2, role: 'op', tenant_cap_rol: 'owner' } };
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it('tenant_cap_rol=admin pasa sin pegar a DB', async () => {
    const mw = requireCapability('inventario.vaciar_stock');
    const req = { user: { id: 3, role: 'op', tenant_cap_rol: 'admin' } };
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requireCapability — fast path JWT caps', () => {
  it('caps embebidas con la cap requerida → next()', async () => {
    const mw = requireCapability('ventas.eliminar');
    const req = {
      user: { id: 4, role: 'op', tenant_cap_rol: 'vendedor',
              caps: { 'ventas.trabajar': true, 'ventas.eliminar': true } },
    };
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it('caps embebidas SIN la cap requerida → 403', async () => {
    const mw = requireCapability('ventas.eliminar');
    const req = {
      user: { id: 5, role: 'op', tenant_cap_rol: 'vendedor',
              caps: { 'ventas.trabajar': true } },
    };
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringMatching(/permiso/i) });
  });

  it('caps embebidas vacías {} → 403 sin DB', async () => {
    const mw = requireCapability('cajas.ver');
    const req = {
      user: { id: 6, role: 'op', tenant_cap_rol: 'custom', caps: {} },
    };
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(db.withTenant).not.toHaveBeenCalled();
  });
});

describe('requireCapability — fallback DB', () => {
  it('sin caps en JWT pero rol owner devuelto por DB → next()', async () => {
    // resolveUserTenant + withTenant mockeados vía permissions chain.
    // Más simple: mock directo de loadUserCaps via require.
    jest.resetModules();
    jest.mock('../src/lib/capabilities', () => ({
      loadUserCaps: jest.fn().mockResolvedValue({
        rol: 'owner', caps: null, tenantId: 1, overrides: [],
      }),
    }));
    jest.mock('../src/lib/roleDefaults', () => ({
      isBypassRole: (r) => r === 'owner' || r === 'admin',
    }));
    const mwFresh = require('../src/middleware/requireCapability');
    const req = { user: { id: 7, role: 'op' } }; // sin caps ni tenant_cap_rol
    const res = makeRes();
    const next = jest.fn();

    await mwFresh('ventas.eliminar')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sin caps en JWT, rol vendedor sin la cap → 403', async () => {
    jest.resetModules();
    jest.mock('../src/lib/capabilities', () => ({
      loadUserCaps: jest.fn().mockResolvedValue({
        rol: 'vendedor', caps: new Set(['ventas.trabajar']), tenantId: 1, overrides: [],
      }),
    }));
    jest.mock('../src/lib/roleDefaults', () => ({
      isBypassRole: (r) => r === 'owner' || r === 'admin',
    }));
    const mwFresh = require('../src/middleware/requireCapability');
    const req = { user: { id: 8, role: 'op' } };
    const res = makeRes();
    const next = jest.fn();

    await mwFresh('ventas.eliminar')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('sin caps en JWT, rol vendedor con la cap (override) → next()', async () => {
    jest.resetModules();
    jest.mock('../src/lib/capabilities', () => ({
      loadUserCaps: jest.fn().mockResolvedValue({
        rol: 'vendedor', caps: new Set(['ventas.trabajar', 'ventas.eliminar']), tenantId: 1, overrides: [],
      }),
    }));
    jest.mock('../src/lib/roleDefaults', () => ({
      isBypassRole: (r) => r === 'owner' || r === 'admin',
    }));
    const mwFresh = require('../src/middleware/requireCapability');
    const req = { user: { id: 9, role: 'op' } };
    const res = makeRes();
    const next = jest.fn();

    await mwFresh('ventas.eliminar')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─── requireAnyCapability (F5c) ──────────────────────────────────────────────
//
// Variante OR del middleware: el user pasa si tiene AL MENOS una de las
// capabilities del array. Lo usa /api/config que se monta con anyCap=
// ['config.general', 'config.alertas', 'config.mantenimiento'] — cualquiera
// que pueda ver alguno de los 3 tabs puede entrar al módulo.

const { requireAnyCapability } = require('../src/middleware/requireCapability');

describe('requireAnyCapability — guard contra mal uso', () => {
  it('array vacío tira error sincrónico (no devuelve middleware)', () => {
    expect(() => requireAnyCapability([])).toThrow(/array no vacío/);
  });

  it('argumento no-array tira error', () => {
    expect(() => requireAnyCapability('config.general')).toThrow(/array no vacío/);
  });
});

describe('requireAnyCapability — bypass por rol', () => {
  it('admin global bypassea sin DB', async () => {
    const mw = requireAnyCapability(['config.general', 'config.alertas']);
    const req = { user: { id: 1, role: 'admin' } };
    const res = makeRes();
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('tenant_cap_rol owner bypassea sin DB', async () => {
    const mw = requireAnyCapability(['config.general', 'config.alertas']);
    const req = { user: { id: 2, role: 'op', tenant_cap_rol: 'owner' } };
    const res = makeRes();
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requireAnyCapability — fast path JWT caps', () => {
  it('0-de-N → 403', async () => {
    const mw = requireAnyCapability(['config.general', 'config.alertas', 'config.mantenimiento']);
    const req = {
      user: { id: 3, role: 'op', tenant_cap_rol: 'vendedor',
              caps: { 'ventas.trabajar': true } },
    };
    const res = makeRes();
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('1-de-N (primera del array) → next()', async () => {
    const mw = requireAnyCapability(['config.general', 'config.alertas', 'config.mantenimiento']);
    const req = {
      user: { id: 4, role: 'op', tenant_cap_rol: 'custom',
              caps: { 'config.general': true } },
    };
    const res = makeRes();
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('1-de-N en posición middle → next() (no toma solo el primero)', async () => {
    const mw = requireAnyCapability(['config.general', 'config.alertas', 'config.mantenimiento']);
    const req = {
      user: { id: 5, role: 'op', tenant_cap_rol: 'custom',
              caps: { 'config.alertas': true } },
    };
    const res = makeRes();
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('N-de-N → next()', async () => {
    const mw = requireAnyCapability(['config.general', 'config.alertas']);
    const req = {
      user: { id: 6, role: 'op', tenant_cap_rol: 'custom',
              caps: { 'config.general': true, 'config.alertas': true } },
    };
    const res = makeRes();
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requireAnyCapability — fallback DB', () => {
  it('sin caps en JWT, rol con AL MENOS UNA cap → next()', async () => {
    jest.resetModules();
    jest.mock('../src/lib/capabilities', () => ({
      loadUserCaps: jest.fn().mockResolvedValue({
        rol: 'custom',
        caps: new Set(['config.alertas']),
        tenantId: 1,
        overrides: [],
      }),
    }));
    jest.mock('../src/lib/roleDefaults', () => ({
      isBypassRole: (r) => r === 'owner' || r === 'admin',
    }));
    const { requireAnyCapability: mwFactory } = require('../src/middleware/requireCapability');
    const req = { user: { id: 7, role: 'op' } };
    const res = makeRes();
    const next = jest.fn();
    await mwFactory(['config.general', 'config.alertas', 'config.mantenimiento'])(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sin caps en JWT, rol sin ninguna de las caps → 403', async () => {
    jest.resetModules();
    jest.mock('../src/lib/capabilities', () => ({
      loadUserCaps: jest.fn().mockResolvedValue({
        rol: 'vendedor',
        caps: new Set(['ventas.trabajar']),
        tenantId: 1,
        overrides: [],
      }),
    }));
    jest.mock('../src/lib/roleDefaults', () => ({
      isBypassRole: (r) => r === 'owner' || r === 'admin',
    }));
    const { requireAnyCapability: mwFactory } = require('../src/middleware/requireCapability');
    const req = { user: { id: 8, role: 'op' } };
    const res = makeRes();
    const next = jest.fn();
    await mwFactory(['config.general', 'config.alertas', 'config.mantenimiento'])(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

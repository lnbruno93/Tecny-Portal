/**
 * Tests unitarios para lib/capabilities + lib/roleDefaults (Permisos F1).
 *
 * Cubre la lógica pura del resolver:
 *   · Rol owner/admin → null (bypass total).
 *   · Rol vendedor/encargado/lectura → Set con sus defaults.
 *   · Rol custom → Set vacío.
 *   · Overrides enabled=true agregan capabilities.
 *   · Overrides enabled=false retiran del set base del rol.
 *   · Overrides con slug fuera del catálogo → se ignoran silenciosamente.
 *   · capsForJwt: shape objeto plano para JWT.
 *
 * No requiere DB — son funciones puras.
 */

const { resolveCaps, capsForJwt } = require('../src/lib/capabilities');
const { isBypassRole, getRoleDefaultCaps } = require('../src/lib/roleDefaults');
const { ALL_SLUGS } = require('../src/lib/capabilityCatalog');

describe('roleDefaults', () => {
  it('owner y admin son bypass', () => {
    expect(isBypassRole('owner')).toBe(true);
    expect(isBypassRole('admin')).toBe(true);
  });

  it('vendedor, encargado, lectura, custom NO son bypass', () => {
    expect(isBypassRole('vendedor')).toBe(false);
    expect(isBypassRole('encargado')).toBe(false);
    expect(isBypassRole('lectura')).toBe(false);
    expect(isBypassRole('custom')).toBe(false);
  });

  it('rol desconocido fallea como custom (no bypass, 0 caps)', () => {
    expect(isBypassRole('nope')).toBe(false);
    expect(getRoleDefaultCaps('nope').size).toBe(0);
  });

  it('todos los slugs del role defaults están en el catálogo', () => {
    for (const rol of ['vendedor', 'encargado', 'lectura']) {
      const set = getRoleDefaultCaps(rol);
      for (const slug of set) {
        expect(ALL_SLUGS.has(slug)).toBe(true);
      }
    }
  });

  it('vendedor carga el set mínimo esperado', () => {
    const set = getRoleDefaultCaps('vendedor');
    expect(set.has('ventas.trabajar')).toBe(true);
    expect(set.has('b2b.trabajar')).toBe(true);
    expect(set.has('inventario.ver')).toBe(true);
    expect(set.has('inventario.ver_costos')).toBe(false); // NO ve costos
    expect(set.has('cajas.ver')).toBe(false);             // NO ve cajas
  });

  it('encargado extiende vendedor con cajas read-only', () => {
    const set = getRoleDefaultCaps('encargado');
    expect(set.has('cajas.ver')).toBe(true);
    expect(set.has('egresos.ver')).toBe(true);
    expect(set.has('inventario.ver_costos')).toBe(true);
    expect(set.has('cajas.crear')).toBe(false); // solo ver
  });

  it('lectura ve plata pero NO opera', () => {
    const set = getRoleDefaultCaps('lectura');
    expect(set.has('cajas.ver')).toBe(true);
    expect(set.has('cajas.ver_360_capital')).toBe(true);
    expect(set.has('historial.ver')).toBe(true);
    expect(set.has('ventas.trabajar')).toBe(false); // no opera
    expect(set.has('inventario.importar')).toBe(false);
  });

  it('custom arranca con 0 caps', () => {
    expect(getRoleDefaultCaps('custom').size).toBe(0);
  });
});

describe('resolveCaps', () => {
  it('owner y admin devuelven null (bypass)', () => {
    expect(resolveCaps('owner', [])).toBe(null);
    expect(resolveCaps('admin', [])).toBe(null);
    // Aún con overrides, owner/admin sigue bypass.
    expect(resolveCaps('owner', [{ capability_slug: 'ventas.eliminar', enabled: false }])).toBe(null);
  });

  it('custom sin overrides → set vacío', () => {
    const caps = resolveCaps('custom', []);
    expect(caps).toBeInstanceOf(Set);
    expect(caps.size).toBe(0);
  });

  it('custom + override enabled=true → set con esa cap', () => {
    const caps = resolveCaps('custom', [
      { capability_slug: 'ventas.trabajar', enabled: true },
      { capability_slug: 'ventas.eliminar', enabled: true },
    ]);
    expect(caps.has('ventas.trabajar')).toBe(true);
    expect(caps.has('ventas.eliminar')).toBe(true);
    expect(caps.size).toBe(2);
  });

  it('vendedor + override enabled=true agrega capability extra', () => {
    const caps = resolveCaps('vendedor', [
      { capability_slug: 'cajas.ver', enabled: true },
    ]);
    expect(caps.has('cajas.ver')).toBe(true);
    expect(caps.has('ventas.trabajar')).toBe(true); // del default
  });

  it('vendedor + override enabled=false retira capability del default', () => {
    const caps = resolveCaps('vendedor', [
      { capability_slug: 'envios.trabajar', enabled: false },
    ]);
    expect(caps.has('envios.trabajar')).toBe(false);
    expect(caps.has('ventas.trabajar')).toBe(true); // default sigue
  });

  // 2026-07-04 — nuevo permiso ventas.ver_ganancias (ocultar ganancia/margen
  // en Ventas/Dashboard/Resumen). Contrato del resolver para esta cap:
  //   · owner/admin: null (bypass — todos los endpoints ven todo)
  //   · vendedor/encargado/lectura sin override: NO tienen la cap
  //   · vendedor con override enabled=true: SÍ la tiene
  it('ventas.ver_ganancias: owner/admin devuelven null (bypass)', () => {
    expect(resolveCaps('owner', [])).toBe(null);
    expect(resolveCaps('admin', [])).toBe(null);
  });

  it('ventas.ver_ganancias: vendedor sin override NO la tiene', () => {
    const caps = resolveCaps('vendedor', []);
    expect(caps.has('ventas.ver_ganancias')).toBe(false);
  });

  it('ventas.ver_ganancias: encargado sin override NO la tiene', () => {
    const caps = resolveCaps('encargado', []);
    expect(caps.has('ventas.ver_ganancias')).toBe(false);
  });

  it('ventas.ver_ganancias: vendedor con override enabled=true SÍ la tiene', () => {
    const caps = resolveCaps('vendedor', [
      { capability_slug: 'ventas.ver_ganancias', enabled: true },
    ]);
    expect(caps.has('ventas.ver_ganancias')).toBe(true);
    // El resto del set default sigue intacto.
    expect(caps.has('ventas.trabajar')).toBe(true);
  });

  it('override sobre slug fuera del catálogo se ignora silenciosamente', () => {
    const caps = resolveCaps('custom', [
      { capability_slug: 'fake.cap', enabled: true },
      { capability_slug: 'ventas.trabajar', enabled: true },
    ]);
    expect(caps.has('fake.cap')).toBe(false);
    expect(caps.has('ventas.trabajar')).toBe(true);
    expect(caps.size).toBe(1);
  });

  it('NO muta el Set del rol default (defensive)', () => {
    const before = getRoleDefaultCaps('vendedor').size;
    resolveCaps('vendedor', [{ capability_slug: 'inventario.exportar', enabled: true }]);
    const after = getRoleDefaultCaps('vendedor').size;
    expect(after).toBe(before);
  });

  it('último override gana cuando hay duplicados', () => {
    const caps = resolveCaps('vendedor', [
      { capability_slug: 'cajas.ver', enabled: true },
      { capability_slug: 'cajas.ver', enabled: false }, // este gana
    ]);
    expect(caps.has('cajas.ver')).toBe(false);
  });
});

describe('capsForJwt', () => {
  it('owner/admin (caps=null) devuelve undefined', () => {
    expect(capsForJwt('owner', null)).toBeUndefined();
    expect(capsForJwt('admin', null)).toBeUndefined();
  });

  it('custom sin caps → objeto vacío', () => {
    expect(capsForJwt('custom', new Set())).toEqual({});
  });

  it('vendedor con caps default → objeto plano { slug: true }', () => {
    const caps = resolveCaps('vendedor', []);
    const jwt = capsForJwt('vendedor', caps);
    expect(jwt['ventas.trabajar']).toBe(true);
    expect(jwt['b2b.trabajar']).toBe(true);
    // Sin claves false — solo los enabled.
    for (const v of Object.values(jwt)) expect(v).toBe(true);
  });

  it('shape es serializable a JSON (no Set, no Map)', () => {
    const caps = resolveCaps('lectura', []);
    const jwt = capsForJwt('lectura', caps);
    expect(() => JSON.stringify(jwt)).not.toThrow();
    expect(typeof jwt).toBe('object');
    expect(Array.isArray(jwt)).toBe(false);
  });
});

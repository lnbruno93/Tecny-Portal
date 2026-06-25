// Tests del helper userHasCap / userHasAnyCap (F5c).
//
// Espejo del middleware backend requireCapability — cualquier divergencia
// abre un escenario donde frontend muestra/esconde algo distinto a lo que
// el backend autoriza. Cubre los 5 paths de bypass + el branch sentinel
// caps===null (server-side bypass) que era el más fácil de romper.

import { describe, it, expect } from 'vitest';
import { userHasCap, userHasAnyCap, isTenantAdmin } from './userHasCap';

describe('userHasCap', () => {
  it('user null → false', () => {
    expect(userHasCap(null, 'ventas.trabajar')).toBe(false);
    expect(userHasCap(undefined, 'ventas.trabajar')).toBe(false);
  });

  it('role admin global → true sin importar caps', () => {
    expect(userHasCap({ role: 'admin' }, 'cualquier.cosa')).toBe(true);
    expect(userHasCap({ role: 'admin', caps: [] }, 'inventario.ver_costos')).toBe(true);
  });

  it('tenant_cap_rol owner → true sin importar caps', () => {
    expect(userHasCap({ role: 'op', tenant_cap_rol: 'owner' }, 'cajas.crear')).toBe(true);
  });

  it('tenant_cap_rol admin → true sin importar caps', () => {
    expect(userHasCap({ role: 'op', tenant_cap_rol: 'admin' }, 'ventas.eliminar')).toBe(true);
  });

  it('caps===null (sentinel server-side bypass) → true', () => {
    // El backend serializa null cuando el rol bypassa la enumeración.
    // Si el helper trata caps=null como "0 caps", esconde TODO incluso a owners.
    expect(userHasCap({ role: 'op', caps: null }, 'inventario.ver_costos')).toBe(true);
  });

  it('caps array contiene el slug → true', () => {
    const user = { role: 'op', tenant_cap_rol: 'vendedor', caps: ['ventas.trabajar', 'inventario.ver'] };
    expect(userHasCap(user, 'ventas.trabajar')).toBe(true);
    expect(userHasCap(user, 'inventario.ver')).toBe(true);
  });

  it('caps array NO contiene el slug → false', () => {
    const user = { role: 'op', tenant_cap_rol: 'vendedor', caps: ['ventas.trabajar'] };
    expect(userHasCap(user, 'cajas.crear')).toBe(false);
    expect(userHasCap(user, 'inventario.ver_costos')).toBe(false);
  });

  it('caps array vacío → false (excepto bypass por rol)', () => {
    expect(userHasCap({ role: 'op', tenant_cap_rol: 'custom', caps: [] }, 'cualquier.cosa')).toBe(false);
  });

  it('caps undefined (no en JWT) → false sin bypass', () => {
    expect(userHasCap({ role: 'op', tenant_cap_rol: 'vendedor' }, 'ventas.trabajar')).toBe(false);
  });
});

describe('userHasAnyCap', () => {
  it('user null → false', () => {
    expect(userHasAnyCap(null, ['config.general'])).toBe(false);
  });

  it('admin global bypassa', () => {
    expect(userHasAnyCap({ role: 'admin' }, ['config.general', 'config.alertas'])).toBe(true);
  });

  it('tenant_cap_rol owner bypassa', () => {
    expect(userHasAnyCap({ role: 'op', tenant_cap_rol: 'owner' }, ['x.y', 'a.b'])).toBe(true);
  });

  it('caps===null bypassa', () => {
    expect(userHasAnyCap({ role: 'op', caps: null }, ['x.y'])).toBe(true);
  });

  it('al menos una cap del array está en user.caps → true', () => {
    const user = { role: 'op', caps: ['config.alertas'] };
    expect(userHasAnyCap(user, ['config.general', 'config.alertas', 'config.mantenimiento'])).toBe(true);
  });

  it('ninguna cap del array está en user.caps → false', () => {
    const user = { role: 'op', caps: ['ventas.trabajar'] };
    expect(userHasAnyCap(user, ['config.general', 'config.alertas'])).toBe(false);
  });

  it('slugs no es array → false (defensa contra typo en caller)', () => {
    const user = { role: 'op', caps: ['ventas.trabajar'] };
    expect(userHasAnyCap(user, 'config.general')).toBe(false);
    expect(userHasAnyCap(user, null)).toBe(false);
  });

  it('slugs array vacío → false (sin bypass)', () => {
    const user = { role: 'op', caps: ['ventas.trabajar'] };
    expect(userHasAnyCap(user, [])).toBe(false);
  });

  it('caps undefined → false sin bypass', () => {
    expect(userHasAnyCap({ role: 'op' }, ['config.general'])).toBe(false);
  });
});

// 2026-06-25 Bug #1 (primer cliente real): isTenantAdmin centraliza el check
// "puede hacer cosas de admin" para gating de UI. Antes había `user.role
// === 'admin'` esparcido que ignoraba tenant_cap_rol y bloqueaba owners.
describe('isTenantAdmin', () => {
  it('user null/undefined → false', () => {
    expect(isTenantAdmin(null)).toBe(false);
    expect(isTenantAdmin(undefined)).toBe(false);
  });

  it('role admin global → true (super-admin de la plataforma)', () => {
    expect(isTenantAdmin({ role: 'admin' })).toBe(true);
  });

  it('tenant_cap_rol owner → true (caso del primer cliente real)', () => {
    expect(isTenantAdmin({ role: 'op', tenant_cap_rol: 'owner' })).toBe(true);
  });

  it('tenant_cap_rol admin → true', () => {
    expect(isTenantAdmin({ role: 'op', tenant_cap_rol: 'admin' })).toBe(true);
  });

  it('tenant_cap_rol vendedor/encargado/custom → false', () => {
    expect(isTenantAdmin({ role: 'op', tenant_cap_rol: 'vendedor' })).toBe(false);
    expect(isTenantAdmin({ role: 'op', tenant_cap_rol: 'encargado' })).toBe(false);
    expect(isTenantAdmin({ role: 'op', tenant_cap_rol: 'invitado' })).toBe(false);
    expect(isTenantAdmin({ role: 'op', tenant_cap_rol: 'custom' })).toBe(false);
  });

  it('role no-admin y sin tenant_cap_rol → false', () => {
    expect(isTenantAdmin({ role: 'op' })).toBe(false);
  });
});

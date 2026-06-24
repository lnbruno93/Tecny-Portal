// userHasCap.js — helper sincrónico para chequear capability del user logueado.
//
// 2026-06-23 F5c: centraliza la misma lógica que ya está en App.jsx
// (RequirePermission) y Shell.jsx (useVisibleNav). Permite que cualquier
// componente esconda secciones según caps sin duplicar el patrón.
//
// Reglas de bypass (mismas que el middleware backend):
//   1. users.role='admin' (global) → siempre true
//   2. user.tenant_cap_rol = 'owner' | 'admin' → siempre true
//   3. user.caps === null (sentinel server-side de bypass) → siempre true
//   4. user.caps es array y contiene el slug → true
//   5. cualquier otro caso → false
//
// Si user es null/undefined devuelve false (caller debería estar en una
// pantalla autenticada — si no, useAuth ya nos manda al login).
//
// 2026-06-24 TANDA 5 P1: cache Set por user.caps (WeakMap). Antes cada
// llamada hacía Array.prototype.includes() que es O(N). En el Sidebar
// useVisibleNav corre el helper por CADA nav item por CADA render → un
// "encargado" con ~22 caps × 20 items = ~440 comparaciones por render del
// Shell (que re-rendea con cada notification push, toast, route change).
// Con un Set memoizado por identity del array .caps, cada lookup es O(1).
// El WeakMap se invalida automáticamente cuando AuthContext setea un
// user.caps nuevo (re-login, refresh de /me) — no necesitamos manage
// lifetime explícito.

const _capsSetCache = new WeakMap();

function getCapsSet(caps) {
  if (!Array.isArray(caps)) return null;
  let set = _capsSetCache.get(caps);
  if (!set) {
    set = new Set(caps);
    _capsSetCache.set(caps, set);
  }
  return set;
}

export function userHasCap(user, slug) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.tenant_cap_rol === 'owner' || user.tenant_cap_rol === 'admin') return true;
  if (user.caps === null) return true; // server-side bypass sentinel
  const set = getCapsSet(user.caps);
  return set ? set.has(slug) : false;
}

// Conveniencia: chequea si tiene AL MENOS UNA de las caps del array.
// Útil para tabs donde el contenedor abre si el user puede ver cualquier
// sub-sección.
export function userHasAnyCap(user, slugs) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.tenant_cap_rol === 'owner' || user.tenant_cap_rol === 'admin') return true;
  if (user.caps === null) return true;
  if (!Array.isArray(slugs)) return false;
  const set = getCapsSet(user.caps);
  if (!set) return false;
  return slugs.some(s => set.has(s));
}

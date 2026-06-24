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

export function userHasCap(user, slug) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.tenant_cap_rol === 'owner' || user.tenant_cap_rol === 'admin') return true;
  if (user.caps === null) return true; // server-side bypass sentinel
  if (Array.isArray(user.caps) && user.caps.includes(slug)) return true;
  return false;
}

// Conveniencia: chequea si tiene AL MENOS UNA de las caps del array.
// Útil para tabs donde el contenedor abre si el user puede ver cualquier
// sub-sección.
export function userHasAnyCap(user, slugs) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.tenant_cap_rol === 'owner' || user.tenant_cap_rol === 'admin') return true;
  if (user.caps === null) return true;
  if (!Array.isArray(user.caps) || !Array.isArray(slugs)) return false;
  return slugs.some(s => user.caps.includes(s));
}

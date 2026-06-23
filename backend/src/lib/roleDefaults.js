// roleDefaults.js — definición de las capabilities default que carga cada
// rol predefinido. Source of truth en código (sin tabla en DB — los roles
// son enum cerrado; cambiar uno requiere deploy).
//
// Owner + admin son sentinels especiales (bypass total en el resolver).
// Custom no tiene defaults (Set vacío) — sus capabilities vienen 100%
// de user_capabilities (overrides).
//
// Los otros 3 roles (vendedor, encargado, lectura) son listas explícitas
// que matchean el mockup `PermisosPreview.jsx` consensuado con Lucas
// 2026-06-23. Cualquier ajuste de defaults se debe hacer acá Y comunicar
// a los tenants activos (cambiar el rol implica re-emitir tokens).

const VENDEDOR = new Set([
  'ventas.trabajar',
  'b2b.trabajar',
  'contactos.ver',
  'contactos.crear_borrar',
  'inventario.ver',
  'cotizador.trabajar',
  'usados.ver',
  'envios.trabajar',
]);

const ENCARGADO = new Set([
  'inicio.actividad_reciente',
  'resumen.ver',
  'ventas.trabajar',
  'ventas.exportar',
  'b2b.trabajar',
  'b2b.cobranza_masiva',
  'contactos.ver',
  'contactos.crear_borrar',
  'cajas.ver',
  'egresos.ver',
  'inventario.ver',
  'inventario.ver_costos',
  'inventario.ver_movimientos',
  'inventario.ver_compras',
  'inventario.exportar',
  'proveedores.trabajar',
  'cotizador.trabajar',
  'usados.ver',
  'usados.agregar_equipo',
  'usados.exportar',
  'envios.trabajar',
  'proyectos.trabajar',
]);

const LECTURA = new Set([
  'inicio.actividad_reciente',
  'resumen.ver',
  'cajas.ver',
  'cajas.ver_deudas',
  'cajas.ver_inversiones',
  'cajas.ver_360_capital',
  'cajas.conciliacion',
  'egresos.ver',
  'sanidad.trabajar',
  'inventario.ver',
  'inventario.ver_costos',
  'inventario.ver_movimientos',
  'inventario.ver_compras',
  'proveedores.trabajar',
  'tarjetas.trabajar',
  'cambios.trabajar',
  'financiera.trabajar',
  'usados.ver',
  'proyectos.trabajar',
  'proyectos.ver_costos',
  'historial.ver',
]);

// Map de rol → Set<slug>. Para owner/admin devolvemos null como sentinel
// que el resolver interpreta como "todas las capabilities" (bypass).
const ROLE_DEFAULTS = {
  owner:     null,
  admin:     null,
  vendedor:  VENDEDOR,
  encargado: ENCARGADO,
  lectura:   LECTURA,
  custom:    new Set(), // sin defaults — solo overrides
};

/**
 * Devuelve el Set de capability slugs default del rol. null = bypass total
 * (owner/admin no necesitan enumeración, el middleware retorna early).
 *
 * @param {string} rol
 * @returns {Set<string>|null}
 */
function getRoleDefaultCaps(rol) {
  if (!(rol in ROLE_DEFAULTS)) {
    // Rol desconocido — fail-safe: tratar como custom (0 caps), no bypass.
    return new Set();
  }
  return ROLE_DEFAULTS[rol];
}

/**
 * Indica si el rol es bypass total (owner o admin del tenant). El
 * middleware requireCapability puede next() sin enumerar caps.
 *
 * @param {string} rol
 * @returns {boolean}
 */
function isBypassRole(rol) {
  return rol === 'owner' || rol === 'admin';
}

module.exports = { getRoleDefaultCaps, isBypassRole, ROLE_DEFAULTS };

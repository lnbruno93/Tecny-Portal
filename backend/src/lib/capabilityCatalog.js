// capabilityCatalog.js — fuente de verdad EN CÓDIGO del catálogo de
// capabilities del portal (45 inicialmente).
//
// Hay 2 fuentes de verdad sincronizadas:
//   1. Tabla `capability_catalog` en la DB (seedeada en la migration
//      20260623155300). Lo que ve la UI cuando fetchea /api/capabilities/catalog.
//   2. Este archivo. Lo usan helpers backend (resolverCapabilities,
//      role defaults, tests) sin tener que pegar a la DB.
//
// Ambos DEBEN coincidir. Cuando se agrega/quita una capability:
//   - Update este archivo.
//   - Otra migration update sobre capability_catalog.
//   - Update PermisosPreview.jsx (mockup) o frontend Usuarios.jsx (F2).
//   - Actualizar roleDefaults.js si afecta a un rol predefinido.
//
// El test `capabilityCatalog.test.js` valida que esto matchea con lo que
// hay en DB (corre en CI con DB de test post-migration).

const PANTALLAS = [
  { id: 'inicio', label: 'Inicio', capabilities: [
    { id: 'actividad_reciente', label: 'Ver actividad reciente' },
  ]},
  { id: 'resumen', label: 'Resumen del mes', capabilities: [
    { id: 'ver', label: 'Ver Resumen del mes' },
  ]},
  { id: 'ventas', label: 'Ventas', capabilities: [
    { id: 'trabajar', label: 'Acceder al módulo' },
    { id: 'eliminar', label: 'Eliminar una venta' },
    { id: 'exportar', label: 'Exportar ventas' },
  ]},
  { id: 'b2b', label: 'Venta & Gestión B2B', capabilities: [
    { id: 'trabajar',        label: 'Acceder al módulo' },
    { id: 'cobranza_masiva', label: 'Hacer cobranza masiva' },
  ]},
  { id: 'contactos', label: 'Contactos', capabilities: [
    { id: 'ver',          label: 'Ver lista de contactos' },
    { id: 'crear_borrar', label: 'Agregar / eliminar contactos' },
  ]},
  { id: 'cajas', label: 'Cajas', capabilities: [
    { id: 'ver',             label: 'Ver cajas' },
    { id: 'crear',           label: 'Agregar caja' },
    { id: 'ver_deudas',      label: 'Ver deudas a cobrar' },
    { id: 'ver_inversiones', label: 'Ver inversiones' },
    { id: 'ver_360_capital', label: 'Ver 360 & Capital' },
    { id: 'conciliacion',    label: 'Conciliación bancaria' },
  ]},
  { id: 'egresos', label: 'Egresos', capabilities: [
    { id: 'ver',    label: 'Ver egresos' },
    { id: 'cargar', label: 'Cargar egresos' },
  ]},
  { id: 'sanidad', label: 'Sanidad del Negocio', capabilities: [
    { id: 'trabajar', label: 'Acceder al módulo' },
  ]},
  { id: 'inventario', label: 'Inventario', capabilities: [
    { id: 'ver',             label: 'Ver inventario (sin costos)' },
    { id: 'ver_costos',      label: 'Ver costos de inventario' },
    { id: 'ver_movimientos', label: 'Ver variaciones de stock' },
    { id: 'ver_compras',     label: 'Ver columna de compras' },
    { id: 'exportar',        label: 'Exportar inventario' },
    { id: 'importar',        label: 'Importar inventario (XLSX)' },
    { id: 'vaciar_stock',    label: 'Vaciar stock disponible' },
  ]},
  { id: 'proveedores', label: 'Proveedores | Compras', capabilities: [
    { id: 'trabajar',        label: 'Acceder al módulo' },
    { id: 'eliminar_compra', label: 'Eliminar una compra' },
  ]},
  { id: 'tarjetas', label: 'Tarjetas de Crédito', capabilities: [
    { id: 'trabajar',     label: 'Acceder al módulo' },
    { id: 'cobro_previo', label: 'Cargar cobro previo' },
  ]},
  { id: 'cambios', label: 'Cambios de Divisa', capabilities: [
    { id: 'trabajar', label: 'Acceder al módulo' },
  ]},
  { id: 'financiera', label: 'Transferencias', capabilities: [
    { id: 'trabajar',     label: 'Acceder al módulo' },
    { id: 'cobro_previo', label: 'Cargar cobro previo' },
  ]},
  { id: 'cotizador', label: 'Cotizador', capabilities: [
    { id: 'trabajar', label: 'Acceder al módulo' },
  ]},
  { id: 'usados', label: 'Usados y Cotizador', capabilities: [
    { id: 'ver',            label: 'Ver el catálogo de usados' },
    { id: 'agregar_equipo', label: 'Agregar un equipo usado' },
    { id: 'exportar',       label: 'Exportar el catálogo' },
  ]},
  { id: 'envios', label: 'Envíos', capabilities: [
    { id: 'trabajar', label: 'Acceder al módulo' },
  ]},
  { id: 'proyectos', label: 'Proyectos', capabilities: [
    { id: 'trabajar',                label: 'Acceder al módulo (ver/crear/editar)' },
    { id: 'eliminar',                label: 'Eliminar un proyecto' },
    { id: 'ver_costos',              label: 'Ver columna de costos' },
    { id: 'gestionar_participantes', label: 'Asignar / quitar participantes' },
  ]},
  { id: 'historial', label: 'Historial', capabilities: [
    { id: 'ver', label: 'Ver historial / auditoría' },
  ]},
  { id: 'config', label: 'Configuración', capabilities: [
    { id: 'general',       label: 'Tab General (comisiones, métodos de pago)' },
    { id: 'alertas',       label: 'Tab Alertas (configuración de alertas del tenant)' },
    { id: 'mantenimiento', label: 'Tab Mantenimiento (backfills, diagnóstico)' },
  ]},
];

// Set plano con todos los slugs del catálogo. Útil para validar input del
// endpoint PUT /api/capabilities/users/:id (un override sobre un slug fuera
// del catálogo es rechazado a nivel API + a nivel DB por la FK).
const ALL_SLUGS = (() => {
  const set = new Set();
  for (const p of PANTALLAS) {
    for (const c of p.capabilities) {
      set.add(`${p.id}.${c.id}`);
    }
  }
  return set;
})();

// Roles válidos. Sincronizado con el CHECK constraint de tenant_user_roles.rol.
const ROLES_VALIDOS = ['owner', 'admin', 'vendedor', 'encargado', 'lectura', 'custom'];

module.exports = {
  PANTALLAS,
  ALL_SLUGS,
  ROLES_VALIDOS,
};

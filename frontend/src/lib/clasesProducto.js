// Fuente de verdad frontend de las 9 clases de producto (espejo de
// `backend/src/lib/clasesProducto.js`). Mantener alineado — los slugs viajan
// entre backend y frontend en el shape de `productos.clase`.
//
// Cambio Fase 1 (2026-07-08): antes había 2 clases hardcoded ('celular',
// 'accesorio'). Ahora son 9, con emojis para el display en dropdowns, grillas
// de Inventario y el nuevo KPI de Unidades vendidas del Dashboard (Fase 2).

export const CLASES_PRODUCTO = [
  'celular_sellado',
  'celular_usado',
  'watch',
  'auriculares',
  'consolas',
  'computadoras',
  'ipads',
  'cargadores',
  'accesorios_varios',
];

// Labels con emoji + capitalización de negocio. Usados en:
//   · dropdowns de alta/edición (Inventario.jsx)
//   · display de la columna Clase en las grillas de Inventario
//   · nuevo KPI de "Unidades vendidas" del Dashboard de Ventas (Fase 2)
export const CLASES_LABELS = {
  celular_sellado:   '📲 Celular Sellado',
  celular_usado:     '♻️ Celular Usado',
  watch:             '⌚ Watch',
  auriculares:       '🎧 Auriculares',
  consolas:          '🎮 Consolas',
  computadoras:      '💻 Computadoras',
  ipads:             '📱 iPads',
  cargadores:        '🔋 Cargadores',
  accesorios_varios: '🛍️ Accesorios/Varios',
};

// Default para el form de alta. Coincide con el DEFAULT del schema (migration
// 20260708000001) — celular sellado es la clase más común en tenants típicos.
export const CLASE_DEFAULT = 'celular_sellado';

// Helper: label o slug crudo si la clase no está en el mapping (defensive por
// si el backend expone alguna clase legacy o custom que el frontend todavía
// no conoce). Evita mostrar "undefined" en la UI.
export function claseLabel(slug) {
  return CLASES_LABELS[slug] || slug || '—';
}

// Legacy: si un XLSX de import trae 'celular' o 'accesorio' (formato viejo),
// el importador debe mapear a un slug nuevo. Usamos condicion para
// desambiguar celular; accesorio → accesorios_varios (el operador re-clasifica
// desde Inventario si quiere más granularidad).
export function mapLegacyClase(clase, condicion) {
  if (clase === 'celular') {
    return condicion === 'usado' ? 'celular_usado' : 'celular_sellado';
  }
  if (clase === 'accesorio') return 'accesorios_varios';
  return clase; // ya está en el nuevo enum
}

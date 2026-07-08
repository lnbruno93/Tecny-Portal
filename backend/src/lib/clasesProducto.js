/**
 * Fuente de verdad de las clases de producto — enum fijo del sistema.
 *
 * Cambio Fase 1 (2026-07-08): antes había 2 clases hardcoded ('celular',
 * 'accesorio'). Ahora hay 9 categorías que reflejan el catálogo real del
 * negocio (celulares sellados/usados, watch, auriculares, consolas,
 * computadoras, ipads, cargadores, accesorios/varios).
 *
 * Este archivo es la fuente única — la validación Zod de inventario, la
 * migration, el frontend (via constantes espejo en `frontend/src/lib/clasesProducto.js`)
 * y el importador XLSX referencian estos mismos slugs.
 *
 * NO cambiar los slugs sin migration + coordinación con el frontend (los
 * slugs viajan en el response del backend y se usan como key en el UI).
 */

// Slugs canónicos (los que persistimos en `productos.clase`).
const CLASES_PRODUCTO = [
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

// Labels para display (con emoji + capitalización de negocio). Mantener
// alineado con `frontend/src/lib/clasesProducto.js` — el backend expone
// estos labels en algunos endpoints (ej. si un tenant necesita el display
// en un export/reporte). El frontend tiene su propia copia para no depender
// de una round-trip al backend en cada render.
const CLASES_LABELS = {
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

// Default cuando se crea un producto sin clase explícita. Coincide con el
// DEFAULT del schema (migration 20260708000001) para que backend y DB no
// diverjan en un edge case.
const CLASE_DEFAULT = 'celular_sellado';

module.exports = {
  CLASES_PRODUCTO,
  CLASES_LABELS,
  CLASE_DEFAULT,
};

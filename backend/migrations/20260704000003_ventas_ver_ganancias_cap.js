/**
 * Migration: seed 1 nueva capability en `capability_catalog` para gate de
 * visibilidad de ganancia y margen en el módulo Ventas.
 *
 * Contexto (2026-07-04): Lucas necesita ocultar los KPI de ganancia y margen
 * (dashboard y grilla) a users que no deben verlos — típicamente el vendedor
 * no debería saber cuánta ganancia deja cada venta ni el margen del período.
 * Owner/admin siguen viendo todo por el bypass estándar del resolver.
 *
 * Fix en 3 partes (mismo patrón que #500 / F5b):
 *   1. Esta migration + update capabilityCatalog.js (código) → agrega el
 *      slug al catálogo canónico.
 *   2. routes/ventas.js + routes/dashboard.js: response shaping — sacar
 *      los campos ganancia_ y margen_ del payload cuando el user no tiene
 *      la cap.
 *   3. Frontend: Dashboard.jsx (KPI cards), VentasList.jsx (columna
 *      grilla), Resumen.jsx (bloque KPI mensual) ocultan la sección
 *      cuando el campo llega undefined.
 *
 * Roles y defaults:
 *   - owner/admin del tenant: bypass automático (isBypassRole → true).
 *     NO necesitan seed en user_capabilities.
 *   - vendedor / encargado / lectura: NO reciben la cap por default —
 *     política conservadora. El owner puede otorgar override desde
 *     Config → Usuarios si un user en particular sí necesita ver.
 *   - custom: sigue sin defaults (solo overrides explícitos).
 *
 *   No hay backfill de user_capabilities: la cap no existía antes, así que
 *   nadie la tenía. Post-deploy, la ganancia queda oculta a todo user no
 *   owner/admin — política correcta según el pedido de Lucas.
 *
 * Idempotente: ON CONFLICT DO NOTHING en el INSERT.
 * Reversible: down DELETE del slug (cascade a user_capabilities si alguien
 * puso overrides antes del rollback — aceptable, es rollback).
 */

exports.shorthands = undefined;

// Nuevo slug. Formato canonical `pantalla.capability`. La pantalla 'ventas'
// tiene ordenPantalla=3 en el seed original; sus caps existentes usan
// orden 301 (trabajar), 302 (eliminar), 303 (exportar). Ver ganancias
// arranca en 304 — el orden gobierna cómo Usuarios.jsx renderiza el bloque.
const NUEVAS_CAPS = [
  { slug: 'ventas.ver_ganancias', label: 'Ver ganancias y márgenes', orden: 304 },
];

exports.up = (pgm) => {
  const values = NUEVAS_CAPS
    .map(c => `('${c.slug}', 'ventas', 'Ventas', '${c.slug.split('.')[1]}', '${c.label.replace(/'/g, "''")}', ${c.orden})`)
    .join(',\n      ');

  pgm.sql(`
    INSERT INTO capability_catalog (slug, pantalla, pantalla_label, capability, capability_label, orden) VALUES
      ${values}
    ON CONFLICT (slug) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  const slugs = NUEVAS_CAPS.map(c => `'${c.slug}'`).join(', ');
  pgm.sql(`
    -- Al borrar del catalog, el FK ON DELETE CASCADE en user_capabilities
    -- limpia los overrides asociados. Aceptable en rollback.
    DELETE FROM capability_catalog WHERE slug IN (${slugs});
  `);
};

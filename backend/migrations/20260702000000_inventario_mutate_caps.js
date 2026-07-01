/**
 * Migration: seed 3 nuevas capabilities en `capability_catalog` para gate
 * de mutaciones de inventario.
 *
 * Contexto (task #500): audit 2026-07-01 detectó que POST/PUT/DELETE de
 * /api/productos NO tienen middleware requireCapability. Cualquier user
 * autenticado del tenant (incluso rol 'custom' o 'vendedor') podía crear,
 * editar o borrar productos. Es privilege escalation intra-tenant.
 *
 * Fix (en 3 partes):
 *   1. Esta migration + update capabilityCatalog.js (código) → agrega los
 *      3 slugs al catálogo canónico.
 *   2. routes/inventario.js: aplicar requireCapability() a los 4 endpoints
 *      de mutación (POST, POST bulk, PUT, DELETE).
 *   3. Inventario.jsx: gate visual de botones editar/eliminar/agregar.
 *
 * Roles y backfill:
 *   - owner/admin del tenant: bypass automático en requireCapability
 *     (isBypassRole → true). NO necesitan seed en user_capabilities.
 *   - vendedor / encargado / lectura: NO reciben las nuevas caps por
 *     default — política conservadora (matchea el status quo previo:
 *     encargado no podía tocar productos, ahora tampoco).
 *   - custom: sigue sin defaults (solo overrides explícitos).
 *
 *   No hay backfill de user_capabilities: usuarios legacy con rol 'custom'
 *   que tenían `inventario` = true en user_permissions ya recibieron el
 *   backfill 20260623220000 con SOLO las capabilities de lectura + export/
 *   import/vaciar_stock. NO recibieron 'crear/editar/eliminar' porque no
 *   existían — y ahora quedan gated por default, que es la política
 *   correcta post-fix. El owner del tenant puede otorgar overrides desde
 *   Config → Usuarios si un user legacy realmente necesitaba mutar.
 *
 *   Trade-off aceptado: un user 'custom' que HOY estaba editando productos
 *   (probablemente sin darse cuenta que no debía) va a recibir 403 tras el
 *   deploy. Es el comportamiento correcto — el fix es intencional. Se
 *   pondera vs. el riesgo de dejar la escalation abierta un día más.
 *
 * Idempotente: ON CONFLICT DO NOTHING en el INSERT.
 * Reversible: down DELETE los 3 slugs (cascade a user_capabilities si
 * alguien puso overrides antes del rollback — aceptable, es rollback).
 */

exports.shorthands = undefined;

// Los 3 slugs nuevos. Formato canonical `pantalla.capability`, orden
// dentro del bloque `inventario`. Seguimos el patrón del catalog original
// (buildCatalogInsertValues genera orden=101, 102, ..., 901, 902):
// pantalla 'inventario' tiene ordenPantalla=9, cap ordenCap=8/9/10 → orden 908/909/910.
// El orden gobierna cómo el frontend Usuarios.jsx renderiza las caps
// dentro de cada pantalla — poner las mutaciones al final del bloque es
// coherente con las que ya están (7 = 'vaciar_stock').
const NUEVAS_CAPS = [
  { slug: 'inventario.crear',    label: 'Agregar productos',   orden: 908 },
  { slug: 'inventario.editar',   label: 'Editar productos',    orden: 909 },
  { slug: 'inventario.eliminar', label: 'Eliminar productos',  orden: 910 },
];

exports.up = (pgm) => {
  const values = NUEVAS_CAPS
    .map(c => `('${c.slug}', 'inventario', 'Inventario', '${c.slug.split('.')[1]}', '${c.label.replace(/'/g, "''")}', ${c.orden})`)
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

/**
 * Migration: seed 2 nuevas capabilities en `capability_catalog` para gate
 * granular de las acciones destructivas del share link público de Equipos
 * Usados.
 *
 * Contexto (task #229, audit 2026-07-25 Track B P1-7): las 2 acciones
 * irreversibles del share link (`PATCH activo:false` = desactivar, +
 * `POST /rotate` = rotar token) están gated hoy por `inventario.editar` —
 * la misma cap que permite editar cualquier otro campo del panel (whatsapp
 * de contacto, mensaje extra, toggles mostrar_bateria/mostrar_precio).
 *
 * El audit las llamó "irreversibles desde la perspectiva del cliente" —
 * todos los WhatsApp/bookmarks/copias del link viejo mueren instant. Por
 * el momento se pospuso una cap dedicada por costo (migration + admin UI).
 * En su lugar quedaron 2 mitigations:
 *   - Confirm dialog en frontend (peligro alto).
 *   - Audit log con `high_impact: true` para trail forense + Sentry alert.
 *
 * Al aparecer roles custom con `inventario.editar` pero sin necesidad de
 * poder tumbar el link (típico: encargado de contenido / marketing que
 * ajusta WhatsApp y mensaje pero no debe desactivar), separar las caps
 * pasa de "opcional" a "necesario".
 *
 * Fix (en 4 partes):
 *   1. Esta migration + update capabilityCatalog.js (código) → agrega los
 *      2 slugs al catálogo canónico.
 *   2. routes/shareLinks.js: cambio POST /rotate a requireCapability(
 *      'inventario.share_link_rotate') + check inline en PATCH cuando
 *      changes.activo === false para exigir 'share_link_desactivar'.
 *   3. Frontend ShareLinkPanel.jsx: disable botones "Desactivar" y "Rotar
 *      token" si el user no tiene la cap correspondiente (defense-in-depth
 *      UX, el backend enforcea igual).
 *   4. Tests: happy + edge cases (user con inventario.editar pero sin
 *      share_link_desactivar → 403 al desactivar; PATCH otros campos sí
 *      pasa; owner/admin bypassean).
 *
 * Roles y backfill:
 *   - owner/admin del tenant: bypass automático en requireCapability
 *     (isBypassRole → true). NO necesitan seed en user_capabilities.
 *   - vendedor / encargado / lectura: NO tenían `inventario.editar` en
 *     los defaults previos, así que NO cambia nada para ellos.
 *   - custom: los overrides existentes en user_capabilities siguen igual —
 *     si un custom user tenía `inventario.editar`, sigue teniéndola. Este
 *     PR NO le agrega automáticamente las 2 caps nuevas — el owner del
 *     tenant decide desde Config → Usuarios si le concede alguna, ambas,
 *     o ninguna.
 *
 *   Trade-off aceptado (mismo del PR #500 `inventario.crear/editar/
 *   eliminar`): un user 'custom' que HOY estaba desactivando o rotando
 *   el link va a recibir 403 tras el deploy. Comportamiento intencional
 *   — el fix restringe superficie destructiva, no la abre. Owner del
 *   tenant puede conceder overrides desde Config → Usuarios sin tocar
 *   la DB.
 *
 * Idempotente: ON CONFLICT DO NOTHING en el INSERT.
 * Reversible: down DELETE los 2 slugs (cascade a user_capabilities si
 * alguien puso overrides antes del rollback — aceptable, es rollback).
 */

exports.shorthands = undefined;

// Los 2 slugs nuevos. Formato canonical `pantalla.capability`. Orden dentro
// del bloque `inventario` = 911, 912 (post 907 vaciar_stock, 908/909/910
// crear/editar/eliminar del PR #500 — mismo criterio "mutaciones al final").
const NUEVAS_CAPS = [
  {
    slug:  'inventario.share_link_desactivar',
    label: 'Desactivar el link público de usados',
    orden: 911,
  },
  {
    slug:  'inventario.share_link_rotate',
    label: 'Rotar el token del link público de usados',
    orden: 912,
  },
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

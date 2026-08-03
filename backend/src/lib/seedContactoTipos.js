/**
 * Seed helper para los 5 tipos de contacto default de un tenant nuevo (task #290).
 *
 * Espejo del seed que se hace en la migration `20260803020000_contacto_tipos_
 * editables.js` para tenants existentes. Se invoca desde signup.js al crear
 * un tenant nuevo.
 *
 * Values matchean el CHECK constraint original de `contactos.tipo` (que se
 * dropea en la misma migration) para preservar backward compat con
 * frontend/backend que sigan usando esos slugs. El label 'Tecny Team' cierra
 * el bug rebrand (antes se mostraba 'ipro team' raw en Contactos.jsx).
 *
 * is_system=true previene DELETE desde el CRUD — el owner puede renombrar,
 * reordenar, o desactivar, pero no eliminar. Garantiza que siempre haya
 * al menos una lista base.
 *
 * Idempotente vía ON CONFLICT DO NOTHING (matchea UNIQUE (tenant_id, slug)
 * partial WHERE deleted_at IS NULL). Safe si se re-corre por retry.
 *
 * Usa el client pasado (dentro de la tx del signup) — respeta el SET
 * LOCAL app.current_tenant si aplica.
 */
const DEFAULT_TIPOS = [
  { slug: 'cliente',    nombre: 'Cliente',    orden: 1 },
  { slug: 'amigo',      nombre: 'Amigo',      orden: 2 },
  { slug: 'familiar',   nombre: 'Familiar',   orden: 3 },
  { slug: 'inversor',   nombre: 'Inversor',   orden: 4 },
  { slug: 'ipro team',  nombre: 'Tecny Team', orden: 5 },
];

async function seedContactoTipos(client, tenantId) {
  for (const t of DEFAULT_TIPOS) {
    await client.query(
      `INSERT INTO contacto_tipos (tenant_id, slug, nombre, orden, activo, is_system)
       VALUES ($1, $2, $3, $4, TRUE, TRUE)
       ON CONFLICT DO NOTHING`,
      [tenantId, t.slug, t.nombre, t.orden]
    );
  }
}

module.exports = { seedContactoTipos, DEFAULT_TIPOS };

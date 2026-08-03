/**
 * Seed helper para los 4 tipos de contacto default de un tenant NUEVO
 * (task #290). Se invoca desde signup.js.
 *
 * Los 4 tipos son universales: aplican a cualquier negocio. El slug legacy
 * 'ipro team' (que solo tenía sentido para el tenant iPro original de
 * Lucas) NO se seedea acá — la migration 20260803020000 lo seedea solo
 * para tenants con data histórica. Tenants nuevos arrancan con dropdown
 * limpio + pueden crear tipos custom desde el CRUD si necesitan.
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
  { slug: 'cliente',  nombre: 'Cliente',  orden: 1 },
  { slug: 'amigo',    nombre: 'Amigo',    orden: 2 },
  { slug: 'familiar', nombre: 'Familiar', orden: 3 },
  { slug: 'inversor', nombre: 'Inversor', orden: 4 },
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

// seedClasesProducto.js — 2026-07-08 F3.a
//
// Helper para insertar las 9 clases base + "Sin categoría" cuando se crea un
// tenant nuevo. Espejo del bloque de backfill de la migration
// `20260708000002_clases_producto_tenant.js` — mantener alineado si cambia
// el orden/nombres/emojis de las clases base.
//
// Se llama desde:
//   - `routes/signup.js` (self-service post-signup) — tras crear el tenant
//     y setear `SET LOCAL app.current_tenant`.
//   - `routes/superAdmin.js` (admin manual) — mismo pattern.
//
// Requiere que el caller haya hecho `SET LOCAL app.current_tenant = tenantId`
// antes en la misma transacción, para que RLS permita el INSERT.
//
// Idempotente vía ON CONFLICT — se puede llamar múltiples veces sobre el
// mismo tenant sin duplicar filas.

// Alineado con:
//   - `backend/src/lib/clasesProducto.js` (enum global F1)
//   - `frontend/src/lib/clasesProducto.js` (espejo frontend F1)
//   - `backend/migrations/20260708000002_clases_producto_tenant.js` (backfill)
// Si acá cambia, actualizar los otros tres.
const CLASES_BASE = [
  { slug: 'celular_sellado',   nombre: 'Celular Sellado',   emoji: '📲', orden: 10 },
  { slug: 'celular_usado',     nombre: 'Celular Usado',     emoji: '♻️', orden: 20 },
  { slug: 'watch',             nombre: 'Watch',             emoji: '⌚', orden: 30 },
  { slug: 'auriculares',       nombre: 'Auriculares',       emoji: '🎧', orden: 40 },
  { slug: 'consolas',          nombre: 'Consolas',          emoji: '🎮', orden: 50 },
  { slug: 'computadoras',      nombre: 'Computadoras',      emoji: '💻', orden: 60 },
  { slug: 'ipads',             nombre: 'iPads',             emoji: '📱', orden: 70 },
  { slug: 'cargadores',        nombre: 'Cargadores',        emoji: '🔋', orden: 80 },
  { slug: 'accesorios_varios', nombre: 'Accesorios/Varios', emoji: '🛍️', orden: 90 },
];

/**
 * Inserta las 9 clases base + "Sin categoría" para el tenant del contexto
 * actual del client (via `SET LOCAL app.current_tenant`).
 *
 * IMPORTANTE: el caller debe hacer `SET LOCAL app.current_tenant = tenantId`
 * ANTES de llamar a esta función. Si no, RLS rechaza los INSERT.
 *
 * @param {import('pg').PoolClient} client - Client de pg dentro de una tx.
 * @param {number} tenantId - ID del tenant (para pasar en el INSERT).
 * @returns {Promise<{ base: number, sinCategoria: number }>} Cuántas filas
 *   se insertaron (0 si ya existían por ON CONFLICT).
 */
async function seedClasesProducto(client, tenantId) {
  let base = 0;
  for (const c of CLASES_BASE) {
    const { rowCount } = await client.query(
      `INSERT INTO clases_producto (tenant_id, nombre, emoji, orden, es_base, slug_legacy, activa)
       VALUES ($1, $2, $3, $4, true, $5, true)
       ON CONFLICT (tenant_id, LOWER(nombre)) WHERE deleted_at IS NULL DO NOTHING`,
      [tenantId, c.nombre, c.emoji, c.orden, c.slug]
    );
    base += rowCount;
  }

  // "Sin categoría" del sistema (fallback para import XLSX, no borrable).
  const { rowCount: sinCategoria } = await client.query(
    `INSERT INTO clases_producto (tenant_id, nombre, orden, es_sin_categoria, activa)
     VALUES ($1, 'Sin categoría', 999, true, true)
     ON CONFLICT (tenant_id) WHERE es_sin_categoria = true AND deleted_at IS NULL DO NOTHING`,
    [tenantId]
  );

  return { base, sinCategoria };
}

module.exports = { seedClasesProducto, CLASES_BASE };

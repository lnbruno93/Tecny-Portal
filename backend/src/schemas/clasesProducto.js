// clasesProducto.js — 2026-07-08 F3.a
//
// Schemas Zod para CRUD de categorías de producto por tenant.
// Ver design doc: `docs/design/categorias-crud-tenant-f3.md`.
//
// Decisiones aprobadas por Lucas:
//   - Emoji: opcional (sin picker).
//   - Nombre: unique case-insensitive por tenant (index parcial en la migration).
//   - Solo "Sin categoría" es de sistema — no borrable ni renombrable (validado
//     en el handler, no acá — Zod no conoce el estado de la fila).

const { z } = require('zod');

// Nombre trim + entre 1 y 80 chars. `.trim()` primero para que espacios en
// blanco no cuenten como caracteres válidos.
const nombre = z.string()
  .trim()
  .min(1, 'Nombre requerido')
  .max(80, 'Nombre máximo 80 caracteres');

// Emoji opcional. Zod no valida el codepoint (permitiríamos rechazos raros
// como emojis nuevos que el sistema no conozca). Solo largo máximo — un
// emoji con selectores puede ocupar hasta 8 chars UTF-16 (ej: ♻️ = 2 chars).
const emoji = z.string()
  .trim()
  .max(8, 'Emoji máximo 8 caracteres')
  .optional()
  .nullable();

const orden = z.coerce.number().int().min(0).max(9999);

// UUID en cualquier variante (no strict v4). Coherente con el regex del handler
// (routes/inventario.js) que acepta cualquier UUID hex-shaped — la BD usa
// `gen_random_uuid()` que genera v4, pero preferimos no acoplar el schema a
// una versión específica.
const uuidLoose = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'id inválido'
);

// ── Create ──
const createClaseProductoSchema = z.object({
  nombre,
  emoji,
  activa: z.boolean().optional().default(true),
  orden:  orden.optional().default(0),
}).strict();

// ── Update (partial + guard "al menos un campo") ──
const updateClaseProductoSchema = z.object({
  nombre: nombre.optional(),
  emoji,
  activa: z.boolean().optional(),
  orden:  orden.optional(),
}).strict()
  .refine(d => Object.values(d).some(v => v !== undefined), {
    message: 'Al menos un campo es requerido',
  });

// ── Reorder (batch) ──
// Body es un array de { id, orden }. Máximo razonable de items para evitar
// abusos (ninguna UI muestra 500 categorías al mismo tiempo).
const reorderClasesProductoSchema = z.object({
  items: z.array(z.object({
    id:    uuidLoose,
    orden: orden,
  }).strict())
    .min(1, 'Al menos 1 item requerido')
    .max(100, 'Máximo 100 items por reorder'),
}).strict();

module.exports = {
  createClaseProductoSchema,
  updateClaseProductoSchema,
  reorderClasesProductoSchema,
};

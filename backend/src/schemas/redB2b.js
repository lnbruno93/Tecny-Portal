/**
 * Schemas Zod para Red B2B (F1 — partnerships, F2 — productos pending review).
 *
 * .strict() en todos: rechaza campos extra para frenar typos en frontend
 * que silenciosamente no harían nada. Mismo patrón que el resto del portal.
 */

const { z } = require('zod');

// Slug regex idéntico al de tenants — ver schemas/superAdmin.js.
// Lowercase + dígitos + hyphens. No empieza ni termina con hyphen.
// 2-100 chars (matchea el formato que slugify() genera en signup/super-admin).
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

const inviteSchema = z.object({
  target_tenant_slug: z.string()
    .regex(SLUG_REGEX, 'slug inválido: lowercase, números, hyphens; 2-100 chars'),
  // Mensaje opcional para el invitador ("Hola TekHaus, somos iPro..."). Max
  // 500 chars — suficiente para presentación, no para spam de párrafos.
  message: z.string().trim().max(500).optional(),
}).strict();

const revokeSchema = z.object({
  // Reason opcional. Si se manda vacío explícito, lo dejamos como null en DB.
  reason: z.string().trim().max(500).optional(),
}).strict();

const rejectSchema = z.object({
  reason: z.string().trim().max(500).optional(),
}).strict();

// F2 (#455): merge-into de un producto pending review en uno existente del
// catálogo del buyer. target_producto_id debe ser un producto del propio
// tenant (validado inline en el handler). z.coerce.number() para tolerar
// IDs viniendo como strings desde el frontend.
const mergeIntoSchema = z.object({
  target_producto_id: z.coerce.number().int().positive(),
}).strict();

// F3 (#456): crear operación cross-tenant. items min 1 max 100 — uppercase
// es paranoico pero los partners realistas no van a mandar más de 100 items
// en una sola venta B2B (caso típico: 1-20 unidades).
//
// total_usd / total_ars son redundantes (el server recalcula como sanity
// check) — vienen del frontend que ya hizo la cuenta. El server tolera
// diferencia ±0.01 por rounding entre JS y SQL (sum de N items con 2 decimales).
const createOperationSchema = z.object({
  partnership_id: z.coerce.number().int().positive(),
  items: z.array(z.object({
    producto_id: z.coerce.number().int().positive(),
    cantidad:    z.coerce.number().int().positive(),
    precio_usd:  z.coerce.number().nonnegative(),
  })).min(1).max(100),
  tc:        z.coerce.number().positive(),
  notes:     z.string().trim().max(1000).optional(),
  total_usd: z.coerce.number().positive(),
  total_ars: z.coerce.number().positive(),
}).strict();

// F3: cancelación de operación cross-tenant. Solo el seller. reason opcional
// con tope 500 chars para evitar payload abuse.
const cancelOperationSchema = z.object({
  reason: z.string().trim().max(500).optional(),
}).strict();

// F3: PATCH de operación. F3 SOLO permite editar `notes` (decisión del doc
// sección 5.2 — items editable es F3.5). Si más adelante se agrega items
// edición, se hace por endpoint separado o extiende este schema.
const patchOperationSchema = z.object({
  notes: z.string().trim().max(1000),
}).strict();

module.exports = {
  inviteSchema,
  revokeSchema,
  rejectSchema,
  mergeIntoSchema,
  createOperationSchema,
  cancelOperationSchema,
  patchOperationSchema,
};

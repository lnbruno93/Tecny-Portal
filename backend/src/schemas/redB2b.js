/**
 * Schemas Zod para Red B2B (F1 — partnerships).
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

module.exports = {
  inviteSchema,
  revokeSchema,
  rejectSchema,
};

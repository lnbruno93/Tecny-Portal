const { z } = require('zod');

// Naming convention: snake_case, empieza con letra minúscula, solo
// [a-z0-9_], máx 64 chars. Coincide con el VARCHAR(64) de la tabla y obliga
// a nombres que se pueden usar como llaves de objeto sin escapes feos
// (ej. `flags.dark_mode_v2` en lugar de `flags['dark-mode v2']`).
const NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const NAME_MAX = 64;
const DESC_MAX = 500;

// POST /api/feature-flags — crear un flag nuevo.
//   · name: obligatorio, snake_case, único (la PK rebota duplicados).
//   · enabled: opcional, default false. Defaults seguro: cualquier flag recién
//     creado no impacta hasta que un admin lo prenda explícitamente.
//   · description: opcional, máx 500 chars.
const createFlagSchema = z.object({
  name: z.string()
    .min(1, 'name es requerido')
    .max(NAME_MAX, `name no puede exceder ${NAME_MAX} caracteres`)
    .regex(NAME_REGEX, 'name debe ser snake_case (a-z, 0-9, _) empezando con letra'),
  enabled: z.boolean().default(false),
  description: z.string().max(DESC_MAX, `description no puede exceder ${DESC_MAX} caracteres`).optional(),
}).strict();

// PATCH /api/feature-flags/:name — actualizar enabled y/o description.
// `.strict()` rebota claves desconocidas (defensa prototype pollution: __proto__,
// constructor). `.refine(at-least-one)` evita updates vacíos (PATCH {} no
// tiene sentido y serían un audit log basura).
const updateFlagSchema = z.object({
  enabled: z.boolean().optional(),
  // `.nullable()` permite borrar la descripción mandando null. Si solo
  // querés actualizar enabled, omití el campo.
  description: z.string().max(DESC_MAX, `description no puede exceder ${DESC_MAX} caracteres`).nullable().optional(),
}).strict().refine(
  d => d.enabled !== undefined || d.description !== undefined,
  { message: 'Indicá qué actualizar (enabled o description)' }
);

module.exports = { createFlagSchema, updateFlagSchema, NAME_REGEX, NAME_MAX, DESC_MAX };

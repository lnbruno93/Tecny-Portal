const { z } = require('zod');
const { ALL_SLUGS, ROLES_VALIDOS } = require('../lib/capabilityCatalog');

// Lista cerrada de roles válidos. Mismo set que el CHECK constraint
// de tenant_user_roles.rol en DB — si se cambia uno hay que cambiar
// el otro.
//
// Excluimos 'owner' del enum aceptado por el endpoint PUT:
//   - Owner se asigna SOLO en el signup del tenant (no es editable por
//     un admin común — protege contra escalación de privilegios).
//   - Si el frontend manda rol='owner', responder 400.
const ROLES_EDITABLES = ROLES_VALIDOS.filter(r => r !== 'owner');

const overrideSchema = z.object({
  capability_slug: z.string().refine(
    (s) => ALL_SLUGS.has(s),
    { message: 'capability_slug fuera del catálogo' },
  ),
  enabled: z.boolean(),
}).strict();

// Body del PUT /api/capabilities/users/:id
// Ambos campos opcionales — el endpoint patchea solo lo enviado. Si el
// caller manda overrides=[], BORRA todos los overrides existentes
// (reemplazo total — no es un patch incremental). Eso simplifica el
// modelo: la UI envía siempre la lista completa del estado deseado.
const updateUserCapabilitiesSchema = z.object({
  rol: z.enum(ROLES_EDITABLES).optional(),
  overrides: z.array(overrideSchema).max(200).optional(),
}).strict().refine(
  d => d.rol !== undefined || d.overrides !== undefined,
  { message: 'Al menos uno de rol u overrides es requerido' },
);

module.exports = { updateUserCapabilitiesSchema, ROLES_EDITABLES };

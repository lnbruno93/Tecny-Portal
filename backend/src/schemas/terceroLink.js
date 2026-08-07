/**
 * Schema Zod para tercero_link (task #302).
 *
 * Link pragmático 1:1 entre un cliente_cc y un proveedor que representan
 * la misma persona/entidad. Cubre el "caso Kevin" sin refactor completo
 * del modelo Terceros (task #149).
 *
 * Ver:
 *   · backend/migrations/20260807000000_tercero_link.js
 *   · backend/src/routes/terceroLink.js
 */
const { z } = require('zod');

const createTerceroLinkSchema = z.object({
  cliente_cc_id: z.coerce.number().int().positive('cliente_cc_id inválido'),
  proveedor_id:  z.coerce.number().int().positive('proveedor_id inválido'),
  notas: z.string().trim().max(500, 'Notas no pueden superar 500 caracteres').optional().nullable(),
}).strict();

module.exports = { createTerceroLinkSchema };

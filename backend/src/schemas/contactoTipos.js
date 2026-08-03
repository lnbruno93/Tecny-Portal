/**
 * Schemas Zod para el CRUD de contacto_tipos (task #290).
 *
 * Diseño clave:
 *   · `slug` — value interno, se AUTO-GENERA del nombre en el POST (normalizado
 *     lowercase + trim + espacios → un solo espacio). NO editable después.
 *     Si permitiéramos cambiar el slug, romperíamos todos los contactos que
 *     lo usan (contactos.tipo NO tiene FK, es TEXT libre validado a nivel app).
 *   · `nombre` — label visible al user. Editable siempre.
 *   · `orden` — para ordenar el dropdown.
 *   · `activo` — soft-hide del dropdown sin borrar (contactos que ya tenían
 *     el tipo siguen funcionando).
 */
const { z } = require('zod');

const nombreSchema = z.string()
  .trim()
  .min(1, 'El nombre no puede estar vacío')
  .max(50, 'El nombre no puede tener más de 50 caracteres');

// Slug helper: normaliza el nombre para uso interno estable. Lowercase +
// trim + colapso de espacios múltiples. NO removemos espacios (los
// valores legacy tienen espacios, ej. 'ipro team').
function slugify(nombre) {
  return String(nombre || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const createContactoTipoSchema = z.object({
  nombre: nombreSchema,
  orden: z.number().int().min(0).max(9999).optional(),
});

const updateContactoTipoSchema = z.object({
  nombre: nombreSchema.optional(),
  orden: z.number().int().min(0).max(9999).optional(),
  activo: z.boolean().optional(),
}).refine(
  // Zod parse siempre devuelve un objeto con todas las keys (undefined
  // para las que no vinieron). El check correcto es "al menos una key
  // NO es undefined".
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: 'Debe enviar al menos un campo a actualizar' }
);

module.exports = {
  createContactoTipoSchema,
  updateContactoTipoSchema,
  slugify,
};

const { z } = require('zod');

const TIPOS_CONTACTO = ['amigo','familiar','cliente','inversor','ipro team'];

const createContactoSchema = z.object({
  nombre:   z.string().trim().min(1, 'Nombre requerido').max(100),
  apellido: z.string().trim().max(100).optional().nullable(),
  tipo:     z.enum(TIPOS_CONTACTO, { error: `Tipo debe ser: ${TIPOS_CONTACTO.join(', ')}` }),
});

// PUT — todos opcionales, pero al menos uno presente
const updateContactoSchema = createContactoSchema.partial().refine(
  d => Object.values(d).some(v => v !== undefined),
  { message: 'Al menos un campo es requerido para actualizar' }
);

module.exports = { createContactoSchema, updateContactoSchema };

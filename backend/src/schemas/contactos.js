const { z } = require('zod');

const TIPOS_CONTACTO = ['amigo','familiar','cliente','inversor','ipro team'];
const ORIGENES = ['ventas','b2b','proveedores','envios','manual','proyectos'];

const createContactoSchema = z.object({
  nombre:           z.string().trim().min(1, 'Nombre requerido').max(100),
  apellido:         z.string().trim().max(100).optional().nullable(),
  telefono:         z.string().trim().max(60).optional().nullable(),
  dni:              z.string().trim().max(30).optional().nullable(),
  email:            z.string().trim().max(120).email('Email inválido').optional().nullable().or(z.literal('')),
  fecha_nacimiento: z.string().date('Fecha inválida — usar YYYY-MM-DD').optional().nullable().or(z.literal('')),
  tipo:             z.enum(TIPOS_CONTACTO, { error: `Tipo debe ser: ${TIPOS_CONTACTO.join(', ')}` }).optional(),
  origen:           z.enum(ORIGENES, { error: `Origen debe ser: ${ORIGENES.join(', ')}` }).optional(),
}).strict();

// PUT — todos opcionales, pero al menos uno presente
const updateContactoSchema = createContactoSchema.partial().refine(
  d => Object.values(d).some(v => v !== undefined),
  { message: 'Al menos un campo es requerido para actualizar' }
);

const queryContactosSchema = z.object({
  buscar: z.string().max(200).optional(),
  tipo:   z.enum(TIPOS_CONTACTO).optional(),
  origen: z.enum(ORIGENES).optional(),
  // Paginación con page/limit (estándar parsePagination). El backend ignora
  // offset histórico — los pocos consumers que lo pasaban (sin page) caían en
  // page=1 igual. limit conservador (500) para no romper consumers que cargan
  // todo el listado.
  page:   z.coerce.number().int().positive().optional(),
  limit:  z.coerce.number().int().positive().max(500).optional(),
});

module.exports = { createContactoSchema, updateContactoSchema, queryContactosSchema, TIPOS_CONTACTO, ORIGENES };

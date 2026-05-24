const { z } = require('zod');

const createVendedorSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(100),
});

const queryVendedoresSchema = z.object({
  buscar: z.string().max(200).optional(),
});

module.exports = { createVendedorSchema, queryVendedoresSchema };

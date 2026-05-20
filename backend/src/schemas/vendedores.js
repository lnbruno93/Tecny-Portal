const { z } = require('zod');

const createVendedorSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(100),
});

module.exports = { createVendedorSchema };

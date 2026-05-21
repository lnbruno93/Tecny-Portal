const { z } = require('zod');

const TOOLS = ['cotizador','financiera','cajas','envios','usuarios'];

// Política de contraseñas unificada — igual que changePasswordSchema en auth.js
const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_MSG = `Password mínimo ${MIN_PASSWORD_LENGTH} caracteres`;

const permsSchema = z.object(
  Object.fromEntries(TOOLS.map(t => [t, z.boolean().default(false)]))
).default({});

// Para crear: perms con defaults (todos false si no se envían)
const createUsuarioSchema = z.object({
  nombre:   z.string().trim().min(1, 'Nombre requerido').max(100),
  username: z.string().trim().min(2, 'Username mínimo 2 caracteres').max(50)
              .regex(/^[a-z0-9_]+$/, 'Username: solo minúsculas, números y guión bajo'),
  email:    z.string().trim().email('Email inválido').optional().nullable(),
  password: z.string().min(MIN_PASSWORD_LENGTH, PASSWORD_MSG),
  role:     z.enum(['admin','op']).default('op'),
  perms:    permsSchema,
});

// Para actualizar: perms SIN default para que un body vacío {} no lo active
const permsUpdateSchema = z.object(
  Object.fromEntries(TOOLS.map(t => [t, z.boolean().default(false)]))
);

const updateUsuarioSchema = z.object({
  nombre:   z.string().trim().min(1).max(100).optional(),
  username: z.string().trim().min(2).max(50)
              .regex(/^[a-z0-9_]+$/, 'Username: solo minúsculas, números y guión bajo').optional(),
  email:    z.string().trim().email('Email inválido').optional().nullable(),
  password: z.string().min(MIN_PASSWORD_LENGTH, PASSWORD_MSG).optional(),
  role:     z.enum(['admin','op']).optional(),
  perms:    permsUpdateSchema.optional(),  // opcional y SIN default de nivel superior
}).refine(
  d => Object.values(d).some(v => v !== undefined),
  { message: 'Al menos un campo es requerido para actualizar' }
);

module.exports = { createUsuarioSchema, updateUsuarioSchema };

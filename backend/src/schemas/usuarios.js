const { z } = require('zod');
const { TOOLS } = require('../lib/tools');
const { passwordField } = require('../lib/password');

const permsSchema = z.object(
  Object.fromEntries(TOOLS.map(t => [t, z.boolean().default(false)]))
).default({});

// Para crear: perms con defaults (todos false si no se envían)
const createUsuarioSchema = z.object({
  nombre:   z.string().trim().min(1, 'Nombre requerido').max(100),
  username: z.string().trim().min(2, 'Username mínimo 2 caracteres').max(50)
              .regex(/^[a-z0-9_]+$/, 'Username: solo minúsculas, números y guión bajo'),
  email:    z.string().trim().email('Email inválido').optional().nullable(),
  password: passwordField(),
  role:     z.enum(['admin','op']).default('op'),
  perms:    permsSchema,
}).strict();

// Para actualizar: perms SIN default para que un body vacío {} no lo active
const permsUpdateSchema = z.object(
  Object.fromEntries(TOOLS.map(t => [t, z.boolean().default(false)]))
);

const updateUsuarioSchema = z.object({
  nombre:   z.string().trim().min(1).max(100).optional(),
  username: z.string().trim().min(2).max(50)
              .regex(/^[a-z0-9_]+$/, 'Username: solo minúsculas, números y guión bajo').optional(),
  email:    z.string().trim().email('Email inválido').optional().nullable(),
  password: passwordField().optional(),
  role:     z.enum(['admin','op']).optional(),
  perms:    permsUpdateSchema.optional(),  // opcional y SIN default de nivel superior
  // 2026-06-11 SE-08: opcional. Si el admin tiene 2FA activa y está cambiando
  // password/role/perms de OTRO user, el endpoint exige TOTP del admin antes
  // de aceptar el cambio (defense in depth contra token de admin robado).
  twofa_code: z.string().trim().min(6).max(20).optional(),
}).strict().refine(
  d => Object.values(d).some(v => v !== undefined && v !== null),
  { message: 'Al menos un campo es requerido para actualizar' }
);

module.exports = { createUsuarioSchema, updateUsuarioSchema };

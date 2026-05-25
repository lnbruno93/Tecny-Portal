const { z } = require('zod');
const { passwordField } = require('../lib/password');

const loginSchema = z.object({
  username: z.string().trim().min(1).optional(),
  email:    z.string().trim().email('Email inválido').optional(),
  password: z.string().min(1, 'Password requerido'),
}).refine(d => d.username || d.email, {
  message: 'username o email es requerido',
  path: ['username'],
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Contraseña actual requerida'),
  newPassword:     passwordField(),
});

module.exports = { loginSchema, changePasswordSchema };

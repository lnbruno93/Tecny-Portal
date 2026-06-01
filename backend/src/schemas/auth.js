const { z } = require('zod');
const { passwordField } = require('../lib/password');

const loginSchema = z.object({
  username: z.string().trim().min(1).optional(),
  email:    z.string().trim().email('Email inválido').optional(),
  password: z.string().min(1, 'Password requerido'),
  // 2FA: si el user tiene 2FA enabled, después del password OK pedimos el código.
  // El frontend hace 2 requests: el primero sin code (recibe twofa_required=true),
  // el segundo con code. Aceptamos TOTP (6 dígitos) o recovery code (formato libre).
  code:     z.string().trim().min(6).max(20).optional(),
}).strict().refine(d => d.username || d.email, {
  message: 'username o email es requerido',
  path: ['username'],
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Contraseña actual requerida'),
  newPassword:     passwordField(),
}).strict();

module.exports = { loginSchema, changePasswordSchema };

const { z } = require('zod');

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
  newPassword:     z.string().min(8, 'La nueva contraseña debe tener al menos 8 caracteres'),
});

module.exports = { loginSchema, changePasswordSchema };

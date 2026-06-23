// schemas/usuarios.js — validación zod del endpoint /api/usuarios.
//
// 2026-06-23 F4: el campo `perms` (14 booleans del sistema viejo) se retiró.
// Ahora roles + permisos se manejan vía el endpoint
// `/api/capabilities/users/:id` (rol + overrides). Crear un user vía POST
// /api/usuarios sigue funcionando — solo se crean los datos básicos. El rol
// del tenant se asigna después con un PUT /api/capabilities/users/:id (lo
// hace la pantalla nueva de Usuarios en el frontend).

const { z } = require('zod');
const { passwordField } = require('../lib/password');

// Para crear: solo datos básicos. El rol global (admin/op) sigue acá
// porque controla el bypass del middleware (admin global ve todo, op
// usa caps). En la práctica, el admin de tenant siempre crea con
// role='op' — admin global se reserva al super-admin de la plataforma.
const createUsuarioSchema = z.object({
  nombre:   z.string().trim().min(1, 'Nombre requerido').max(100),
  username: z.string().trim().min(2, 'Username mínimo 2 caracteres').max(50)
              .regex(/^[a-z0-9_]+$/, 'Username: solo minúsculas, números y guión bajo'),
  email:    z.string().trim().toLowerCase().email('Email inválido').optional().nullable(),
  password: passwordField(),
  role:     z.enum(['admin','op']).default('op'),
}).strict();

// Para actualizar: mismos campos pero todos opcionales.
const updateUsuarioSchema = z.object({
  nombre:   z.string().trim().min(1).max(100).optional(),
  username: z.string().trim().min(2).max(50)
              .regex(/^[a-z0-9_]+$/, 'Username: solo minúsculas, números y guión bajo').optional(),
  email:    z.string().trim().toLowerCase().email('Email inválido').optional().nullable(),
  password: passwordField().optional(),
  role:     z.enum(['admin','op']).optional(),
  // 2026-06-11 SE-08: opcional. Si el admin tiene 2FA activa y está cambiando
  // password/role de OTRO user, el endpoint exige TOTP del admin antes de
  // aceptar el cambio (defense in depth contra token de admin robado).
  twofa_code: z.string().trim().min(6).max(20).optional(),
}).strict().refine(
  d => Object.values(d).some(v => v !== undefined && v !== null),
  { message: 'Al menos un campo es requerido para actualizar' }
);

module.exports = { createUsuarioSchema, updateUsuarioSchema };

const { z } = require('zod');
const { passwordField } = require('../lib/password');

const loginSchema = z.object({
  username: z.string().trim().min(1).optional(),
  // 2026-06-16 TANDA 1: email se normaliza a minúsculas. La DB tiene un índice
  // único sobre LOWER(email) (migration 20260616000003), y el login query
  // usa LOWER(email) = LOWER($1) — así `Lucas@x.com` y `lucas@x.com` son
  // equivalentes para login. Normalizar acá garantiza consistency cuando se
  // crean / leen users desde otros endpoints.
  email:    z.string().trim().toLowerCase().email('Email inválido').optional(),
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
  // 2026-06-11 SE-07: opcional. Si el user tiene 2FA activa, el endpoint exige
  // el código TOTP/recovery antes de cambiar la password (defense in depth
  // contra token robado). El frontend hace 2 requests: primero sin code (recibe
  // twofa_required=true), segundo con code.
  twofa_code:      z.string().trim().min(6).max(20).optional(),
}).strict();

// 2026-06-18 #321 forgot-password.
const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email inválido').max(254),
  // hCaptcha opcional en schema. El toggle vive en HCAPTCHA_ENABLED env.
  // Si está enabled y falta, verifyCaptcha lo rechaza con 'invalid_token'.
  // Bound a 10kB — tokens reales son ~500-2000 chars.
  hcaptcha_response: z.string().trim().max(10_000).optional(),
}).strict();

const resetPasswordSchema = z.object({
  // crypto.randomBytes(32).toString('hex') → 64 chars hex.
  // Validamos formato como defensa anti-basura (no estricto a 64 por compat).
  token:       z.string().trim().regex(/^[0-9a-f]+$/i, 'Token inválido').min(32).max(128),
  newPassword: passwordField(),
}).strict();

module.exports = { loginSchema, changePasswordSchema, forgotPasswordSchema, resetPasswordSchema };

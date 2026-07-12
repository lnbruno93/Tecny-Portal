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
  // 2026-07-12 (auditoría TOTAL Auth P3-2): .max(200). El bcrypt.compare
  // en el path lockeado corre contra el password del user aún cuando está
  // bloqueado (para tiempo constante anti-enum). Sin .max(), un atacante
  // puede mandar strings de 10 kB para saturar CPU (bcrypt escala con la
  // longitud del input). 200 es techo generoso — passwords reales son
  // 8-30 chars, 200 permite passphrases sin bloquear casos legítimos.
  password: z.string().min(1, 'Password requerido').max(200),
  // 2FA: si el user tiene 2FA enabled, después del password OK pedimos el código.
  // El frontend hace 2 requests: el primero sin code (recibe twofa_required=true),
  // el segundo con code. Aceptamos TOTP (6 dígitos) o recovery code (formato libre).
  code:     z.string().trim().min(6).max(20).optional(),
  // 2026-07-12 (auditoría TOTAL Externa P0-1): hCaptcha invisible.
  //
  // Antes: el único freno anti-brute-force era el loginLimiter (10 fallos/
  // 15min por IP normalizada). Un atacante distribuido con 200 IPs
  // rotativas podía probar 2000 credenciales/15min sobre un mismo email.
  // El lockout per-user (SOL-3) sí disparaba, pero solo bloqueaba al
  // legítimo — el atacante seguía martillando cada 15min (~192.000
  // intentos/día por cuenta objetivo).
  //
  // Fix: mismo pattern que /signup, /forgot-password, /super-admin-invite —
  // hcaptcha_response opcional en schema; el toggle vive en HCAPTCHA_ENABLED
  // env. Cuando enabled, verifyCaptcha rechaza sin el token. El widget
  // hCaptcha "invisible" del frontend rara vez muestra desafío para
  // humanos legítimos (0 fricción) pero bloquea bots automatizados.
  //
  // Bound a 10kB — tokens reales son ~500-2000 chars.
  hcaptcha_response: z.string().trim().max(10_000).optional(),
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

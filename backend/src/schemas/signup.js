const { z } = require('zod');
const { passwordField } = require('../lib/password');

/**
 * Schema para POST /api/auth/signup.
 *
 * Campos:
 *   - nombre: nombre completo del user (al saludarlo).
 *   - email: lowercased + trim. Validado como email. UNIQUE en DB
 *     (migration TANDA 1 ya añadió el constraint case-insensitive).
 *   - password: pasa por `passwordField` (mismas reglas que cambio de password —
 *     min length, complejidad, etc.).
 *   - tenant_nombre: nombre del tenant/empresa que el user está creando.
 *     Slug se deriva automáticamente en el route (slugify + collision suffix).
 */
const signupSchema = z.object({
  nombre:        z.string().trim().min(1, 'Nombre requerido').max(100),
  email:         z.string().trim().toLowerCase().email('Email inválido').max(254),
  password:      passwordField(),
  tenant_nombre: z.string().trim().min(2, 'Nombre de empresa: mínimo 2 caracteres').max(80),
  // CAPTCHA: response token del widget hCaptcha. Opcional en el schema porque
  // el toggle operacional vive en backend (HCAPTCHA_ENABLED env var). Si está
  // activado y falta el token, el verifyCaptcha lo rechaza con 'invalid_token'.
  // Bound a 10kB — tokens reales son ~500-2000 chars; este límite protege
  // contra abuse de payload size.
  hcaptcha_response: z.string().trim().max(10_000).optional(),
}).strict();

/** Schema para POST /api/auth/verify-email — recibe token UUID-hex. */
const verifyEmailSchema = z.object({
  // crypto.randomBytes(32).toString('hex') → 64 chars hex.
  // Validamos formato como defensa (no es estricto pero filtra basura).
  token: z.string().trim().regex(/^[0-9a-f]+$/i, 'Token inválido').min(32).max(128),
}).strict();

module.exports = { signupSchema, verifyEmailSchema };

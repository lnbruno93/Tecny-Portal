/**
 * Schemas Zod para el módulo Chat Assistant (#340 Fase 1).
 *
 * Diseño:
 *   - Mensajes con max length conservador (4000 chars) → evita abuse en
 *     términos de tokens / cost (4000 chars ≈ 1000 tokens input).
 *   - .strict() para fail-fast si llegan campos no esperados (defensivo
 *     contra prompt injection vía body inflado).
 *   - Sanitización mínima: el bot lee el texto tal cual, pero la app NO
 *     renderea el input del user como HTML — el frontend usa <Markdown>
 *     que escapa por default. Sin XSS surface.
 *
 * Audit 2026-07-06 P1 (prompt injection hardening): agregamos strip de
 * caracteres de control (\x00-\x1F excepto \n \t \r) al input del user.
 * Los control chars no sirven a un usuario legítimo y son vector clásico
 * de prompt injection avanzado (algunos LLMs interpretan \x00 como
 * delimitador de mensaje, otros permiten fuga de instrucciones vía
 * \x1B[ escape sequences). Es hardening barato + sin false-positives.
 */

const { z } = require('zod');

// Límite de chars por mensaje del user. 4000 ≈ 1000 tokens — suficiente
// para preguntas complejas con contexto, sin abrir la puerta a payloads
// que inflen costo. Si en producción se queda corto, ajustar.
const MAX_USER_MESSAGE_CHARS = 4000;

// Regex de caracteres de control a strippear. Permite \t (0x09), \n (0x0A),
// \r (0x0D) — semánticamente útiles para formateo. Bloquea el resto de
// 0x00-0x1F + 0x7F (DEL). Ejemplos que se filtran: \x00 (null), \x1B
// (escape sequences ANSI), \x08 (backspace).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_STRIP = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// POST /api/chat/conversations — crear conversación nueva (vacía).
// No requiere body: la conv se crea con user_id + tenant_id del ctx,
// titulo NULL hasta el primer mensaje.
const createConversationSchema = z.object({}).strict();

// POST /api/chat/conversations/:id/messages — mandar mensaje al bot.
const sendMessageSchema = z.object({
  text: z
    .string()
    .min(1, 'El mensaje no puede estar vacío')
    .max(MAX_USER_MESSAGE_CHARS, `Máximo ${MAX_USER_MESSAGE_CHARS} caracteres`)
    // Orden importa: primero strip de control chars (que pueden inflar el
    // count visible sin ser visibles), después trim y validación de vacío.
    .transform((s) => s.replace(CONTROL_CHARS_STRIP, '').trim())
    .refine((s) => s.length > 0, 'El mensaje no puede ser solo espacios'),
}).strict();

// GET /api/chat/conversations — listar (acepta query ?limit=).
const listConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

module.exports = {
  createConversationSchema,
  sendMessageSchema,
  listConversationsQuerySchema,
  MAX_USER_MESSAGE_CHARS,
};

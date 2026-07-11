// Schemas de validación para el share link público de Equipos Usados (2026-07-11).
//
// Endpoints admin:
//   GET    /api/inventario/share-link         → devuelve config + stats.
//   PATCH  /api/inventario/share-link         → actualiza config.
//   POST   /api/inventario/share-link/rotate  → nuevo token (sin body).
//
// Endpoint público:
//   GET    /publico/usados/:token             → listado read-only para clientes.

const { z } = require('zod');

// PATCH body: todos los campos opcionales (solo lo que quiera cambiar).
// Los strings vacíos se transforman a null para que "borrar" el WhatsApp
// desde el frontend funcione sin fricción (enviar `""` en vez de omitir).
const nullableTrim = (max) => z
  .string()
  .trim()
  .max(max)
  .transform(v => v === '' ? null : v)
  .optional()
  .nullable();

const updateShareLinkSchema = z.object({
  activo:          z.boolean().optional(),
  whatsapp:        nullableTrim(40),
  mensaje_extra:   nullableTrim(200),
  mostrar_bateria: z.boolean().optional(),
  mostrar_precio:  z.boolean().optional(),
}).strict();

// Param `token` del endpoint público. 24 chars alfanuméricos por defecto
// pero aceptamos 12-64 para dejar margen si cambiamos el generador. Valida
// que sea URL-safe (solo alfanum + guiones) para prevenir path injection.
const tokenParamSchema = z.object({
  token: z.string().trim().regex(/^[A-Za-z0-9_-]{12,64}$/, 'Token inválido'),
});

module.exports = {
  updateShareLinkSchema,
  tokenParamSchema,
};

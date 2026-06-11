const { z } = require('zod');

// GET /api/search?q=<query>&limit=<n>
//
// `q`     — string requerido, mínimo 2 chars (cualquier consulta menor es ruido
//           y no justifica 4 queries paralelas con COUNT). Max 100 para evitar
//           que un cliente intente exfiltrar paginando con queries enormes.
//           Trim primero, valido después: " a " queda como "a" → falla por min.
// `limit` — items por categoría. Default 5 (típico de command palette);
//           tope 20 para evitar respuestas pesadas (4 categorías × 20 = 80
//           filas con tablas mixtas). z.coerce porque viene del query string.
// `.strict()` — query params no esperados (e.g. `?q=x&extra=foo`) → 400. Lo
// usamos en endpoints nuevos por defecto (Follow-up 3 de auditorías previas).
const searchSchema = z.object({
  q: z.string().trim().min(2, 'mín 2 caracteres').max(100, 'máx 100 caracteres'),
  limit: z.coerce.number().int().min(1).max(20).default(5),
}).strict();

module.exports = { searchSchema };

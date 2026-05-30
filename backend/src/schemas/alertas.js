const { z } = require('zod');

// PUT /api/alertas/config/:tipo — actualizar config de una alerta.
// activa y/o parametros (al menos uno).
const updateAlertaConfigSchema = z.object({
  activa:     z.boolean().optional(),
  // Objeto libre — cada tipo conoce sus propios parámetros (umbral_unidades,
  // dias_sin_pago, etc.). El backend valida en runtime contra el evaluador.
  parametros: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
}).strict().refine(d => d.activa !== undefined || d.parametros !== undefined, {
  message: 'Indicá qué actualizar (activa o parametros)',
});

module.exports = { updateAlertaConfigSchema };

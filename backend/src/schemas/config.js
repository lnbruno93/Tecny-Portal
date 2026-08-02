const { z } = require('zod');

// 2026-08-01 (pedido tenant, task #280): ambos campos opcionales para
// permitir PATCHes parciales — el operador puede tocar solo el toggle de
// ganancia sin obligarlo a re-enviar `pct_financiera`, y viceversa.
// El handler valida que venga AL MENOS UNO (refine abajo) para no aceptar
// bodies vacíos que serían no-ops confusos.
const updateConfigSchema = z.object({
  pct_financiera: z.number().min(0, 'No puede ser negativo').max(100, 'No puede superar 100').optional(),
  ocultar_ganancia_venta: z.boolean().optional(),
}).strict().refine(
  d => 'pct_financiera' in d || 'ocultar_ganancia_venta' in d,
  { message: 'Ningún campo para actualizar' }
);

module.exports = { updateConfigSchema };

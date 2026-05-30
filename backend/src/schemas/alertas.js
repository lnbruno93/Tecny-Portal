const { z } = require('zod');

// PUT /api/alertas/config/:tipo — actualizar config de una alerta.
// activa y/o parametros (al menos uno).
const updateAlertaConfigSchema = z.object({
  activa:     z.boolean().optional(),
  // Objeto libre — cada tipo conoce sus propios parámetros (umbral_unidades,
  // dias_sin_pago, etc.). El backend valida en runtime contra el evaluador
  // mediante PARAMETROS_POR_TIPO de abajo.
  parametros: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
}).strict().refine(d => d.activa !== undefined || d.parametros !== undefined, {
  message: 'Indicá qué actualizar (activa o parametros)',
});

// Validación per-tipo de parametros — evita que el front mande claves
// inesperadas (prototype pollution defense: __proto__, constructor, prototype)
// o valores fuera de rango (umbrales negativos, días enormes que rompen queries).
// Las claves no listadas en el schema del tipo se rechazan (.strict()).
const PARAMETROS_POR_TIPO = {
  caja_negativa: z.object({}).strict(), // no acepta parametros
  stock_bajo: z.object({
    umbral_unidades: z.number().int().min(0).max(100000).optional(),
  }).strict(),
  cc_mora: z.object({
    dias_sin_pago: z.number().int().min(1).max(3650).optional(),
  }).strict(),
  proveedor_atrasado: z.object({
    dias_sin_movimiento: z.number().int().min(1).max(3650).optional(),
  }).strict(),
  tc_referencia: z.object({
    valor:               z.number().positive().max(1e9).optional(),
    tolerancia_pct:      z.number().min(0).max(100).optional(),
    alerta_por_debajo:   z.boolean().optional(),
  }).strict(),
};

/**
 * Valida parametros para un tipo de alerta dado. Devuelve el objeto parseado
 * (con .strict() ya aplicado) o lanza ZodError con detalles.
 * Si el tipo no tiene schema registrado, lanza Error genérico (no debería
 * pasar — los tipos se validan antes con `tipoValido`).
 */
function validarParametros(tipo, parametros) {
  const schema = PARAMETROS_POR_TIPO[tipo];
  if (!schema) {
    const e = new Error(`No hay schema de parametros para el tipo "${tipo}"`);
    e.status = 400; throw e;
  }
  return schema.parse(parametros);
}

module.exports = { updateAlertaConfigSchema, PARAMETROS_POR_TIPO, validarParametros };

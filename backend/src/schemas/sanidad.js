// Schemas para el módulo Sanidad del Negocio (feature 2026-06-23).
//
// El módulo es read-mostly: el único INPUT del usuario es el bruto
// proyectado mensual. El resto sale de tablas existentes (ventas,
// egresos, egresos_recurrentes).

const { z } = require('zod');

// Query del endpoint GET — cuántos meses mostrar hacia atrás (incluye el mes
// actual). Default 6 (semestre rolling), max 24 (2 años — más que eso es
// ruido visual + perf en la pantalla).
const queryListadoSchema = z.object({
  meses: z.coerce.number().int().min(1).max(24).default(6),
}).strict();

// Body del PUT que setea el bruto proyectado de UN mes.
//
// `periodo` matchea el CHECK constraint de la DB ('^[0-9]{4}-(0[1-9]|1[0-2])$').
// `bruto_proyectado_usd` debe ser >= 0 (cero significa "este mes no espero
// facturar nada", caso válido al pausar el negocio).
//
// Sin null permitido: para "no tengo proyección" la UI hace DELETE (no PUT
// con null) — más limpio y deja la tabla sin filas placeholder.
const upsertProyeccionSchema = z.object({
  periodo:
    z.string()
      .regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'Periodo debe tener formato YYYY-MM (ej: 2026-06).'),
  bruto_proyectado_usd:
    z.number()
      .nonnegative('El bruto proyectado no puede ser negativo.')
      .max(1e10, 'Valor demasiado alto.'),
}).strict();

// Body del PUT que setea/actualiza un override de gasto para un mes
// específico. El override REEMPLAZA al monto default del recurrente para
// ESE mes; los meses sin override siguen usando el default.
//
// `recurrente_id` debe corresponder a un recurrente activo del tenant
// (FK check + RLS en DB; el handler no lo re-valida explícitamente).
// `monto` >= 0 (igual que egresos_recurrentes.monto).
// `tc` solo se usa si moneda=ARS (se ignora si moneda=USD|USDT).
const upsertOverrideSchema = z.object({
  recurrente_id: z.coerce.number().int().positive(),
  periodo:
    z.string()
      .regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'Periodo debe tener formato YYYY-MM (ej: 2026-06).'),
  monto:
    z.number()
      .nonnegative('El monto no puede ser negativo.')
      .max(1e10, 'Valor demasiado alto.'),
  moneda: z.enum(['USD', 'ARS', 'USDT']).default('USD'),
  tc: z.number().positive().nullable().optional(),
}).strict();

module.exports = { queryListadoSchema, upsertProyeccionSchema, upsertOverrideSchema };

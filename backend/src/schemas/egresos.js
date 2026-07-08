const { z } = require('zod');
// Multi-país F2: enum compartido (acepta UYU). País-aware en el handler.
const { MonedaEnum, MONEDAS_PERMITIDAS, requiereTc } = require('./_common');

// Backward compat — algunos call sites importan MONEDAS directo. La lista
// ahora incluye UYU; pero el filtro real por país lo hace el handler.
const MONEDAS = MONEDAS_PERMITIDAS;
// Fecha ISO válida (los egresos pueden ser futuros: agendados/recurrentes).
const fecha = z.string().date('Fecha inválida (YYYY-MM-DD)').refine(d => d >= '2000-01-01', 'Fecha anterior al año 2000');

// ── Categorías ──
const createCategoriaSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(60),
}).strict();
const updateCategoriaSchema = createCategoriaSchema.partial().refine(
  d => Object.values(d).some(v => v !== undefined), { message: 'Al menos un campo es requerido' }
);

// ── Recurrentes (plantillas mensuales) ──
const createRecurrenteSchema = z.object({
  concepto:       z.string().trim().min(1, 'Concepto requerido').max(200),
  categoria_id:   z.coerce.number().int().positive().optional().nullable(),
  monto:          z.coerce.number().min(0).default(0),
  moneda:         MonedaEnum.default('USD'),
  tc:             z.coerce.number().positive().optional().nullable(),  // TC para recurrentes en ARS
  metodo_pago_id: z.coerce.number().int().positive().optional().nullable(),
  dia_del_mes:    z.coerce.number().int().min(1).max(31).default(1),
  activo:         z.boolean().optional().default(true),
}).strict();
const updateRecurrenteSchema = createRecurrenteSchema.partial().refine(
  d => Object.values(d).some(v => v !== undefined), { message: 'Al menos un campo es requerido' }
);

// ── Egresos ──
// 2026-06-24 SOL-1 (audit pre-live): TC obligatorio cuando la moneda requiere
// conversión (ARS, y desde multi-país F2 también UYU).
// Antes: si el operador cargaba un egreso en ARS sin tc, `toUsd(monto, 'ARS', null)`
// devolvía 0 silenciosamente → el dashboard descontaba USD 0 de la ganancia
// neta, dejando ganancia inflada. El operador no veía error, los KPIs mentían.
// El mismo patrón ya existe en cobranzaItemSchema (cuentas.js:91).
//
// 2026-07-08 Multi-país F2 backfill: el refine solo cubría 'ARS'. Un tenant
// UY cargando un egreso UYU sin TC caía en el mismo bug (`toUsd(m,'UYU',null)=0`).
// Reemplazado por `requiereTc()` que abarca ARS y UYU. Ver `_common.js` para
// el listado completo de sitios corregidos en esta pasada.
const createEgresoSchema = z.object({
  fecha,
  concepto:       z.string().trim().min(1, 'Concepto requerido').max(200),
  categoria_id:   z.coerce.number().int().positive().optional().nullable(),
  monto:          z.coerce.number().min(0).default(0),
  moneda:         MonedaEnum.default('USD'),
  tc:             z.coerce.number().positive().optional().nullable(),
  metodo_pago_id: z.coerce.number().int().positive().optional().nullable(),
  estado:         z.enum(['pendiente', 'pagado']).default('pendiente'),
  notas:          z.string().trim().max(1000).optional().nullable(),
}).strict()
  .refine(d => d.estado !== 'pagado' || d.metodo_pago_id, {
    message: 'Para marcar un egreso como pagado hay que indicar de qué caja sale',
    path: ['metodo_pago_id'],
  })
  .refine(d => !requiereTc(d.moneda) || (d.tc && d.tc > 0), {
    message: 'TC requerido para egresos en ARS o UYU',
    path: ['tc'],
  });

// Update: todos opcionales (incluye cambiar estado pendiente↔pagado).
// SOL-1: TC obligatorio en updates que dejan moneda en una fiat que requiere
// conversión (ARS o UYU post multi-país F2).
// Como en el partial puede venir solo `moneda` o solo `tc` o solo `monto`,
// el refine es defensivo: si la moneda explícitamente queda en una que
// requiere TC, `tc` también tiene que estar (o ya venir != null/>0). El
// handler de la ruta hidrata `tc` desde la fila vieja cuando el partial no
// lo manda — pero no podemos saberlo en el schema. Aceptamos un poco de
// laxitud: solo rechazamos cuando el caller pasa `moneda: 'ARS'|'UYU'` Y
// `tc` explícitamente null/0. Si pasa solo la moneda sin tc, el handler
// debe re-validar (línea ~308 de routes/egresos.js).
const updateEgresoSchema = z.object({
  fecha:          fecha.optional(),
  concepto:       z.string().trim().min(1).max(200).optional(),
  categoria_id:   z.coerce.number().int().positive().optional().nullable(),
  monto:          z.coerce.number().min(0).optional(),
  moneda:         MonedaEnum.optional(),
  tc:             z.coerce.number().positive().optional().nullable(),
  metodo_pago_id: z.coerce.number().int().positive().optional().nullable(),
  estado:         z.enum(['pendiente', 'pagado']).optional(),
  notas:          z.string().trim().max(1000).optional().nullable(),
}).strict()
  .refine(d => Object.values(d).some(v => v !== undefined), { message: 'Al menos un campo es requerido' })
  .refine(d => !requiereTc(d.moneda) || d.tc === undefined || (d.tc && d.tc > 0), {
    message: 'TC requerido para egresos en ARS o UYU',
    path: ['tc'],
  });

const queryEgresosSchema = z.object({
  desde:        z.string().date().optional(),
  hasta:        z.string().date().optional(),
  estado:       z.enum(['pendiente', 'pagado']).optional(),
  categoria_id: z.coerce.number().int().positive().optional(),
  limit:        z.coerce.number().int().positive().max(500).optional(),
  offset:       z.coerce.number().int().min(0).optional(),
  page:         z.coerce.number().int().positive().optional(),
});

// Generar egresos pendientes de los recurrentes para un período (YYYY-MM).
const generarPeriodoSchema = z.object({
  periodo: z.string().regex(/^\d{4}-\d{2}$/, 'Período debe ser YYYY-MM'),
}).strict();

module.exports = {
  createCategoriaSchema, updateCategoriaSchema,
  createRecurrenteSchema, updateRecurrenteSchema,
  createEgresoSchema, updateEgresoSchema, queryEgresosSchema, generarPeriodoSchema,
  MONEDAS,
};

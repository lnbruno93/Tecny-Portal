const { z } = require('zod');

const MONEDAS = ['USD', 'ARS', 'USDT'];
// Fecha ISO válida (los egresos pueden ser futuros: agendados/recurrentes).
const fecha = z.string().date('Fecha inválida (YYYY-MM-DD)').refine(d => d >= '2000-01-01', 'Fecha anterior al año 2000');

// ── Categorías ──
const createCategoriaSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(60),
});
const updateCategoriaSchema = createCategoriaSchema.partial().refine(
  d => Object.values(d).some(v => v !== undefined), { message: 'Al menos un campo es requerido' }
);

// ── Recurrentes (plantillas mensuales) ──
const createRecurrenteSchema = z.object({
  concepto:       z.string().trim().min(1, 'Concepto requerido').max(200),
  categoria_id:   z.coerce.number().int().positive().optional().nullable(),
  monto:          z.coerce.number().min(0).default(0),
  moneda:         z.enum(MONEDAS).default('USD'),
  metodo_pago_id: z.coerce.number().int().positive().optional().nullable(),
  dia_del_mes:    z.coerce.number().int().min(1).max(31).default(1),
  activo:         z.boolean().optional().default(true),
});
const updateRecurrenteSchema = createRecurrenteSchema.partial().refine(
  d => Object.values(d).some(v => v !== undefined), { message: 'Al menos un campo es requerido' }
);

// ── Egresos ──
const createEgresoSchema = z.object({
  fecha,
  concepto:       z.string().trim().min(1, 'Concepto requerido').max(200),
  categoria_id:   z.coerce.number().int().positive().optional().nullable(),
  monto:          z.coerce.number().min(0).default(0),
  moneda:         z.enum(MONEDAS).default('USD'),
  tc:             z.coerce.number().positive().optional().nullable(),
  metodo_pago_id: z.coerce.number().int().positive().optional().nullable(),
  estado:         z.enum(['pendiente', 'pagado']).default('pendiente'),
  notas:          z.string().trim().max(1000).optional().nullable(),
}).refine(d => d.estado !== 'pagado' || d.metodo_pago_id, {
  message: 'Para marcar un egreso como pagado hay que indicar de qué caja sale',
  path: ['metodo_pago_id'],
});

// Update: todos opcionales (incluye cambiar estado pendiente↔pagado).
const updateEgresoSchema = z.object({
  fecha:          fecha.optional(),
  concepto:       z.string().trim().min(1).max(200).optional(),
  categoria_id:   z.coerce.number().int().positive().optional().nullable(),
  monto:          z.coerce.number().min(0).optional(),
  moneda:         z.enum(MONEDAS).optional(),
  tc:             z.coerce.number().positive().optional().nullable(),
  metodo_pago_id: z.coerce.number().int().positive().optional().nullable(),
  estado:         z.enum(['pendiente', 'pagado']).optional(),
  notas:          z.string().trim().max(1000).optional().nullable(),
}).refine(d => Object.values(d).some(v => v !== undefined), { message: 'Al menos un campo es requerido' });

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
});

module.exports = {
  createCategoriaSchema, updateCategoriaSchema,
  createRecurrenteSchema, updateRecurrenteSchema,
  createEgresoSchema, updateEgresoSchema, queryEgresosSchema, generarPeriodoSchema,
  MONEDAS,
};

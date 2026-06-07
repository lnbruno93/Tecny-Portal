const { z } = require('zod');
const { fechaNoFutura } = require('./_common');

// Comprobante manual de Financiera (réplica del "cobro previo" de Tarjetas).
// Para cargar ventas anteriores al sistema donde el cliente pagó con la caja
// Financiera. Se crea con venta_id=NULL (marker) — no impacta caja_movimientos
// (la venta no existe en el sistema, no hay ingreso para registrar), solo
// agrega al resumen de Financiera (bruto + comisión + neto).
//
// El neto se calcula server-side: bruto * (1 - pct/100). El `pct` es opcional;
// si no se manda, se usa el `pct_financiera` de config.
const createManualComprobanteSchema = z.object({
  fecha:        fechaNoFutura,
  cliente:      z.string().trim().min(1, 'Cliente requerido').max(200),
  vendedor_id:  z.coerce.number().int().positive().optional().nullable(),
  monto_bruto:  z.coerce.number().positive('El bruto debe ser mayor a 0'),
  pct:          z.coerce.number().min(0).max(100).optional().nullable(),
  referencia:   z.string().trim().max(500).optional().nullable(),
}).strict();

// Editar un comprobante manual existente. Solo aplica a venta_id IS NULL —
// los autogenerados desde Ventas se ajustan editando la venta.
const updateManualComprobanteSchema = z.object({
  fecha:        fechaNoFutura.optional(),
  cliente:      z.string().trim().min(1).max(200).optional(),
  vendedor_id:  z.coerce.number().int().positive().optional().nullable(),
  monto_bruto:  z.coerce.number().positive('El bruto debe ser mayor a 0').optional(),
  pct:          z.coerce.number().min(0).max(100).optional().nullable(),
  referencia:   z.string().trim().max(500).optional().nullable(),
}).strict().refine(
  (d) => Object.keys(d).some(k => d[k] !== undefined),
  { message: 'Al menos un campo es requerido para actualizar' }
);

const baseComprobante = z.object({
  fecha:            z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  cliente:          z.string().trim().min(1, 'Cliente requerido').max(200),
  vendedor_id:      z.number().int().positive().optional().nullable(),
  monto:            z.number().positive('Monto debe ser positivo'),
  monto_financiera: z.number().min(0).default(0),
  monto_neto:       z.number().min(0).optional(),
  referencia:       z.string().trim().max(500).optional().nullable(),
  // Base64 de archivo adjunto — max ~7MB de string (≈5MB real)
  archivo_data:     z.string().max(7 * 1024 * 1024, 'Archivo demasiado grande (máx. 5MB)').optional().nullable(),
  archivo_nombre:   z.string().trim().max(255).optional().nullable(),
  archivo_tipo:     z.enum(['image/jpeg','image/png','image/webp','application/pdf']).optional().nullable(),
}).strict();

const createComprobanteSchema = baseComprobante;

const queryComprobantesSchema = z.object({
  desde:    z.string().date().optional(),
  hasta:    z.string().date().optional(),
  vendedor: z.string().trim().optional(),
  buscar:   z.string().trim().max(200).optional(),
  page:     z.coerce.number().int().positive().optional(),
  // Listado normal: el frontend pasa limit=500 (max usable en la UI, tope
  // legacy). El cap del schema se subió a 5000 para acomodar el caso de
  // export PDF/XLSX desde Financiera, que hace un re-fetch del período
  // completo para incluir TODO en el resumen (no solo lo paginado en
  // pantalla). 5000 acomoda ~3-6 meses operativos a volumen actual y la
  // UI sigue limitada por su propio cap de 500 en el componente.
  limit:    z.coerce.number().int().positive().max(5000).optional(),
});

module.exports = {
  createComprobanteSchema,
  queryComprobantesSchema,
  createManualComprobanteSchema,
  updateManualComprobanteSchema,
};

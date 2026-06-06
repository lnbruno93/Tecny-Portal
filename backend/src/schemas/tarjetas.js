const { z } = require('zod');
const { fechaNoFutura } = require('./_common');

// Usamos `fechaNoFutura` del módulo compartido — antes el local `fecha` permitía
// fechas futuras (solo validaba >= 2000-01-01), incluyendo año 2099. Para
// liquidaciones/cobros/edits eso no tiene sentido: la fecha es siempre del
// pasado o presente (no se "agendan" cobros futuros desde acá).
const fecha = fechaNoFutura;

// Liquidación: el procesador deposita lo que nos debe → ingreso a una caja real.
// Resta del saldo pendiente del método de pago tarjeta.
const createLiquidacionSchema = z.object({
  metodo_pago_id: z.coerce.number().int().positive('Elegí la tarjeta'),
  fecha,
  monto:          z.coerce.number().positive('El monto debe ser mayor a 0'),
  caja_id:        z.coerce.number().int().positive('Elegí la caja donde entra'),
  comentarios:    z.string().trim().max(1000).optional().nullable(),
}).strict();

// Cobro inicial / previo (junio 2026): para cargar saldos pendientes de ventas
// anteriores al sistema. Se crea un movimiento tipo='cobro' con venta_id=NULL
// (marker de "manual/inicial" — no viene de una venta registrada en el sistema).
// El neto se calcula server-side: bruto * (1 - pct/100). El `pct` es opcional;
// si no se manda, se usa el comision_pct del método de pago.
const createCobroInicialSchema = z.object({
  metodo_pago_id: z.coerce.number().int().positive('Elegí la tarjeta'),
  fecha,
  monto_bruto:    z.coerce.number().positive('El bruto debe ser mayor a 0'),
  pct:            z.coerce.number().min(0).max(100).optional().nullable(),
  comentarios:    z.string().trim().max(1000).optional().nullable(),
}).strict();

// Editar un movimiento existente. El handler valida según el tipo:
//   - cobro previo (venta_id IS NULL): usa fecha, monto_bruto, pct, comentarios
//   - liquidación: usa fecha, monto, caja_id, comentarios (revierte caja + repone)
//   - cobro de venta (venta_id != NULL): se rechaza (se ajusta editando la venta)
// Schema laxo a propósito — el dispatch real está en el route handler.
const updateMovimientoSchema = z.object({
  fecha:        fecha.optional(),
  monto_bruto:  z.coerce.number().positive('El bruto debe ser mayor a 0').optional(),
  pct:          z.coerce.number().min(0).max(100).optional().nullable(),
  monto:        z.coerce.number().positive('El monto debe ser mayor a 0').optional(),
  caja_id:      z.coerce.number().int().positive('Elegí la caja donde entra').optional(),
  comentarios:  z.string().trim().max(1000).optional().nullable(),
}).strict().refine(
  // TANDA 3 post-auditoría: rechazar PATCH con body vacío {}. Antes hacía 200
  // con un UPDATE no-op + un audit ruidoso. Patrón consistente con el resto
  // del repo (schemas/cajas.js updateCajaSchema, schemas/contactos.js, etc.).
  (d) => Object.keys(d).some(k => d[k] !== undefined),
  { message: 'Al menos un campo es requerido para actualizar' }
);

// Liquidación múltiple (junio 2026): la financiera deposita UN solo monto
// que cubre cupones de varios planes (1 cuota, 3 cuotas, 6 cuotas, etc.).
// El operador desglosa cuánto del depósito va a cada tarjeta. El backend
// crea N movimientos atómicamente: 1 mov de liquidación por tarjeta + 1
// ingreso a la caja destino por tarjeta. Si una falla, rollback completo.
//
// Campos opcionales (junio 2026, evolución del flujo real):
//   · convertir_usd     Si true, la liquidación se deposita en USD usando
//                       el TC informado por la financiera. Las liquidaciones
//                       siguen siendo en ARS (bajan el pendiente correcto),
//                       pero el ingreso a caja va en USD (= monto_ars / tc o
//                       el override total_usd_efectivo si está cargado).
//   · tc                Requerido si convertir_usd. TC ARS→USD del día.
//   · total_usd_efectivo Override opcional del USD total. Si el cálculo da
//                       1211.44 pero la financiera te depositó 1211.40 por
//                       redondeo, cargás el real acá y se distribuye
//                       proporcionalmente entre los N ingresos a caja.
//   · periodo_desde/hasta Rango cubierto por la liquidación (ej. la planilla
//                       dice "26-27/5"). Info para conciliar contra cupones
//                       cuando hay dudas.
const createLiquidacionMultipleSchema = z.object({
  fecha,
  caja_id:            z.coerce.number().int().positive('Elegí la caja donde entra'),
  comentarios:        z.string().trim().max(1000).optional().nullable(),
  // No usamos z.coerce.boolean() — convierte el string "false" a true. Ver
  // comentario en schemas/pagos.js (mismo bug latente, mismo fix).
  convertir_usd:      z.union([
    z.boolean(),
    z.enum(['true', 'false']).transform(v => v === 'true'),
  ]).optional().default(false),
  tc:                 z.coerce.number().positive('TC debe ser mayor a 0').optional(),
  total_usd_efectivo: z.coerce.number().positive('El USD recibido debe ser > 0').optional(),
  periodo_desde:      fechaNoFutura.optional(),
  periodo_hasta:      fechaNoFutura.optional(),
  repartos:           z.array(z.object({
    metodo_pago_id: z.coerce.number().int().positive(),
    monto:          z.coerce.number().positive(),
  }).strict()).min(1, 'Necesitás al menos una tarjeta con monto').refine(
    (repartos) => {
      // No permitimos repetir tarjetas — sería ambiguo (¿dos liquidaciones a
      // la misma tarjeta en el mismo depósito?). Si el operador necesita
      // dos movs distintos a la misma tarjeta, los registra por separado.
      const ids = repartos.map(r => r.metodo_pago_id);
      return new Set(ids).size === ids.length;
    },
    { message: 'No se puede repetir una tarjeta en el reparto' }
  ),
}).strict().refine(
  // Si convertir_usd está activo, el TC es obligatorio (sino no podríamos
  // calcular el monto USD).
  (d) => !d.convertir_usd || (typeof d.tc === 'number' && d.tc > 0),
  { message: 'Si convertís a USD, el TC del día es obligatorio', path: ['tc'] }
).refine(
  // total_usd_efectivo solo tiene sentido si convertir_usd está activo.
  (d) => !d.total_usd_efectivo || d.convertir_usd,
  { message: 'El USD efectivo solo aplica si convertís a USD', path: ['total_usd_efectivo'] }
).refine(
  // tc solo tiene sentido si convertir_usd está activo (defensa contra ruido).
  (d) => d.tc === undefined || d.convertir_usd,
  { message: 'El TC solo aplica si convertís a USD', path: ['tc'] }
).refine(
  // Si está cargado "desde" pero falta "hasta", el error apunta a "hasta"
  // (campo a completar). Permitimos que ambos estén ausentes.
  (d) => !d.periodo_desde || d.periodo_hasta,
  { message: 'Cargá ambos extremos del período o ninguno', path: ['periodo_hasta'] }
).refine(
  // Espejo: si está cargado "hasta" pero falta "desde", el error apunta a
  // "desde" para que el frontend pinte el campo correcto.
  (d) => !d.periodo_hasta || d.periodo_desde,
  { message: 'Cargá ambos extremos del período o ninguno', path: ['periodo_desde'] }
).refine(
  (d) => !d.periodo_desde || !d.periodo_hasta || d.periodo_desde <= d.periodo_hasta,
  { message: 'El "desde" del período debe ser ≤ "hasta"', path: ['periodo_hasta'] }
);

module.exports = { createLiquidacionSchema, createLiquidacionMultipleSchema, createCobroInicialSchema, updateMovimientoSchema };

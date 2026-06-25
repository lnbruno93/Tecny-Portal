const { z } = require('zod');
const { fechaNoFutura } = require('./_common');

const CATEGORIAS_CC       = ['VIP', 'A+', 'A-'];
const TIPOS_MOVIMIENTO_CC = ['compra', 'pago', 'devolucion', 'parte_de_pago', 'entrega_mercaderia'];

// ─── Cliente CC ───────────────────────────────────────────────────────────────

const createClienteCCSchema = z.object({
  nombre:      z.string().trim().min(1, 'Nombre requerido').max(100),
  apellido:    z.string().trim().max(100).optional().nullable(),
  contacto:    z.string().trim().max(200).optional().nullable(),  // tel/WhatsApp/email
  marca_redes: z.string().trim().max(200).optional().nullable(),
  provincia:   z.string().trim().max(100).optional().nullable(),
  localidad:   z.string().trim().max(100).optional().nullable(),
  direccion:   z.string().trim().max(200).optional().nullable(),
  categoria:   z.enum(CATEGORIAS_CC, { error: `Categoría debe ser: ${CATEGORIAS_CC.join(', ')}` }),
  notas:       z.string().trim().max(1000).optional().nullable(),
  // Saldo de apertura opcional: el cliente arranca debiéndonos este monto (en USD)
  saldo_inicial: z.coerce.number().min(0, 'El saldo inicial no puede ser negativo').optional(),
}).strict();

const updateClienteCCSchema = createClienteCCSchema.partial().refine(
  d => Object.values(d).some(v => v !== undefined),
  { message: 'Al menos un campo es requerido para actualizar' }
);

// ─── Item de movimiento ───────────────────────────────────────────────────────

const itemMovimientoCCSchema = z.object({
  producto:    z.string().trim().max(100).optional().nullable(),
  modelo:      z.string().trim().max(100).optional().nullable(),
  tamano:      z.string().trim().max(50).optional().nullable(),
  color:       z.string().trim().max(50).optional().nullable(),
  imei_serial: z.string().trim().max(100).optional().nullable(),
  valor:       z.number().nonnegative('Valor no puede ser negativo').optional().nullable(),
  verificado:  z.boolean().optional().default(false),
  notas:       z.string().trim().max(500).optional().nullable(),
  // Si se referencia un producto del Inventario, al guardar el movimiento
  // (tipo=compra/entrega_mercaderia) se valida disponibilidad y se descuenta
  // stock. Sin producto_id la línea sigue siendo texto libre (legacy/servicio).
  producto_id: z.coerce.number().int().positive().optional().nullable(),
  // Hard cap en cantidad + positive() (auditoría #M-03): líneas con
  // cantidad=0 no tenían sentido (item fantasma sin efecto en stock).
  cantidad:    z.coerce.number().int().positive().max(10_000).optional().default(1),
}).strict(); // #H-08 — rechaza campos extra para defense-in-depth

// ─── Movimiento CC ────────────────────────────────────────────────────────────

const createMovimientoCCSchema = z.object({
  cliente_cc_id: z.number().int().positive('ID de cliente requerido'),
  // Comparación date-only (lexical sobre strings ISO YYYY-MM-DD), siempre contra
  // el "hoy" en UTC — la misma base que usa el front (new Date().toISOString()).
  // Fecha con validación compartida (M-07): no futura, no antes del 2000.
  fecha:         fechaNoFutura,
  tipo:          z.enum(TIPOS_MOVIMIENTO_CC, { error: `Tipo debe ser: ${TIPOS_MOVIMIENTO_CC.join(', ')}` }),
  descripcion:   z.string().trim().max(500).optional().nullable(),
  // Hard cap: 10M USD por movimiento. Previene overflow JS Number en sumas
  // de saldos cuando alguien envía 1e18 por error o malicia (auditoría #B-04).
  monto_total:   z.number().positive('El monto debe ser mayor a 0').max(10_000_000, 'El monto excede el máximo permitido (10M USD)'),
  // Caja donde ingresa el pago. Schema permite null/undefined acá; el refine
  // de abajo lo exige cuando tipo=pago/parte_de_pago/compra (ver SOL-2).
  caja_id:       z.coerce.number().int().positive().optional().nullable(),
  notas:         z.string().trim().max(1000).optional().nullable(),
  // 2026-06-10: estado visual de la venta. Default 'acreditado' (la venta
  // se considera registrada/confirmada). El operador puede pasar 'pendiente'
  // desde la grilla. Aplica solo a tipo='compra'; otros tipos lo ignoran.
  estado:        z.enum(['acreditado', 'pendiente']).optional().default('acreditado'),
  // items solo aplica a compra/devolucion — la ruta ignora items en otros tipos
  items:         z.array(itemMovimientoCCSchema).max(200, 'Máximo 200 ítems por movimiento').optional().default([]),
}).strict()
  // 2026-06-25 SOL-2 (audit pre-live): caja_id obligatorio cuando el
  // movimiento implica un ingreso/egreso de dinero. Antes el schema lo
  // permitía null para TODOS los tipos — un POST con tipo='pago' sin caja_id
  // bajaba la deuda del cliente PERO no acreditaba ninguna caja física. El
  // dinero "entraba al sistema fantasma" — saldo CC correcto pero el libro
  // de cajas no veía el cobro, reconciliación rota silenciosamente.
  //
  // Tipos que requieren caja_id:
  //   - 'pago'           — el cliente paga su deuda. Cobramos en alguna caja.
  //   - 'parte_de_pago'  — pago parcial. Mismo razonamiento.
  //   - 'compra'         — venta a crédito. Si hay caja, registra el cobro
  //                        inicial; si no, queda totalmente a crédito. Acá
  //                        SÍ aceptamos caja_id null (es por diseño).
  //
  // El refine valida los 2 primeros casos; 'compra' y otros tipos
  // ('devolucion', 'ajuste') siguen aceptando caja_id null.
  .refine(
    d => !['pago', 'parte_de_pago'].includes(d.tipo) || (d.caja_id != null && d.caja_id > 0),
    { message: 'caja_id requerido para tipo pago/parte_de_pago', path: ['caja_id'] }
  );

// PATCH /movimientos/:id/estado — alternar entre acreditado/pendiente desde la grilla.
const updateEstadoMovimientoCCSchema = z.object({
  estado: z.enum(['acreditado', 'pendiente'], { error: 'Estado debe ser acreditado o pendiente' }),
}).strict();

// ─── Cobranza masiva ─────────────────────────────────────────────────────────
// N pagos en bloque. Cada fila tiene su propio cliente, monto, caja y TC.
// Procesamiento atómico (todo o nada): si una fila falla, ninguna se aplica.
const cobranzaItemSchema = z.object({
  cliente_cc_id: z.coerce.number().int().positive(),
  fecha:         fechaNoFutura,
  monto:         z.coerce.number().positive('El monto debe ser > 0').max(10_000_000, 'Monto excede el máximo (10M)'),
  moneda:        z.enum(['USD', 'ARS', 'USDT']).default('USD'),
  tc:            z.coerce.number().positive().optional().nullable(),
  caja_id:       z.coerce.number().int().positive('Caja requerida'),
  // 'pago' = pago total. 'parte_de_pago' = pago parcial sin saldar la deuda.
  // El cliente decide en la UI; el efecto en saldo es el mismo (ambos restan).
  tipo:          z.enum(['pago', 'parte_de_pago']).default('pago'),
  descripcion:   z.string().trim().max(500).optional().nullable(),
}).strict().refine(d => d.moneda === 'USD' || (d.tc && d.tc > 0), {
  message: 'Para montos en ARS/USDT se requiere TC',
  path: ['tc'],
});

const cobranzaMasivaSchema = z.object({
  cobranzas: z.array(cobranzaItemSchema)
    .min(1, 'Al menos un pago')
    .max(100, 'Máximo 100 pagos por lote'),
}).strict();

module.exports = {
  createClienteCCSchema,
  updateClienteCCSchema,
  createMovimientoCCSchema,
  updateEstadoMovimientoCCSchema,
  cobranzaMasivaSchema,
  CATEGORIAS_CC,
  TIPOS_MOVIMIENTO_CC,
};

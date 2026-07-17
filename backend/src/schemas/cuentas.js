const { z } = require('zod');
const { baseProducto } = require('./inventario');
const { fechaNoFutura, MonedaEnum } = require('./_common');

const CATEGORIAS_CC       = ['VIP', 'A+', 'A-'];
// 2026-07-17 (task #155): agregado 'mercaderia_recibida'. Cliente entrega
// productos que cancelan (todo o parte) de su deuda con nosotros. Distinto de
// `entrega_mercaderia` (semántica opuesta: nosotros le entregamos al cliente).
// 2026-07-17 (bis): agregado 'pago_a_cliente'. Simetría del `pago`: nosotros
// le damos dinero al cliente (reembolso, devolución, anticipo). Requiere
// caja_id (EGRESO) y sube el saldo del cliente.
const TIPOS_MOVIMIENTO_CC = ['compra', 'pago', 'devolucion', 'parte_de_pago', 'entrega_mercaderia', 'mercaderia_recibida', 'pago_a_cliente'];

// Sub-objeto opcional para crear producto en Inventario cuando el cliente
// entrega mercadería (tipo=mercaderia_recibida). Reutiliza el mismo schema de
// Inventario (sin foto). Espejo del que ya existe en schemas/proveedores.js
// para las compras a proveedores.
const productoEnEntregaSchema = baseProducto
  .omit({ foto_data: true, foto_nombre: true, foto_tipo: true })
  .strict();

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
  // 2026-07-17 (task #155): sólo para tipo=mercaderia_recibida — el cliente
  // entrega productos que NO están en nuestro catálogo. Al guardar el
  // movimiento, la ruta INSERTa el producto en `productos`. Espejo del
  // `producto_stock` del itemProveedorSchema. Si se envía en otro tipo, la
  // ruta lo ignora (el schema no lo rechaza para no romper backwards compat
  // en clientes que envíen accidentalmente el campo).
  producto_stock: productoEnEntregaSchema.optional().nullable(),
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
  // Hard cap: 10M por movimiento (moneda del pago). Previene overflow JS
  // Number en sumas de saldos cuando alguien envía 1e18 por error o malicia
  // (auditoría #B-04).
  monto_total:   z.number().positive('El monto debe ser mayor a 0').max(10_000_000, 'El monto excede el máximo permitido (10M)'),
  // Caja donde ingresa el pago. Schema permite null/undefined acá; el refine
  // de abajo lo exige cuando tipo=pago/parte_de_pago/compra (ver SOL-2).
  caja_id:       z.coerce.number().int().positive().optional().nullable(),
  // 2026-07-12 (auditoría TOTAL Financiero P0-1): agregado `moneda` + `tc`.
  //
  // Antes el schema no los tenía → el POST hardcodeaba `moneda: 'USD',
  // tc: null` al postear a caja. Impacto:
  //   · Tenant UY con caja UYU: rebotaba con 400 ("moneda del pago (USD) no
  //     coincide con la de la caja (UYU)"). NO se podía registrar el cobro.
  //   · Tenant AR con caja USDT: pasaba validación (USD/USDT mismo grupo)
  //     pero el `monto_total` (nominalmente USD) se persistía en la caja
  //     como USDT crudo — si el operador cargó ARS creyendo USD, quedaba
  //     inflado ×1400 silenciosamente.
  //   · Contract violation con SALDO_CASE (que asume monto_total en USD).
  //
  // Fix: aceptar la moneda del pago + tc de conversión. El backend convierte
  // el monto a USD para `movimientos_cc.monto_total` (mantiene el invariant
  // del SALDO_CASE) y postea a caja con la moneda real (mantiene saldo
  // nativo de la caja correcto).
  //
  // Backwards compat: `.default('USD')` — clientes viejos que no mandan
  // moneda siguen tratados como USD (comportamiento pre-fix para AR).
  moneda:        MonedaEnum.default('USD'),
  tc:            z.coerce.number().positive().optional().nullable(),
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
  //   - 'pago_a_cliente' — NOSOTROS le damos dinero al cliente. La plata sale
  //                        de una caja específica (EGRESO).
  //   - 'compra'         — venta a crédito. Si hay caja, registra el cobro
  //                        inicial; si no, queda totalmente a crédito. Acá
  //                        SÍ aceptamos caja_id null (es por diseño).
  //
  // El refine valida los 3 primeros casos; 'compra' y otros tipos
  // ('devolucion', 'ajuste') siguen aceptando caja_id null.
  .refine(
    d => !['pago', 'parte_de_pago', 'pago_a_cliente'].includes(d.tipo) || (d.caja_id != null && d.caja_id > 0),
    { message: 'caja_id requerido para tipo pago/parte_de_pago/pago_a_cliente', path: ['caja_id'] }
  )
  // 2026-07-12 P0-1: si el pago NO es USD, exigir `tc` positivo (para convertir
  // a USD y persistir en `movimientos_cc.monto_total` correcto). Consistente con
  // el `refine` del `cobranzaItemSchema` (línea 112).
  .refine(
    d => d.moneda === 'USD' || (d.tc != null && d.tc > 0),
    { message: 'Para montos en ARS/UYU/USDT se requiere TC positivo', path: ['tc'] }
  )
  // 2026-07-17 (task #155): mercaderia_recibida NO admite caja_id — los
  // productos entregados por el cliente SON el pago, no hay dinero involucrado.
  // Defensa en profundidad: si el caller lo manda por error, rechazamos.
  .refine(
    d => !(d.tipo === 'mercaderia_recibida' && d.caja_id != null),
    { message: 'mercaderia_recibida no admite caja_id: los productos recibidos son el pago', path: ['caja_id'] }
  )
  // 2026-07-17 (task #155): mercaderia_recibida requiere al menos 1 item con
  // producto_stock (para crear el producto en Inventario) o producto_id (para
  // referenciar uno existente). Sin items no tendría efecto sobre stock —
  // sería equivalente a un pago sin caja, que no tiene sentido.
  .refine(
    d => d.tipo !== 'mercaderia_recibida' || (d.items || []).length >= 1,
    { message: 'mercaderia_recibida requiere al menos 1 item (los productos entregados)', path: ['items'] }
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
  moneda:        MonedaEnum.default('USD'),
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

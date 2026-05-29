const { z } = require('zod');

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
  cantidad:    z.coerce.number().int().nonnegative().optional().default(1),
});

// ─── Movimiento CC ────────────────────────────────────────────────────────────

const createMovimientoCCSchema = z.object({
  cliente_cc_id: z.number().int().positive('ID de cliente requerido'),
  // Comparación date-only (lexical sobre strings ISO YYYY-MM-DD), siempre contra
  // el "hoy" en UTC — la misma base que usa el front (new Date().toISOString()).
  // Evita el bug de zona horaria: parsear con new Date(d+'T00:00:00') usaba la TZ
  // local del server y, pasada la medianoche UTC, rechazaba el día actual como "futuro".
  fecha:         z.string()
    .date('Fecha inválida (YYYY-MM-DD)')
    .refine(d => {
      const todayUTC = new Date().toISOString().split('T')[0];
      return d >= '2000-01-01' && d <= todayUTC;
    }, 'La fecha no puede ser futura ni anterior al año 2000'),
  tipo:          z.enum(TIPOS_MOVIMIENTO_CC, { error: `Tipo debe ser: ${TIPOS_MOVIMIENTO_CC.join(', ')}` }),
  descripcion:   z.string().trim().max(500).optional().nullable(),
  monto_total:   z.number().positive('El monto debe ser mayor a 0'),
  // Caja donde ingresa el pago (solo aplica a tipos 'pago'/'parte_de_pago')
  caja_id:       z.coerce.number().int().positive().optional().nullable(),
  notas:         z.string().trim().max(1000).optional().nullable(),
  // items solo aplica a compra/devolucion — la ruta ignora items en otros tipos
  items:         z.array(itemMovimientoCCSchema).max(200, 'Máximo 200 ítems por movimiento').optional().default([]),
}).strict();

module.exports = {
  createClienteCCSchema,
  updateClienteCCSchema,
  createMovimientoCCSchema,
  CATEGORIAS_CC,
  TIPOS_MOVIMIENTO_CC,
};

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
});

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
});

// ─── Movimiento CC ────────────────────────────────────────────────────────────

const createMovimientoCCSchema = z.object({
  cliente_cc_id: z.number().int().positive('ID de cliente requerido'),
  fecha:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)'),
  tipo:          z.enum(TIPOS_MOVIMIENTO_CC, { error: `Tipo debe ser: ${TIPOS_MOVIMIENTO_CC.join(', ')}` }),
  descripcion:   z.string().trim().max(500).optional().nullable(),
  monto_total:   z.number().nonnegative('El monto no puede ser negativo'),
  notas:         z.string().trim().max(1000).optional().nullable(),
  // items solo aplica a compra/devolucion — la ruta ignora items en otros tipos
  items:         z.array(itemMovimientoCCSchema).optional().default([]),
});

module.exports = {
  createClienteCCSchema,
  updateClienteCCSchema,
  createMovimientoCCSchema,
  CATEGORIAS_CC,
  TIPOS_MOVIMIENTO_CC,
};

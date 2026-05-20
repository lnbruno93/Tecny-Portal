const { z } = require('zod');

const envioItemSchema = z.object({
  tipo:        z.enum(['producto','pago'], { error: 'tipo de item debe ser: producto, pago' }),
  descripcion: z.string().trim().max(300).optional().nullable(),
  monto:       z.number().min(0).default(0),
  metodo_pago: z.string().trim().max(100).optional().nullable(),
});

const baseEnvio = z.object({
  fecha:         z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  cliente:       z.string().trim().min(1, 'Cliente requerido').max(200),
  telefono:      z.string().trim().max(30).optional().nullable(),
  direccion:     z.string().trim().min(1, 'Dirección requerida').max(300),
  barrio:        z.string().trim().max(100).optional().nullable(),
  costo_envio:   z.number().min(0).default(0),
  total_cobrado: z.number().min(0).default(0),
  horario:       z.string().trim().max(100).optional().nullable(),
  operador:      z.string().trim().max(100).optional().nullable(),
  notas:         z.string().trim().max(1000).optional().nullable(),
  estado:        z.enum(['Pendiente','En camino','Entregado','Cancelado']).default('Pendiente'),
  prioridad:     z.enum(['Alta','Media','Baja']).optional().nullable(),
  items:         z.array(envioItemSchema).default([]),
});

const createEnvioSchema = baseEnvio;

// PUT — todo opcional excepto validaciones de tipo
const updateEnvioSchema = baseEnvio.partial();

const queryEnviosSchema = z.object({
  estado: z.enum(['Pendiente','En camino','Entregado','Cancelado']).optional(),
  buscar: z.string().trim().max(200).optional(),
  desde:  z.string().date().optional(),
  hasta:  z.string().date().optional(),
});

module.exports = { createEnvioSchema, updateEnvioSchema, queryEnviosSchema };

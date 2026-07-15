const { z } = require('zod');
// 2026-06-29 Multi-país F2: enum compartido. La restricción país-aware
// (tenant AR no acepta UYU, tenant UY no acepta ARS) se hace en el handler
// con `assertMonedaValidaParaPais` — el schema acepta las 4 monedas.
const { MonedaEnum } = require('./_common');

const HORA_RE = /^\d{2}:\d{2}(:\d{2})?$/;

/* ── Sub-objetos de una venta ── */
const ventaItemSchema = z.object({
  producto_id:     z.coerce.number().int().positive().optional().nullable(),
  vendedor_id:     z.coerce.number().int().positive().optional().nullable(),
  descripcion:     z.string().trim().min(1, 'Descripción requerida').max(300),
  imei:            z.string().trim().max(50).optional().nullable(),
  cantidad:        z.coerce.number().int().positive().default(1),
  precio_vendido:  z.coerce.number().min(0).default(0),
  precio_original: z.coerce.number().min(0).optional().nullable(),
  costo:           z.coerce.number().min(0).default(0),
  moneda:          MonedaEnum.default('USD'),
  comision:        z.coerce.number().min(0).default(0),
});

const ventaPagoSchema = z.object({
  metodo_pago_id:      z.coerce.number().int().positive().optional().nullable(),
  metodo_nombre:       z.string().trim().min(1, 'Método requerido').max(120),
  monto:               z.coerce.number().min(0).default(0),
  moneda:              MonedaEnum.default('ARS'),
  tc:                  z.coerce.number().positive().optional().nullable(),
  es_cuenta_corriente: z.boolean().default(false),
});

// Schema de un canje (equipo tomado en parte de pago).
//
// Junio 2026: ampliado para capturar TODOS los campos que necesita el producto
// al ingresar a Inventario (antes solo capturábamos descripcion + valor_toma →
// el producto quedaba con campos clave en NULL, no era usable hasta editarlo).
//
// 2026-07-11: se agregó `clase_id` (UUID, F3.a — categoría real por tenant).
// El operador puede elegir la categoría desde el select del canje (default:
// null → backend deriva 'celular_sellado'/'celular_usado' por condicion como
// hasta ahora, preservando compat). `categoria_id` (Colección legacy) sigue
// aceptado como opcional para no romper clientes viejos, pero el frontend ya
// no lo envía (Colección se sunseteó de la UI en PR #554).
const uuidLoose = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'clase_id inválido'
);

const canjeSchema = z.object({
  descripcion:    z.string().trim().min(1, 'Descripción del canje requerida').max(300),
  imei:           z.string().trim().max(50).optional().nullable(),
  gb:             z.string().trim().max(20).optional().nullable(),
  color:          z.string().trim().max(60).optional().nullable(),
  bateria:        z.coerce.number().int().min(0).max(100).optional().nullable(),
  valor_toma:     z.coerce.number().min(0).default(0),
  moneda:         MonedaEnum.default('USD'),
  agregar_stock:  z.boolean().default(false),
  // ─── Campos extra cuando agregar_stock=true ──────────────────────────────
  // Estos NO se persisten en la tabla `canjes` — solo viajan al INSERT
  // `productos` cuando se crea el item en Inventario. El backend los ignora
  // si agregar_stock=false (no rompe, solo se pierden).
  clase_id:              uuidLoose.optional().nullable(),
  categoria_id:          z.coerce.number().int().positive().optional().nullable(),
  condicion:             z.enum(['nuevo', 'usado']).optional().nullable(),
  precio_venta_sugerido: z.coerce.number().min(0).optional().nullable(),
  observaciones:         z.string().trim().max(1000).optional().nullable(),
  // 2026-07-11: `producto_id` opcional — cuando la venta se está editando
  // (PUT /ventas/:id) y el canje ya generó un producto en Inventario, el
  // frontend lo envía para que el backend NO cree un producto nuevo (que
  // fallaría con IMEI dup) sino que UPDATE el producto existente con los
  // campos editables (clase_id, condicion, precio_venta, observaciones).
  // Sin este flag el operador no podía cambiar la categoría del producto
  // desde el modal de la venta post-canje (bug reportado por Lucas).
  producto_id:           z.coerce.number().int().positive().optional().nullable(),
});

/* ── Venta ── */
// #475 — email del cliente final para enviar el comprobante por mail.
// Regex pragmático (no RFC 5322 full): `local@dominio.tld` con al menos un
// dot en el host. Detecta typos comunes ("juanperez@gmailcom") y evita el
// roundtrip a Resend con basura. Toda la validación dura la hace el provider;
// esto es UX-frontline + protección de costo (Resend cobra por intento).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clienteEmailSchema = z.string().trim().toLowerCase().regex(EMAIL_RE, 'Email inválido').max(254);

// 2026-07-13 (feature vuelto): 3 campos opcionales que van JUNTOS (todo o
// nada). El CHECK en DB también lo enforcea; validamos en schema para dar
// error 400 amigable en vez de 500 de constraint violation. La caja del
// vuelto es libre (cualquier moneda) — la validación de coherencia moneda
// vs caja se hace en el handler al postear el egreso a caja_movimientos.
//
// 2026-07-14 (bug reportado por Lucas): agregamos `vuelto_tc` opcional. Es
// REQUERIDO cuando `vuelto_moneda ∈ {ARS, UYU}` (necesario para convertir
// el vuelto a USD y restarlo de la ganancia). Si `vuelto_moneda` es USD/USDT,
// el TC no aplica (siempre 1) y el campo puede quedar null.
const vueltoFields = {
  vuelto_monto:   z.coerce.number().positive('El vuelto debe ser mayor a 0').optional().nullable(),
  vuelto_moneda:  MonedaEnum.optional().nullable(),
  vuelto_caja_id: z.coerce.number().int().positive().optional().nullable(),
  vuelto_tc:      z.coerce.number().positive('El TC del vuelto debe ser mayor a 0').optional().nullable(),
};
function refineVueltoTodoONada(d) {
  // Set de campos "core" (monto/moneda/caja) — el TC no cuenta para el todo-o-nada
  // porque puede ser null legítimamente cuando la moneda es USD/USDT.
  const set = [d.vuelto_monto, d.vuelto_moneda, d.vuelto_caja_id].filter(x => x != null).length;
  return set === 0 || set === 3;
}
const vueltoTodoONadaMsg = 'Vuelto: si cargás uno de los 3 campos (monto/moneda/caja), los 3 son obligatorios';

// 2026-07-14: si el vuelto es en moneda local (ARS/UYU), el TC es REQUERIDO
// para poder convertir a USD y restar de la ganancia. Sin TC, el backend no
// sabría cuánto vale realmente el vuelto en la moneda de referencia.
function refineVueltoTcRequerido(d) {
  if (d.vuelto_moneda === 'ARS' || d.vuelto_moneda === 'UYU') {
    return d.vuelto_tc != null && d.vuelto_tc > 0;
  }
  return true; // USD/USDT/NULL → TC no requerido
}
const vueltoTcRequeridoMsg = 'Vuelto: si la moneda es ARS o UYU, el TC del vuelto es obligatorio';

const createVentaSchema = z.object({
  fecha:          z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  hora:           z.string().regex(HORA_RE, 'Hora inválida').optional().nullable(),
  cliente_id:     z.coerce.number().int().positive().optional().nullable(),
  cliente_cc_id:  z.coerce.number().int().positive().optional().nullable(),
  cliente_nombre: z.string().trim().max(200).optional().nullable(),
  etiqueta_id:    z.coerce.number().int().positive().optional().nullable(),
  estado:         z.enum(['acreditado', 'pendiente', 'cancelado']).default('pendiente'),
  tc_venta:       z.coerce.number().positive().optional().nullable(),
  tc_compra:      z.coerce.number().positive().optional().nullable(),
  garantia_id:    z.coerce.number().int().positive().optional().nullable(),
  notas:          z.string().trim().max(1000).optional().nullable(),
  // #509 — override presentacional del "atendido por" del comprobante. Si no
  // se envía, el PDF cae al fallback de vendedor_id del primer item (comportamiento
  // legacy). Se puede editar post-emisión via PATCH /:id/vendedor-nombre.
  vendedor_nombre: z.string().trim().max(120).optional().nullable(),
  items:          z.array(ventaItemSchema).min(1, 'Agregá al menos un producto'),
  pagos:          z.array(ventaPagoSchema).default([]),
  canjes:         z.array(canjeSchema).default([]),
  // #475 — opt-in para enviar el comprobante PDF por email al cliente al
  // confirmar la venta. Si enviar_comprobante_email=true sin cliente_email,
  // el handler skipea el envío silenciosamente (no rompe la venta).
  enviar_comprobante_email: z.boolean().optional(),
  cliente_email:            clienteEmailSchema.optional().nullable(),
  ...vueltoFields,
}).strict()
  .refine(refineVueltoTodoONada, { message: vueltoTodoONadaMsg, path: ['vuelto_monto'] })
  .refine(refineVueltoTcRequerido, { message: vueltoTcRequeridoMsg, path: ['vuelto_tc'] });

// Edición de metadatos (no se editan items/pagos para no descuadrar el stock).
const updateVentaSchema = z.object({
  estado:         z.enum(['acreditado', 'pendiente', 'cancelado']).optional(),
  etiqueta_id:    z.coerce.number().int().positive().optional().nullable(),
  garantia_id:    z.coerce.number().int().positive().optional().nullable(),
  cliente_id:     z.coerce.number().int().positive().optional().nullable(),
  cliente_cc_id:  z.coerce.number().int().positive().optional().nullable(),
  cliente_nombre: z.string().trim().max(200).optional().nullable(),
  notas:          z.string().trim().max(1000).optional().nullable(),
  // #509 — permitir setear el override del "atendido por" en el PUT completo
  // (el modal Editar venta puede incluirlo). El PATCH focalizado
  // (/:id/vendedor-nombre) sigue siendo el canal preferido cuando lo único
  // que se está editando es esto.
  vendedor_nombre: z.string().trim().max(120).optional().nullable(),
  // Edición completa (opcional): si se envían items, se recalculan totales y stock.
  // `fecha` también se acepta porque el modal Editar venta del frontend siempre
  // re-envía la fecha original (no la cambia, pero la incluye en el payload).
  // Sin esto el `.strict()` rechaza el PUT con "Unrecognized key: fecha" y el
  // edit queda roto silenciosamente (descubierto vía E2E en flow 8).
  fecha:          z.string().date('Fecha inválida — usar YYYY-MM-DD').optional(),
  hora:           z.string().regex(HORA_RE, 'Hora inválida').optional().nullable(),
  tc_venta:       z.coerce.number().positive().optional().nullable(),
  items:          z.array(ventaItemSchema).min(1, 'Agregá al menos un producto').optional(),
  pagos:          z.array(ventaPagoSchema).optional(),
  canjes:         z.array(canjeSchema).optional(),
  // 2026-07-13 (feature vuelto): editables en el PUT. Para "quitar" el
  // vuelto de una venta que ya lo tenía, el frontend envía los 3 en null
  // (todo-o-nada aplica igual — 3 null o 3 con valor).
  ...vueltoFields,
}).strict()
  .refine(refineVueltoTodoONada, { message: vueltoTodoONadaMsg, path: ['vuelto_monto'] })
  .refine(refineVueltoTcRequerido, { message: vueltoTcRequeridoMsg, path: ['vuelto_tc'] });

/* ── Plantillas de garantía ── */
const garantiaSchema = z.object({
  nombre:     z.string().trim().min(1, 'Nombre requerido').max(80),
  texto:      z.string().trim().min(1, 'Texto requerido').max(4000),
  es_default: z.boolean().optional(),
});

const updateGarantiaSchema = z.object({
  nombre:     z.string().trim().min(1).max(80).optional(),
  texto:      z.string().trim().min(1).max(4000).optional(),
  es_default: z.boolean().optional(),
});

const queryVentasSchema = z.object({
  desde:       z.string().date().optional(),
  hasta:       z.string().date().optional(),
  estado:      z.enum(['acreditado', 'pendiente', 'cancelado']).optional(),
  etiqueta_id: z.coerce.number().int().positive().optional(),
  buscar:      z.string().trim().max(200).optional(),
  page:        z.coerce.number().int().positive().optional(),
  limit:       z.coerce.number().int().positive().max(200).optional(),
  // 2026-07-15 (task #134): filtro puntual por ID de venta. Cuando el usuario
  // llega desde Cmd+K con `?open=<id>`, el frontend hace fetch dirigido con
  // este filtro para conseguir la venta sin importar qué período/estado
  // tenía activo. El handler ignora desde/hasta cuando id está presente.
  id:          z.coerce.number().int().positive().optional(),
});

/* ── Comprobantes de venta ── */
// archivo_tipo se restringe a un enum acotado para evitar XSS al renderizar
// el comprobante en una ventana nueva (el visor inserta `data:<tipo>;base64,...`).
const comprobanteVentaSchema = z.object({
  archivo_data:   z.string().min(1, 'Archivo requerido').max(9_000_000, 'Archivo demasiado grande')
                   // base64, con prefijo data-URL opcional (el frontend lo manda via FileReader.readAsDataURL).
                   .regex(/^(data:[a-z0-9/+.-]+;base64,)?[A-Za-z0-9+/=\s]+$/i, 'Archivo inválido (debe ser base64)'),
  archivo_nombre: z.string().trim().max(255).optional().nullable(),
  archivo_tipo:   z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], {
                   error: 'Tipo de archivo no permitido (solo jpg/png/webp/pdf)'
                 }).optional().nullable(),
});

/* ── Etiquetas ── */
const etiquetaSchema = z.object({
  nombre: z.string().trim().min(1, 'Nombre requerido').max(80),
  color:  z.string().trim().max(20).optional().nullable(),
});

/* ── Egresos ── */
const createEgresoSchema = z.object({
  fecha:          z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  concepto:       z.string().trim().min(1, 'Concepto requerido').max(300),
  monto:          z.coerce.number().min(0).default(0),
  moneda:         MonedaEnum.default('USD'),
  tc:             z.coerce.number().positive().optional().nullable(),
  metodo_pago_id: z.coerce.number().int().positive().optional().nullable(),
  notas:          z.string().trim().max(500).optional().nullable(),
});

const queryEgresosSchema = z.object({
  desde: z.string().date().optional(),
  hasta: z.string().date().optional(),
  page:  z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const queryDashboardSchema = z.object({
  desde: z.string().date().optional(),
  hasta: z.string().date().optional(),
});

/* ── Ventas rápidas ── */
const createVentaRapidaSchema = z.object({
  vendedor_id:     z.coerce.number().int().positive().optional().nullable(),
  vendedor_nombre: z.string().trim().max(120).optional().nullable(),
  cliente_texto:   z.string().trim().max(200).optional().nullable(),
  detalle:         z.string().trim().min(1, 'Detalle requerido').max(2000),
  fecha:           z.string().date('Fecha inválida — usar YYYY-MM-DD'),
  hora:            z.string().regex(HORA_RE, 'Hora inválida').optional().nullable(),
});

const updateVentaRapidaSchema = z.object({
  detalle:         z.string().trim().min(1).max(2000).optional(),
  cliente_texto:   z.string().trim().max(200).optional().nullable(),
  vendedor_nombre: z.string().trim().max(120).optional().nullable(),
  estado:          z.enum(['pendiente', 'procesada']).optional(),
  venta_id:        z.coerce.number().int().positive().optional().nullable(),
});

// #475 — POST /api/ventas/:id/enviar-comprobante (envío manual / reenvío).
// El email se valida con la misma regex que cliente_email del create.
// force: opcional, ignorado por ahora (reservado para skips de checks futuros
// — ej. "mandar de nuevo aunque ya se envió hace <5min"). Aceptado para
// que el frontend no choque si lo pasa.
const enviarComprobanteSchema = z.object({
  email: clienteEmailSchema,
  force: z.boolean().optional(),
}).strict();

// 2026-07-04 (#509) — PATCH /api/ventas/:id/vendedor-nombre.
// Endpoint focalizado para editar SOLO el nombre del vendedor post-emisión
// (aparece en el comprobante impreso). No re-corre los sync de caja/CC/etc.
// del PUT completo — solo actualiza el campo + audit. null borra el vendedor.
const updateVendedorNombreSchema = z.object({
  vendedor_nombre: z.string().trim().max(120).nullable(),
}).strict();

module.exports = {
  createVentaSchema, updateVentaSchema, queryVentasSchema,
  etiquetaSchema,
  garantiaSchema, updateGarantiaSchema,
  comprobanteVentaSchema,
  createEgresoSchema, queryEgresosSchema, queryDashboardSchema,
  createVentaRapidaSchema, updateVentaRapidaSchema,
  // #475 — envío comprobante por email
  enviarComprobanteSchema,
  clienteEmailSchema,
  // #509 — edición focalizada del vendedor post-emisión
  updateVendedorNombreSchema,
};

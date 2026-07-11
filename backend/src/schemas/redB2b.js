/**
 * Schemas Zod para Red B2B (F1 — partnerships, F2 — productos pending review).
 *
 * .strict() en todos: rechaza campos extra para frenar typos en frontend
 * que silenciosamente no harían nada. Mismo patrón que el resto del portal.
 */

const { z } = require('zod');

// Slug regex idéntico al de tenants — ver schemas/superAdmin.js.
// Lowercase + dígitos + hyphens. No empieza ni termina con hyphen.
// 2-100 chars (matchea el formato que slugify() genera en signup/super-admin).
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

const inviteSchema = z.object({
  target_tenant_slug: z.string()
    .regex(SLUG_REGEX, 'slug inválido: lowercase, números, hyphens; 2-100 chars'),
  // Mensaje opcional para el invitador ("Hola TekHaus, somos iPro..."). Max
  // 500 chars — suficiente para presentación, no para spam de párrafos.
  message: z.string().trim().max(500).optional(),
}).strict();

const revokeSchema = z.object({
  // Reason opcional. Si se manda vacío explícito, lo dejamos como null en DB.
  reason: z.string().trim().max(500).optional(),
}).strict();

const rejectSchema = z.object({
  reason: z.string().trim().max(500).optional(),
}).strict();

// F2 (#455): merge-into de un producto pending review en uno existente del
// catálogo del buyer. target_producto_id debe ser un producto del propio
// tenant (validado inline en el handler). z.coerce.number() para tolerar
// IDs viniendo como strings desde el frontend.
const mergeIntoSchema = z.object({
  target_producto_id: z.coerce.number().int().positive(),
}).strict();

// F3 (#456): crear operación cross-tenant. items min 1 max 100 — uppercase
// es paranoico pero los partners realistas no van a mandar más de 100 items
// en una sola venta B2B (caso típico: 1-20 unidades).
//
// total_usd / total_ars son redundantes (el server recalcula como sanity
// check) — vienen del frontend que ya hizo la cuenta. El server tolera
// diferencia ±0.01 por rounding entre JS y SQL (sum de N items con 2 decimales).
//
// 2026-07-11 (auditoría Red B2B P1-1): `precio_usd` era `.nonnegative()` y
// aceptaba 0. Un item con precio 0 × cantidad N pasaba validación → el seller
// perdía N unidades de stock sin CC contrapartida por ese line item (la suma
// cero de total_usd seguía cuadrando si otros items compensaban, pero el
// desbalance por line item quedaba invisible). Ahora `.positive()` rechaza 0
// explícitamente. Si algún día hay ítems bonificación/muestra sin precio,
// que se modelen con un endpoint separado (no mezclando con la operación
// contable normal).
const createOperationSchema = z.object({
  partnership_id: z.coerce.number().int().positive(),
  items: z.array(z.object({
    producto_id: z.coerce.number().int().positive(),
    cantidad:    z.coerce.number().int().positive(),
    precio_usd:  z.coerce.number().positive(),
  })).min(1).max(100),
  tc:        z.coerce.number().positive(),
  notes:     z.string().trim().max(1000).optional(),
  total_usd: z.coerce.number().positive(),
  total_ars: z.coerce.number().positive(),
}).strict();

// F3: cancelación de operación cross-tenant. Solo el seller. reason opcional
// con tope 500 chars para evitar payload abuse.
const cancelOperationSchema = z.object({
  reason: z.string().trim().max(500).optional(),
}).strict();

// F3: PATCH de operación. F3 SOLO permite editar `notes` (decisión del doc
// sección 5.2 — items editable es F3.5). Si más adelante se agrega items
// edición, se hace por endpoint separado o extiende este schema.
const patchOperationSchema = z.object({
  notes: z.string().trim().max(1000),
}).strict();

// F4 (#457): registrar pago de operación cross-tenant con multi-divisa.
//
// Body completo del POST /api/red-b2b/operations/:id/pagos.
// monto_usd es el monto del pago expresado en USD (la moneda interna).
// Si moneda_pago=ARS|UYU, monto_pago debe coincidir aproximadamente con
// monto_usd * tc_pago (tolerancia 1 unidad de la moneda local, refine al final).
// side indica quién registra primero — el OTRO lado recibe propagado.
//
// 2026-06-29 Multi-país F2: moneda_pago acepta UYU (anchor del pago sigue
// siendo USD; UYU se valida análogo a ARS via tc_pago). USDT NO se acepta acá
// — Red B2B usa USDT como sinónimo de USD para el anchor pero el monto_pago
// concreto se asienta en USD/ARS/UYU. La validación país-aware (tenant AR
// rechaza UYU, tenant UY rechaza ARS) se hace en el handler vía
// `assertMonedaValidaParaPais`.
// Auditoría 2026-06-30 D-19: `tc_pago` se vuelve OPCIONAL cuando
// moneda_pago === 'USD'. Razón: en USD no hay conversión, así que el frontend
// no tiene un TC concreto que mandar — antes Zod rechazaba tc_pago undefined
// con `Required`, ahora se admite. La validación de coherencia inferior sigue
// asegurando que cuando moneda_pago !== 'USD', tc_pago sea positivo.
//
// El handler en pagos.js sustituye tc_pago por 1 cuando moneda_pago === 'USD'
// para satisfacer el NOT NULL de cross_tenant_pagos.tc_used (legacy column F1).
const registrarPagoSchema = z.object({
  monto_usd:   z.coerce.number().positive(),
  moneda_pago: z.enum(['USD', 'ARS', 'UYU']),
  monto_pago:  z.coerce.number().positive(),    // monto en la moneda_pago
  tc_pago:     z.coerce.number().positive().optional(),   // TC al momento del pago (opcional si moneda_pago=USD)
  caja_id:     z.coerce.number().int().positive(),
  side:        z.enum(['seller', 'buyer']),
  fecha:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notas:       z.string().trim().max(500).optional(),
}).strict()
  .refine(
    (d) => {
      // Auditoría 2026-06-30 D-19: tc_pago requerido solo cuando moneda_pago !== 'USD'.
      // En USD no se requiere TC porque no hay conversión.
      if (d.moneda_pago !== 'USD' && (d.tc_pago == null || d.tc_pago <= 0)) {
        return false;
      }
      return true;
    },
    {
      message: 'tc_pago requerido y positivo cuando moneda_pago es ARS o UYU',
      path: ['tc_pago'],
    }
  )
  .refine(
    (d) => {
      // Validación de coherencia monto_pago vs monto_usd * tc_pago.
      if (d.moneda_pago === 'USD') {
        // En USD el monto_pago debe ser igual a monto_usd (tolerancia 1 centavo).
        return Math.abs(d.monto_pago - d.monto_usd) < 0.01;
      }
      // ARS o UYU: monto_pago ≈ monto_usd * tc_pago.
      // Tolerancia 1 unidad de moneda local (ARS típico 1400/USD → 0.07%
      // tolerance; UYU típico 40/USD → 2.5% sobre 1 USD pero menos sobre
      // pagos grandes — aceptable porque el frontend calcula con la misma
      // fórmula y el TC es shared).
      const expected = d.monto_usd * d.tc_pago;
      return Math.abs(d.monto_pago - expected) < 1.0;
    },
    {
      message: 'monto_pago no coincide con monto_usd × tc_pago (tolerancia 1 unidad de moneda local / 0.01 USD)',
      path: ['monto_pago'],
    }
  );

// F4: configurar caja default cross-tenant del tenant.
// caja_id puede ser null (limpia la configuración).
const setCajaDefaultSchema = z.object({
  caja_id: z.coerce.number().int().positive().nullable(),
}).strict();

// F5 (#458): email prefs per-tenant — los 5 events críticos (decisión #13).
// Cada flag opcional — solo viajan los que el operador quiere cambiar (PATCH
// semánticamente: merge con el JSONB existente del tenant). Default true.
//
// `.strict()` rechaza flags desconocidos para frenar typos en frontend (sino
// el merge persistiría una key huerfana en el jsonb que nadie lee).
const setEmailPrefsSchema = z.object({
  invitation_received:  z.boolean().optional(),
  invitation_accepted:  z.boolean().optional(),
  operation_received:   z.boolean().optional(),
  operation_cancelled:  z.boolean().optional(),
  payment_received:     z.boolean().optional(),
}).strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: 'al menos un flag requerido',
  });

// F4: devolución cross-tenant (decisión #11).
// Solo el buyer puede iniciar — el endpoint enforcea.
// items: array de items a devolver con cantidad parcial.
const devolucionSchema = z.object({
  items: z.array(z.object({
    cross_tenant_operation_item_id: z.coerce.number().int().positive(),
    cantidad: z.coerce.number().int().positive(),
  })).min(1).max(100),
  motivo: z.string().trim().max(500).optional(),
}).strict();

module.exports = {
  inviteSchema,
  revokeSchema,
  rejectSchema,
  mergeIntoSchema,
  createOperationSchema,
  cancelOperationSchema,
  patchOperationSchema,
  // F4
  registrarPagoSchema,
  setCajaDefaultSchema,
  devolucionSchema,
  // F5
  setEmailPrefsSchema,
};

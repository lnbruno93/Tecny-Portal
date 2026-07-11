/**
 * Red B2B — pagos cross-tenant + devoluciones (F4 #457).
 *
 * Endpoints bajo /api/red-b2b/operations/:id (montado sobre el router de
 * operations, pero declarado en archivo separado por claridad). Se monta
 * en app.js como router hermano con paramedio el :id.
 *
 * Endpoints:
 *   POST  /:id/pagos       → registra un pago (multi-divisa, propagado al otro lado)
 *   GET   /:id/pagos       → lista los pagos de la operación + saldo
 *   POST  /:id/devolucion  → devolución cross-tenant (solo buyer — decisión #11)
 *
 * Multi-tenant + RLS:
 *   POST /pagos y POST /devolucion usan adminQuery (BYPASSRLS / tecny_admin)
 *   porque escriben en ambos tenants en la misma tx. SET LOCAL switching
 *   garantiza que los FORCE RLS WITH CHECK validen el tenant_id correcto.
 *   GET /pagos usa adminQuery también para leer la op + pagos (la op tiene
 *   RLS dual, pagos no tiene RLS propio — filtramos inline por op_id).
 *
 * Audit (con SAVEPOINT obligatorio post-F3):
 *   POST /pagos:       action='cross_tenant_pago_registered' del lado que registra.
 *   POST /devolucion:  action='cross_tenant_devolucion' del lado buyer (originador).
 *
 * Decisión #16 (multi-divisa): si moneda_pago !== USD, el helper
 * registerSellerCobro asienta la diferencia cambiaria como movimiento en
 * el módulo Cambios de Divisa del SELLER. El buyer no ve la diferencia
 * (su pago ya está al TC del día, sin re-cálculo).
 */

const router = require('express').Router({ mergeParams: true });
const db = require('../../config/database');
const logger = require('../../lib/logger');
const validate = require('../../lib/validate');
const parseId = require('../../lib/parseId');
const {
  registrarPagoSchema,
  devolucionSchema,
} = require('../../schemas/redB2b');
const {
  calcularDiferenciaCambiaria,
  resolveCajaParaTenant,
  registerSellerCobro,
  registerBuyerPago,
  calcularSaldoOperacion,
  ensureSellerClienteCc,
  ensureBuyerProveedor,
} = require('../../lib/crossTenantPagos');
const { round2, assertMonedaValidaParaPais } = require('../../lib/money');
const { invalidateMetricas } = require('../../lib/inventarioCache');
// PR-D #463: conciliation no tiene cache (multi-instance bug + frecuencia
// baja). Antes invalidábamos via invalidateConciliationCache(partnershipId).
// 2026-06-29 #458 F5: dispatch fire-and-forget de emails Red B2B.
const redB2bEmail = require('../../lib/redB2bEmail');

// ──────────────────────────────────────────────────────────────────────────
// Helpers: notify + audit (replicados del pattern operations.js — SAVEPOINT
// obligatorio en audit por bug histórico F3).
// ──────────────────────────────────────────────────────────────────────────
async function notify(client, tenantId, type, payload, opts = {}) {
  await client.query(`SET LOCAL app.current_tenant = ${Number(tenantId)}`);
  await client.query(
    `INSERT INTO cross_tenant_notifications
       (tenant_id, partnership_id, cross_tenant_operation_id, type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      tenantId,
      opts.partnershipId || null,
      opts.operationId || null,
      type,
      JSON.stringify(payload),
    ]
  );
}

// Auditoría 2026-06-30 D-22: pasamos `actor_type='tenant_user'` explícito en
// los INSERTs de Red B2B. La columna se agrega en migration
// 20260701000002_tenant_admin_actions_actor_type. Si la migration no corrió
// (DB vieja), el INSERT con la columna falla con 42703 (undefined_column) —
// el SAVEPOINT lo atrapa exactamente igual que 23514 (CHECK violation): perdemos
// el audit, no rompemos el flow. La detección dispara warn en logs para
// alertar de migration pendiente.
async function audit(client, { tenantId, userId, action, payload }) {
  await client.query('SAVEPOINT sp_audit');
  try {
    await client.query(
      `INSERT INTO tenant_admin_actions
         (tenant_id, super_admin_user_id, actor_type, action, before_state, after_state, reason)
       VALUES ($1, $2, 'tenant_user', $3, NULL, $4::jsonb, NULL)`,
      [tenantId, userId, action, JSON.stringify(payload || {})]
    );
    await client.query('RELEASE SAVEPOINT sp_audit');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT sp_audit').catch(() => {});
    if (err.code === '23514') {
      logger.warn({ action, err: err.message }, '[red-b2b/F4] audit action no permitida — migration pendiente?');
      return;
    }
    if (err.code === '42703') {
      logger.warn({ action, err: err.message }, '[red-b2b/F4] audit columna actor_type ausente — migration 20260701000002 pendiente?');
      return;
    }
    throw err;
  }
}

function tenantSnapshot(row) {
  if (!row) return null;
  return { id: row.id, nombre: row.nombre, slug: row.slug, plan: row.plan };
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/operations/:id/pagos
//
// EL CORE de F4. Flow:
//   A. Lookup op + verificar status='active' (no cancelled/frozen)
//   B. Verificar caller participa (seller o buyer) — si side body !== inferido → 403
//   C. Validar saldo: monto_usd <= saldo restante (sobre-pago rechazado)
//   D. Calcular diferencia cambiaria (helper puro)
//   E. SET LOCAL al lado QUE REGISTRA → INSERT mov tipo='pago' + (si seller
//      y moneda_pago=ARS) INSERT cambio_movimientos con diff cambiaria
//   F. SET LOCAL al OTRO lado → INSERT mov tipo='pago' propagado, en caja
//      default cross-tenant del otro lado
//   G. INSERT cross_tenant_pagos con snapshots completos
//   H. Notif al otro lado: type='payment_received' o 'payment_registered'
//   I. Audit del lado que registra (con SAVEPOINT)
//   J. COMMIT + invalidar caches
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/pagos', validate(registrarPagoSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const opId = parseId(req.params.id);
  if (!opId) return res.status(400).json({ error: 'id inválido' });

  const body = req.body;
  // Multi-país F2: rechazar moneda_pago no habilitada para el país del tenant
  // que registra el pago. El otro lado de la operación cross-tenant puede ser
  // de otro país; la validación acá protege solo el lado caller. La compat
  // ULTRA caja_default ↔ moneda_pago vive más abajo (ya considera UYU vía
  // schema update — F5 finaliza el matching seller-side cross-frontera).
  try {
    assertMonedaValidaParaPais(body.moneda_pago, req.tenantPais, 'moneda_pago');
  } catch (err) {
    return next(err);
  }

  const fecha = body.fecha || new Date().toISOString().slice(0, 10);

  // COR-1 audit 2026-07-06: Idempotency-Key opcional.
  // El frontend genera un UUID al abrir el modal y lo manda en cada intento.
  // Doble-click / retry por 502 / dos pestañas mandan el MISMO UUID → el
  // 1er intento crea el pago con client_generated_id=UUID. Los siguientes
  // encuentran el pago existente y devuelven un 200 con la MISMA data (sin
  // ejecutar side effects otra vez). Sin header, comportamiento igual al
  // anterior (permite duplicados intencionales — ej. pagar 100 USD dos veces).
  //
  // UUID validado por parse — si viene malformado, respondemos 400 y evitamos
  // que un typo del cliente termine bypaseando la idempotency. Uso `uuid` nativo
  // (crypto.randomUUID hace lo mismo del lado del cliente); acá solo validamos.
  const idempotencyKeyRaw = req.get('Idempotency-Key') || null;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (idempotencyKeyRaw && !UUID_RE.test(idempotencyKeyRaw)) {
    return res.status(400).json({
      error: 'Idempotency-Key debe ser UUID v1-8 (RFC 9562)',
      reason: 'idempotency_key_invalid',
    });
  }
  const idempotencyKey = idempotencyKeyRaw ? idempotencyKeyRaw.toLowerCase() : null;

  try {
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // A. Lookup operación (con BYPASSRLS — necesitamos ver ambos lados).
        const opQ = await client.query(
          `SELECT * FROM cross_tenant_operations
             WHERE id = $1
               AND (seller_tenant_id = $2 OR buyer_tenant_id = $2)
             FOR UPDATE`,
          [opId, myTenantId]
        );
        const op = opQ.rows[0];
        if (!op) {
          await client.query('ROLLBACK');
          return { error: 'not_found', status: 404 };
        }

        // A.1 IDEMPOTENCY (audit 2026-07-06 COR-1): si el caller mandó
        // Idempotency-Key y ya existe un pago con esa key para esta op, es un
        // retry — devolvemos el pago original SIN reejecutar el flow.
        //
        // El FOR UPDATE arriba serializa las txs concurrentes: si la 1ra aún
        // no committeó, la 2da espera. Cuando la 1ra committea, la 2da toma
        // el lock, hace este SELECT y encuentra el pago → early-return.
        //
        // Race window residual: 2 requests entran a la 1ra tx en paralelo,
        // ambos hacen el SELECT y ambos no encuentran nada → ambos intentan
        // INSERT. El UNIQUE index parcial `idx_ct_pagos_idempotency` atrapa
        // al 2do en el commit (SQLSTATE 23505) → catch de más abajo detecta
        // y devuelve 409 idempotency_conflict (cliente puede retryar y esta
        // vez encontrará el registro).
        if (idempotencyKey) {
          const dup = await client.query(
            `SELECT id, registered_at, monto_usd, monto_ars, moneda_pago, tc_pago
               FROM cross_tenant_pagos
               WHERE cross_tenant_operation_id = $1
                 AND client_generated_id = $2
               LIMIT 1`,
            [opId, idempotencyKey]
          );
          if (dup.rows[0]) {
            await client.query('ROLLBACK');
            // 2026-07-11 (auditoría Red B2B P2-3): incluimos `op_status_now`
            // para que el frontend pueda detectar cambios de estado post-hoc.
            // Escenario: 1ra request crea el pago OK. Cliente pierde el response
            // por 502. Alguien cancela la op. Cliente retry con misma key →
            // replay devuelve 200 con el pago original PERO también reporta que
            // op.status ahora es 'cancelled'. El pago sigue siendo válido (fue
            // registrado antes de la cancelación) pero el frontend puede mostrar
            // un warning "el pago se registró pero la op fue cancelada después".
            // NO cambiamos el status HTTP (200 sigue OK — el pago se persistió).
            return {
              idempotent_replay: true,
              existing_pago: dup.rows[0],
              op_status_now: op.status,
              // Metadata que el response wrapper necesita para el email/notif
              // path — pero como es replay NO emitimos email de nuevo.
            };
          }
        }
        if (op.status === 'cancelled') {
          await client.query('ROLLBACK');
          return { error: 'op_cancelled', status: 409 };
        }
        if (op.status === 'frozen') {
          await client.query('ROLLBACK');
          return { error: 'op_frozen', status: 409 };
        }

        // B. Verificar partnership activa (defense in depth — si la
        // partnership se revocó después de crear la op, F1 dejó las ops
        // existentes vivas para que el pago se pueda completar — sec 6.6).
        // Acá NO bloqueamos por partnership_not_active porque permitimos
        // pagar ops pre-revoke (decisión doc 6.6.D). Solo bloqueamos op
        // cancelled/frozen arriba.

        // C. Determinar quién es el seller y el buyer.
        const callerIsSeller = op.seller_tenant_id === myTenantId;
        const sellerTenantId = op.seller_tenant_id;
        const buyerTenantId  = op.buyer_tenant_id;

        // El side del body debe coincidir con lo inferido del caller.
        const callerSide = callerIsSeller ? 'seller' : 'buyer';
        if (body.side !== callerSide) {
          await client.query('ROLLBACK');
          return { error: 'side_mismatch', status: 403,
            details: { caller_side: callerSide, body_side: body.side } };
        }

        // D. Lookup ambos tenants (para nombres + caja default).
        const tenantsQ = await client.query(
          `SELECT id, nombre, slug, plan, red_b2b_caja_default_id
             FROM tenants WHERE id = ANY($1::int[])`,
          [[sellerTenantId, buyerTenantId]]
        );
        const tenantsById = new Map(tenantsQ.rows.map((r) => [r.id, r]));
        const sellerTenant = tenantsById.get(sellerTenantId);
        const buyerTenant  = tenantsById.get(buyerTenantId);

        // E. Calcular saldo restante de la op.
        const saldo = await calcularSaldoOperacion(client, opId);
        const monto_usd = round2(Number(body.monto_usd));
        // Tolerancia 1 centavo para floating point.
        if (monto_usd > saldo.restante_usd + 0.01) {
          await client.query('ROLLBACK');
          return {
            error: 'overpayment', status: 400,
            details: {
              restante_usd: saldo.restante_usd,
              pagado_acumulado_usd: saldo.pagado_usd,
              total_usd: saldo.total_usd,
              intento_usd: monto_usd,
            },
          };
        }

        // F. Calcular diferencia cambiaria (snapshot tc_venta = op.tc_used).
        //
        // PR-B Bug B2 (drift contable):
        // Cuando moneda_pago === 'ARS', el body.monto_pago puede diferir de
        // monto_usd × tc_pago dentro de la tolerancia de 1 ARS del refine.
        // El operador asienta lo que efectivamente entró a caja (monto_pago),
        // no la multiplicación recomputada. Persistimos `monto_pago` declarado
        // y recalculamos `diferencia_cambiaria_ars` contra `monto_usd × tc_venta`
        // — ese es el ARS "esperado al momento de vender". La diferencia incluye
        // tanto el delta de TC como cualquier drift de redondeo dentro de la
        // tolerancia, pero el saldo CC del cliente queda exacto.
        //
        // Auditoría 2026-06-30 D-19: `tc_pago` puede venir undefined cuando
        // moneda_pago === 'USD' (schema lo hizo opcional). Si el frontend lo
        // manda explícito (caso legacy), respetamos el valor; si no, defaultamos
        // a 1.0 — neutro para diferencia cambiaria (no aplica en USD) y
        // satisface el NOT NULL de cross_tenant_pagos.tc_used (legacy F1 column
        // que persistimos como snapshot del tc del pago).
        //
        // Compat: tests existentes pasan tc_pago: 1000 con moneda='USD' — la
        // rama `body.tc_pago != null` preserva ese valor. La rama `=== null/undefined`
        // usa 1.0. Para moneda ARS/UYU, el schema refine ya garantizó
        // tc_pago > 0 (no entra al fallback).
        const tc_venta = Number(op.tc_used);
        const tc_pago = body.moneda_pago === 'USD'
          ? (body.tc_pago != null ? Number(body.tc_pago) : 1)
          : Number(body.tc_pago);
        // BLOCKER 2026-07-05 (multi-país UYU): antes solo ARS persistía el
        // monto_pago declarado; UYU caía al `round2(monto_usd)` (el USD
        // canónico) y se guardaba un monto en USD como si fuera UYU. Ahora
        // ARS y UYU (fiats locales con TC) persisten lo que efectivamente
        // entró a caja; USD/USDT persisten el USD canónico.
        const esFiatLocal = body.moneda_pago === 'ARS' || body.moneda_pago === 'UYU';
        const monto_pago_persist = esFiatLocal
          ? round2(Number(body.monto_pago))
          : round2(monto_usd);

        // BLOCKER 2026-07-05: la variable se llama `diferencia_ars` por
        // retro-compat con la columna DB `cross_tenant_pagos.diferencia_cambiaria_ars`
        // (schema legacy F1). El VALOR ahora está en la moneda del pago:
        // ARS si moneda_pago='ARS', UYU si moneda_pago='UYU'. El nombre de
        // la columna miente, pero cambiarlo requiere una migration y análisis
        // de reportes existentes — se difiere a un PR aparte.
        let diferencia_ars;
        if (body.moneda_pago === 'USD' || body.moneda_pago === 'USDT') {
          diferencia_ars = 0;
        } else if (tc_venta > 0) {
          // Diferencia = fiat local realmente recibido − fiat esperado por TC de venta.
          // Si tc_pago > tc_venta o monto_pago > monto_usd × tc_venta → ganancia.
          diferencia_ars = round2(monto_pago_persist - (monto_usd * tc_venta));
        } else {
          // Fallback al helper puro (tc_venta inválido — sin diff calculable).
          const r = calcularDiferenciaCambiaria(monto_usd, tc_venta, tc_pago, body.moneda_pago);
          diferencia_ars = r.diferencia_local;
        }

        // G. Lookup caja del propio tenant (validar que existe + moneda
        // compatible con el moneda_pago).
        //
        // BLOCKER 2026-07-06 SEG-1: bajo `adminQuery` (BYPASSRLS), este SELECT
        // no filtra por tenant_id → un operador podía pasar la caja_id de
        // OTRO tenant y persistirla en `movimientos_cc.caja_id` /
        // `cross_tenant_pagos.caja_seller_id` del suyo, corrompiendo reportes
        // de caja y potencial leak de metadata. `metodos_pago` es tenant-scoped
        // desde 20260615000002 (RLS) + 20260616000005/06 (índices per-tenant)
        // — el comentario histórico que decía "catálogo global" era falso.
        // Fix: filtro explícito `AND tenant_id = $2` con myTenantId como
        // ground truth (viene de req.tenantId, no del body).
        const callerCajaQ = await client.query(
          `SELECT id, moneda, nombre FROM metodos_pago
             WHERE id = $1 AND tenant_id = $2 AND activo = true AND deleted_at IS NULL`,
          [body.caja_id, myTenantId]
        );
        const callerCaja = callerCajaQ.rows[0];
        if (!callerCaja) {
          await client.query('ROLLBACK');
          return { error: 'caja_not_found', status: 404, details: { caja_id: body.caja_id } };
        }
        // Compat moneda: ARS↔ARS, UYU↔UYU, USD/USDT↔USD/USDT.
        // BLOCKER 2026-07-05 (multi-país UYU): antes el `else` de "no-ARS"
        // aceptaba caja USD/USDT para pagos UYU — un cobro en pesos uruguayos
        // podía terminar registrado en caja dólares. Ahora UYU exige caja UYU.
        let cajaCompat;
        if (body.moneda_pago === 'ARS')      cajaCompat = callerCaja.moneda === 'ARS';
        else if (body.moneda_pago === 'UYU') cajaCompat = callerCaja.moneda === 'UYU';
        else /* USD | USDT */                 cajaCompat = callerCaja.moneda === 'USD' || callerCaja.moneda === 'USDT';
        if (!cajaCompat) {
          await client.query('ROLLBACK');
          return {
            error: 'caja_moneda_incompatible', status: 400,
            details: { caja_moneda: callerCaja.moneda, moneda_pago: body.moneda_pago },
          };
        }

        // ── PR-B Bug B1: resolver AMBAS cajas UNA SOLA VEZ ──────────────────
        // Antes había hasta TRES resolveCajaParaTenant: uno acá (propagación)
        // + dos inline en el INSERT cross_tenant_pagos (líneas 354-355). Cada
        // call podía devolver NULL si la caja default fue desactivada entre
        // llamadas, persistiendo NULL en caja_seller_id/caja_buyer_id (NOT
        // NULL en schema F1) → INSERT fallaba y revertía toda la tx.
        //
        // Fix: resolver ambas cajas acá, ANTES del bloque registrar+propagar,
        // bajo SET LOCAL del tenant correcto para cada una. Validar de una vez
        // y usar las variables resueltas en TODO el flujo posterior.
        let sellerCajaPersistId, buyerCajaPersistId;
        if (callerIsSeller) {
          // Caller es seller → su caja_id va al lado seller.
          sellerCajaPersistId = body.caja_id;
          await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
          buyerCajaPersistId = await resolveCajaParaTenant(
            client, buyerTenantId, body.moneda_pago, buyerTenant.red_b2b_caja_default_id
          );
          if (!buyerCajaPersistId) {
            await client.query('ROLLBACK');
            return {
              error: 'buyer_no_caja_compatible', status: 409,
              details: { buyer_tenant_id: buyerTenantId, moneda_pago: body.moneda_pago },
            };
          }
        } else {
          // Caller es buyer → su caja_id va al lado buyer.
          buyerCajaPersistId = body.caja_id;
          await client.query(`SET LOCAL app.current_tenant = ${Number(sellerTenantId)}`);
          sellerCajaPersistId = await resolveCajaParaTenant(
            client, sellerTenantId, body.moneda_pago, sellerTenant.red_b2b_caja_default_id
          );
          if (!sellerCajaPersistId) {
            await client.query('ROLLBACK');
            return {
              error: 'seller_no_caja_compatible', status: 409,
              details: { seller_tenant_id: sellerTenantId, moneda_pago: body.moneda_pago },
            };
          }
        }

        // ── REGISTRAR LADO QUE LLAMA ─────────────────────────────────────
        let sellerResult, buyerResult;
        if (callerIsSeller) {
          // El caller es el seller — registra cobro propio + diferencia cambiaria.
          await client.query(`SET LOCAL app.current_tenant = ${Number(sellerTenantId)}`);
          sellerResult = await registerSellerCobro(client, sellerTenantId, {
            opId,
            buyerTenant,
            monto_usd,
            moneda_pago: body.moneda_pago,
            monto_pago: monto_pago_persist,   // B2: usar valor persistido
            tc_pago,
            tc_venta,
            caja_id: sellerCajaPersistId,
            fecha,
            callerUserId: userId,
            diferencia_cambiaria_ars: diferencia_ars,
            notas: body.notas,
          });
        } else {
          // El caller es el buyer — registra pago propio (sin diff cambiaria).
          await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
          buyerResult = await registerBuyerPago(client, buyerTenantId, {
            opId,
            sellerTenant,
            monto_usd,
            moneda_pago: body.moneda_pago,
            monto_pago: monto_pago_persist,   // B2: usar valor persistido
            tc_pago,
            caja_id: buyerCajaPersistId,
            fecha,
            callerUserId: userId,
            notas: body.notas,
          });
        }

        // ── PROPAGAR AL OTRO LADO ─────────────────────────────────────────
        // Las cajas ya están resueltas (B1). Solo necesitamos cambiar el SET
        // LOCAL al tenant del otro lado y registrar.
        //
        // 2026-07-11 (auditoría Red B2B P1-4): agregado `notas: body.notas` en
        // los 2 calls de propagación. El bug era que el registro del lado que
        // LLAMA (bloque de arriba) SÍ pasaba notas → registerSellerCobro /
        // registerBuyerPago, pero acá abajo (propagación) los args no incluían
        // notas y el receptor veía `notas = null` en su lado. Resultado: audit
        // inconsistente cross-tenant y UX confusa ("¿por qué mi partner no ve
        // lo que le anoté?"). Ahora ambos lados registran la misma nota.
        if (callerIsSeller) {
          // Propagar al BUYER.
          await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
          buyerResult = await registerBuyerPago(client, buyerTenantId, {
            opId,
            sellerTenant,
            monto_usd,
            moneda_pago: body.moneda_pago,
            monto_pago: monto_pago_persist,   // B2: usar valor persistido
            tc_pago,
            caja_id: buyerCajaPersistId,
            fecha,
            callerUserId: userId,
            notas: body.notas,
          });
        } else {
          // Propagar al SELLER: necesita caja + diferencia cambiaria.
          await client.query(`SET LOCAL app.current_tenant = ${Number(sellerTenantId)}`);
          sellerResult = await registerSellerCobro(client, sellerTenantId, {
            opId,
            buyerTenant,
            monto_usd,
            moneda_pago: body.moneda_pago,
            monto_pago: monto_pago_persist,   // B2: usar valor persistido
            tc_pago,
            tc_venta,
            caja_id: sellerCajaPersistId,
            fecha,
            callerUserId: userId,
            diferencia_cambiaria_ars: diferencia_ars,
            notas: body.notas,
          });
        }

        // ── INSERT cross_tenant_pagos maestro ─────────────────────────────
        // No tiene RLS propio. Llenar TODOS los snapshots.
        //
        // PR-B Bug B2: `monto_ars` persiste el monto_pago declarado por el
        // operador cuando moneda_pago === 'ARS' (la fuente de verdad es lo
        // que entró a caja, no la multiplicación recomputada). Cuando es USD,
        // mantenemos monto_usd × tc_pago para no romper retro-compat de
        // reportes que asumen monto_ars siempre poblado.
        //
        // PR-B Bug B1: caja_seller_id / caja_buyer_id usan las variables ya
        // resueltas arriba (no más resolveCajaParaTenant inline que podía
        // devolver NULL y romper la tx por NOT NULL constraint).
        //
        // BLOCKER 2026-07-05 (multi-país UYU): la columna `monto_ars` es
        // legacy F1 y el nombre miente cuando moneda_pago='UYU'. Para pagos
        // UYU persistimos el `monto_pago_persist` (que ya viene en UYU) —
        // así queda "monto en moneda local", coherente con `diferencia_cambiaria_ars`
        // que también aloja el valor UYU (ver más arriba). Reportes viejos
        // que asumen ARS literal en esta columna deben leer también
        // `moneda_pago` para desambiguar.
        let monto_ars_persist;
        if (body.moneda_pago === 'ARS' || body.moneda_pago === 'UYU') {
          monto_ars_persist = monto_pago_persist;
        } else {
          monto_ars_persist = round2(monto_usd * tc_pago);
        }

        let cpQ;
        try {
          cpQ = await client.query(
            `INSERT INTO cross_tenant_pagos
               (cross_tenant_operation_id,
                seller_cobro_id, buyer_pago_id,
                monto_usd, monto_ars, tc_used,
                caja_seller_id, caja_buyer_id,
                registered_by_side, registered_by_user_id, registered_at,
                moneda_pago, tc_venta, tc_pago,
                diferencia_cambiaria_ars, cambio_divisa_id,
                propagated_at, client_generated_id)
             VALUES ($1,
                     $2, $3,
                     $4, $5, $6,
                     $7, $8,
                     $9, $10, NOW(),
                     $11, $12, $13,
                     $14, $15,
                     NOW(), $16)
             RETURNING id, registered_at`,
            [
              opId,
              sellerResult.movimiento_id,
              buyerResult.movimiento_id,
              monto_usd,
              monto_ars_persist,
              // tc_used: F1 legacy column — guardamos tc_pago para retrocompat
              tc_pago,
              sellerCajaPersistId,
              buyerCajaPersistId,
              callerSide,
              userId,
              body.moneda_pago,
              tc_venta,
              tc_pago,
              round2(diferencia_ars),
              sellerResult.cambio_divisa_id || null,
              idempotencyKey,
            ]
          );
        } catch (err) {
          // COR-1: race del index parcial `idx_ct_pagos_idempotency`.
          // El SELECT del early-check no encontró duplicado, pero entre ese
          // SELECT y este INSERT otro request con la misma key ganó. El
          // UNIQUE viola con SQLSTATE 23505. Devolvemos 409 estable para que
          // el cliente retryee — el próximo intento encontrará el pago
          // via el early-check.
          if (idempotencyKey && err.code === '23505' &&
              err.constraint === 'idx_ct_pagos_idempotency') {
            await client.query('ROLLBACK');
            return { error: 'idempotency_conflict', status: 409 };
          }
          throw err;
        }
        const crossPago = cpQ.rows[0];

        // ── NOTIF al otro lado ────────────────────────────────────────────
        // Tipo según quien registró:
        // - seller registró → buyer recibe 'payment_received'
        // - buyer registró → seller recibe 'payment_registered'
        const otherTenantId = callerIsSeller ? buyerTenantId : sellerTenantId;
        const fromTenant = callerIsSeller ? sellerTenant : buyerTenant;
        const notifType = callerIsSeller ? 'payment_received' : 'payment_registered';
        await notify(client, otherTenantId, notifType, {
          partner: tenantSnapshot(fromTenant),
          operation_id: opId,
          pago_id: crossPago.id,
          monto_usd,
          moneda_pago: body.moneda_pago,
          monto_pago: monto_pago_persist,
          tc_pago,
          from_user_id: userId,
          from_username: req.user.username,
        }, { partnershipId: op.partnership_id, operationId: opId });

        // ── (Opcional) UPDATE op.status='completed' si pago completa saldo ─
        // DECISIÓN F4: NO cambiamos status — quedamos en 'active' con saldo 0.
        // Razones:
        //  1. El CHECK constraint actual de status no incluye 'completed'.
        //  2. Cambiar a status diferente complica el flow de cancel/devolución.
        //  3. La conciliación se calcula via saldo_restante, no por status.
        // Si en el futuro Lucas quiere distinguir "completed" visual, se
        // puede agregar un campo derivado `is_fully_paid` o vista compuesta.

        // ── AUDIT del lado que registra ───────────────────────────────────
        await client.query(`SET LOCAL app.current_tenant = ${Number(myTenantId)}`);
        await audit(client, {
          tenantId: myTenantId,
          userId,
          action: 'cross_tenant_pago_registered',
          payload: {
            operation_id: opId,
            pago_id: crossPago.id,
            monto_usd,
            moneda_pago: body.moneda_pago,
            tc_pago,
            diferencia_cambiaria_ars: round2(diferencia_ars),
            side: callerSide,
          },
        });

        await client.query('COMMIT');
        return {
          ok: true,
          pagoId: crossPago.id,
          opId,
          callerSide,
          sellerTenantId,
          buyerTenantId,
          partnershipId: op.partnership_id,
          monto_usd,
          diferencia_ars,
          cambio_divisa_id: sellerResult?.cambio_divisa_id || null,
          // F5 #458: nombres de ambos lados para el email post-commit.
          sellerNombre: sellerTenant?.nombre || null,
          buyerNombre:  buyerTenant?.nombre || null,
        };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });

    if (result.error) {
      return res.status(result.status).json({
        error: errorMessage(result.error),
        reason: result.error,
        ...(result.details ? { details: result.details } : {}),
      });
    }

    // COR-1 audit 2026-07-06: Idempotency-Key replay.
    // El caller mandó una key ya vista → devolvemos 200 con el pago original.
    // NO emitimos email/notif/cache-invalidation ni corremos audit — todo
    // eso ya se ejecutó en la 1ra request y volver a hacerlo confundiría
    // al usuario ("¿cobré 2 veces? Me llegaron 2 emails").
    if (result.idempotent_replay) {
      const p = result.existing_pago;
      return res.status(200).json({
        pago: {
          id: p.id,
          registered_at: p.registered_at,
          monto_usd: Number(p.monto_usd),
          monto_ars: Number(p.monto_ars),
          moneda_pago: p.moneda_pago,
          tc_pago: Number(p.tc_pago),
        },
        idempotent_replay: true,
        // P2-3: estado actual de la op para que el frontend detecte cambios
        // post-registro (ej: op cancelada entre 1ra request y replay).
        op_status_now: result.op_status_now,
      });
    }

    // PR-D #463: conciliation ya no tiene cache (decisión Lucas — multi-instance bug
    // + frecuencia baja de hit). El próximo GET conciliation recomputa fresh.

    // F5 #458: email al lado opuesto del que registró (gated por payment_received).
    //
    // Semántica del template `payment_received`:
    //   - Si el SELLER registró el cobro → buyer recibe email "Pagaste"
    //     (su CC del proveedor bajó). iWasPaid=false desde la perspectiva del receptor.
    //   - Si el BUYER registró el pago → seller recibe email "Te pagaron"
    //     (su CC del cliente bajó / su caja subió). iWasPaid=true.
    // El destinatario es el OTRO tenant en cualquier caso.
    const isCallerSeller = result.callerSide === 'seller';
    const otherTenantId  = isCallerSeller ? result.buyerTenantId : result.sellerTenantId;
    const partnerNombre  = isCallerSeller
      ? (result.sellerNombre || `Tenant #${result.sellerTenantId}`)  // el seller le pagó al buyer
      : (result.buyerNombre  || `Tenant #${result.buyerTenantId}`);  // el buyer le pagó al seller
    const iWasPaid = !isCallerSeller; // si caller es buyer, el OTHER (seller) "fue pagado"
    setImmediate(() => {
      redB2bEmail.dispatch({
        tenantId: otherTenantId,
        type:     'payment_received',
        args: {
          partnerNombre,
          montoUsd:    result.monto_usd,
          monedaPago:  body.moneda_pago,
          operationId: result.opId,
          iWasPaid,
        },
      }).catch(() => {});
    });

    logger.info({
      operation_id: result.opId,
      pago_id: result.pagoId,
      side: result.callerSide,
      tenant_id: myTenantId,
      user_id: userId,
      monto_usd: result.monto_usd,
      diferencia_ars: result.diferencia_ars,
    }, '[red-b2b/F4] pago cross-tenant registrado');

    return res.status(201).json({
      pago: {
        id: result.pagoId,
        operation_id: result.opId,
        monto_usd: result.monto_usd,
        diferencia_cambiaria_ars: round2(result.diferencia_ars),
        cambio_divisa_id: result.cambio_divisa_id,
        side: result.callerSide,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/operations/:id/pagos
//
// Lista los pagos de una operación + saldo restante.
// ──────────────────────────────────────────────────────────────────────────
router.get('/:id/pagos', async (req, res, next) => {
  const myTenantId = req.tenantId;
  const opId = parseId(req.params.id);
  if (!opId) return res.status(400).json({ error: 'id inválido' });

  try {
    const data = await db.adminQuery(async (client) => {
      // Lookup op para validar que el caller participa (RLS dual + filtro inline).
      const opQ = await client.query(
        `SELECT id, seller_tenant_id, buyer_tenant_id, total_usd, status
           FROM cross_tenant_operations
           WHERE id = $1
             AND (seller_tenant_id = $2 OR buyer_tenant_id = $2)`,
        [opId, myTenantId]
      );
      const op = opQ.rows[0];
      if (!op) return { notFound: true };

      // Lookup pagos + usernames (ordenados ascendente para tracking secuencial).
      const pagosQ = await client.query(
        `SELECT p.id, p.monto_usd, p.monto_ars, p.tc_used,
                p.moneda_pago, p.tc_venta, p.tc_pago,
                p.diferencia_cambiaria_ars, p.cambio_divisa_id,
                p.caja_seller_id, p.caja_buyer_id,
                p.registered_by_side, p.registered_by_user_id,
                p.registered_at, p.propagated_at,
                p.seller_cobro_id, p.buyer_pago_id,
                u.username AS registered_by_username
           FROM cross_tenant_pagos p
           LEFT JOIN users u ON u.id = p.registered_by_user_id
           WHERE p.cross_tenant_operation_id = $1
           ORDER BY p.registered_at ASC, p.id ASC`,
        [opId]
      );

      const saldo = await calcularSaldoOperacion(client, opId);
      return { op, pagos: pagosQ.rows, saldo };
    });

    if (data.notFound) {
      return res.status(404).json({ error: 'Operación no encontrada', reason: 'not_found' });
    }

    // Acumular pagado para mostrar pagado_acumulado_usd row-by-row.
    let acumulado = 0;
    const pagos = data.pagos.map((p) => {
      acumulado = round2(acumulado + Number(p.monto_usd));
      return {
        id: p.id,
        monto_usd: Number(p.monto_usd),
        moneda_pago: p.moneda_pago || 'USD',
        monto_pago: p.moneda_pago === 'ARS' ? Number(p.monto_ars) : Number(p.monto_usd),
        tc_pago: p.tc_pago != null ? Number(p.tc_pago) : Number(p.tc_used),
        tc_venta: p.tc_venta != null ? Number(p.tc_venta) : null,
        diferencia_cambiaria_ars: Number(p.diferencia_cambiaria_ars || 0),
        cambio_divisa_id: p.cambio_divisa_id || null,
        caja_seller_id: p.caja_seller_id,
        caja_buyer_id: p.caja_buyer_id,
        seller_movimiento_id: p.seller_cobro_id,
        buyer_movimiento_id: p.buyer_pago_id,
        side: p.registered_by_side,
        registered_by_user_id: p.registered_by_user_id,
        registered_by_username: p.registered_by_username,
        fecha: p.registered_at,
        propagated_at: p.propagated_at,
        pagado_acumulado_usd: acumulado,
        restante_usd: round2(Number(data.op.total_usd) - acumulado),
      };
    });

    return res.json({
      operation: {
        id: data.op.id,
        my_side: data.op.seller_tenant_id === myTenantId ? 'seller' : 'buyer',
        total_usd: Number(data.op.total_usd),
        status: data.op.status,
      },
      saldo: {
        pagado_usd: data.saldo.pagado_usd,
        restante_usd: data.saldo.restante_usd,
        total_usd: data.saldo.total_usd,
        completo: data.saldo.completo,
      },
      pagos,
    });
  } catch (err) {
    return next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/red-b2b/operations/:id/devolucion
//
// Devolución cross-tenant (decisión #11). Solo el buyer puede iniciar.
//
// Flow:
//   A. Lookup op + verificar status='active' + caller es buyer
//   B. Verificar parent_op_id NULL (no se devuelve una devolución)
//   C. Para cada item: validar cantidad <= disponible (cantidad_original − ya devuelto)
//   D. SET LOCAL seller: stock += cantidad + INSERT mov_cc devolución (monto negativo)
//   E. SET LOCAL buyer: stock -= cantidad + INSERT proveedor_mov devolución (monto negativo)
//   F. INSERT cross_tenant_operations NEW con parent_op_id apuntando a la original,
//      total negativo, status='active', items
//   G. Notif a ambos lados (operation_modified con flag is_devolucion=true)
//   H. Audit del buyer (originador)
//   I. COMMIT
//
// DECISIÓN F4: si la devolución supera lo pagado, queda SALDO A FAVOR del
// buyer (no revierte pagos automáticamente). El seller le devuelve la plata
// por afuera o descuenta del próximo pedido.
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/devolucion', validate(devolucionSchema), async (req, res, next) => {
  const myTenantId = req.tenantId;
  const userId = req.user.id;
  const opId = parseId(req.params.id);
  if (!opId) return res.status(400).json({ error: 'id inválido' });
  const { items: devItems, motivo } = req.body;

  // P1-3 audit 2026-07-11: Idempotency-Key opcional en POST /devolucion.
  //
  // Mismo patrón que COR-1 en POST /pagos: el frontend genera un UUID al
  // abrir el modal Devolución y lo manda como header `Idempotency-Key`
  // en cada intento. Doble-click / retry por 502 / dos pestañas del mismo
  // user con la misma devolución mandan el MISMO UUID → el 1er intento
  // crea la devOp con client_generated_id=UUID en cross_tenant_operations;
  // los siguientes encuentran el registro y devuelven el mismo response
  // (sin ejecutar side effects otra vez).
  //
  // Sin header → comportamiento igual al anterior (permite devoluciones
  // duplicadas intencionales — raro en devolución vs pago pero posible).
  //
  // UUID v1-8 validado por regex — un typo del cliente no bypasa la
  // idempotency. La lowercase normaliza para el chequeo case-insensitive
  // del index UNIQUE.
  const idempotencyKeyRaw = req.get('Idempotency-Key') || null;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (idempotencyKeyRaw && !UUID_RE.test(idempotencyKeyRaw)) {
    return res.status(400).json({
      error: 'Idempotency-Key debe ser UUID v1-8 (RFC 9562)',
      reason: 'idempotency_key_invalid',
    });
  }
  const idempotencyKey = idempotencyKeyRaw ? idempotencyKeyRaw.toLowerCase() : null;

  try {
    // DECISIÓN durable (Lucas, 2026-06-28 — PR-C P1-5, issue #462): NO
    // validamos partnership_active acá, consistente con POST /pagos
    // (decisión doc 6.6.D). Razón: una devolución es cleanup financiero/de
    // mercadería de una op pre-existente — bloquearla post-revoke crea un
    // problema legal (te entregué merca rota, no podés devolvérmela porque
    // me bloqueaste). El buyer es el único que puede iniciar devolución
    // (validación `only_buyer_can_devolucion` más abajo) y la op original
    // tuvo que existir bajo partnership active → la pre-condición ya está
    // implícita. Ver docs/design/red-b2b-cross-tenant.md sección 6.6.G.
    const result = await db.adminQuery(async (client) => {
      await client.query('BEGIN');
      try {
        // A. Lookup op.
        const opQ = await client.query(
          `SELECT * FROM cross_tenant_operations
             WHERE id = $1
               AND (seller_tenant_id = $2 OR buyer_tenant_id = $2)
             FOR UPDATE`,
          [opId, myTenantId]
        );
        const op = opQ.rows[0];
        if (!op) {
          await client.query('ROLLBACK');
          return { error: 'not_found', status: 404 };
        }
        if (op.status !== 'active') {
          await client.query('ROLLBACK');
          return { error: 'op_not_active', status: 409 };
        }
        if (op.parent_op_id != null) {
          // No se devuelve una devolución.
          await client.query('ROLLBACK');
          return { error: 'cannot_return_a_return', status: 400 };
        }
        if (op.buyer_tenant_id !== myTenantId) {
          await client.query('ROLLBACK');
          return { error: 'only_buyer_can_devolucion', status: 403 };
        }

        // A.1 IDEMPOTENCY (audit 2026-07-11 P1-3): si el caller mandó
        // Idempotency-Key y ya existe una devolución con esa key para esta
        // op (parent_op_id = opId), es un retry — devolvemos la devolución
        // original SIN reejecutar el flow.
        //
        // El FOR UPDATE de arriba serializa las txs concurrentes: si la 1ra
        // aún no committeó, la 2da espera. Cuando la 1ra committea, la 2da
        // toma el lock, hace este SELECT y encuentra la devolución → early-return.
        //
        // Race window residual: 2 requests entran a la 1ra tx en paralelo,
        // ambos hacen el SELECT y ambos no encuentran nada → ambos intentan
        // INSERT. El UNIQUE index parcial `idx_ct_ops_devolucion_idempotency`
        // atrapa al 2do en el commit (SQLSTATE 23505) → catch abajo devuelve
        // 409 idempotency_conflict (cliente puede retryar y esta vez encontrará
        // el registro).
        if (idempotencyKey) {
          const dup = await client.query(
            `SELECT id, created_at, total_usd, total_ars, parent_op_id
               FROM cross_tenant_operations
               WHERE parent_op_id = $1
                 AND client_generated_id = $2
               LIMIT 1`,
            [opId, idempotencyKey]
          );
          if (dup.rows[0]) {
            await client.query('ROLLBACK');
            // P2-3: incluimos op_status_now del parent — mismo raciocinio que
            // en POST /pagos. Si el parent op fue cancelado tras el hecho, el
            // frontend recibe la devolución original (válida) + señal del
            // estado actual para mostrar warning si corresponde.
            return {
              idempotent_replay: true,
              existing_devolucion: dup.rows[0],
              op_status_now: op.status,
            };
          }
        }

        const sellerTenantId = op.seller_tenant_id;
        const buyerTenantId  = op.buyer_tenant_id;

        // B. Cargar items originales + items ya devueltos (sumando todas las
        // devoluciones previas con parent_op_id=opId).
        const origItemsQ = await client.query(
          `SELECT id, seller_producto_id, buyer_producto_id, cantidad,
                  precio_unitario_usd, precio_unitario_ars
             FROM cross_tenant_operation_items
             WHERE cross_tenant_operation_id = $1
             ORDER BY id`,
          [opId]
        );
        const origItemsMap = new Map(origItemsQ.rows.map((r) => [Number(r.id), r]));

        // Suma de devoluciones previas por item original (para validar cantidad).
        // Las devoluciones son ops con parent_op_id IS NOT NULL. Sus items
        // tienen cantidad POSITIVA (el CHECK > 0 lo enforza). La identidad
        // de devolución viene del parent_op_id + total_usd negativo de la op.
        // 2026-07-11 (auditoría Red B2B P3-3): COALESCE defensive. Con GROUP BY
        // si no hay filas del JOIN para un producto, ese producto no aparece
        // en el resultado (no genera SUM NULL). Pero SUM(cantidad) sobre un
        // solo row con cantidad NULL sí devuelve NULL (aunque el CHECK > 0
        // lo previene). Wrapear con COALESCE deja el default explícito.
        const prevDevQ = await client.query(
          `SELECT items.seller_producto_id, items.buyer_producto_id,
                  COALESCE(SUM(items.cantidad), 0) AS cant_devuelta
             FROM cross_tenant_operation_items items
             JOIN cross_tenant_operations devops
               ON devops.id = items.cross_tenant_operation_id
             WHERE devops.parent_op_id = $1
             GROUP BY items.seller_producto_id, items.buyer_producto_id`,
          [opId]
        );
        const devueltoMap = new Map();
        for (const r of prevDevQ.rows) {
          const key = `${r.seller_producto_id}_${r.buyer_producto_id}`;
          devueltoMap.set(key, Number(r.cant_devuelta) || 0);
        }

        // Validar cada item solicitado + armar lista de devolución.
        const itemsDevolucion = [];
        let totalUsdDev = 0;
        let totalArsDev = 0;
        for (const di of devItems) {
          const orig = origItemsMap.get(Number(di.cross_tenant_operation_item_id));
          if (!orig) {
            await client.query('ROLLBACK');
            return { error: 'item_not_in_op', status: 400,
              details: { cross_tenant_operation_item_id: di.cross_tenant_operation_item_id } };
          }
          const key = `${orig.seller_producto_id}_${orig.buyer_producto_id}`;
          const yaDevuelto = devueltoMap.get(key) || 0;
          const disponible = Number(orig.cantidad) - yaDevuelto;
          const pedido = Number(di.cantidad);
          if (pedido > disponible) {
            await client.query('ROLLBACK');
            return { error: 'devolucion_excede_cantidad', status: 400,
              details: { item_id: orig.id, cantidad_original: Number(orig.cantidad),
                         ya_devuelto: yaDevuelto, disponible, pedido } };
          }
          const precio_usd = Number(orig.precio_unitario_usd);
          const precio_ars = Number(orig.precio_unitario_ars);
          itemsDevolucion.push({
            seller_producto_id: orig.seller_producto_id,
            buyer_producto_id:  orig.buyer_producto_id,
            cantidad: pedido,
            precio_unitario_usd: precio_usd,
            precio_unitario_ars: precio_ars,
          });
          totalUsdDev += precio_usd * pedido;
          totalArsDev += precio_ars * pedido;
        }
        totalUsdDev = round2(totalUsdDev);
        totalArsDev = round2(totalArsDev);

        // PR-B Bug H3: validar que la devolución no exceda lo efectivamente
        // pagado (incluyendo devoluciones previas como crédito).
        //
        // Bug original: si el buyer devolvía 100% sin haber pagado nada, el
        // mov_cc tipo='devolucion' del lado seller (con monto positivo)
        // descontaba del saldo del cliente, dejándolo NEGATIVO (cliente le
        // debe al seller por una compra que se devolvió). Doc 6.6 dice
        // "saldo a favor del buyer" pero ese concepto solo tiene sentido si
        // hubo pagos previos; sin pagos no hay deuda que descontar.
        //
        // Suma de pagos cross-tenant + suma de devoluciones previas.
        // - cross_tenant_pagos.monto_usd: contractual USD pagado por la op.
        //   Si en el futuro se permiten reversos como pagos con monto_usd
        //   negativo, este SUM ya los incluye natural (positivo + negativo).
        // - SUM(cantidad × precio_unitario_usd) de devoluciones previas: el
        //   crédito acumulado por mercadería ya devuelta. Cada devolución
        //   previa "consumió" una porción del pago.
        const pagosQ = await client.query(
          `SELECT COALESCE(SUM(monto_usd), 0) AS pagado_usd
             FROM cross_tenant_pagos
             WHERE cross_tenant_operation_id = $1`,
          [opId]
        );
        const totalPagadoUsd = Number(pagosQ.rows[0].pagado_usd) || 0;

        // Devoluciones previas: total USD ya devuelto (suma items × precio).
        const prevDevTotalQ = await client.query(
          `SELECT COALESCE(SUM(items.cantidad * items.precio_unitario_usd), 0) AS dev_usd
             FROM cross_tenant_operation_items items
             JOIN cross_tenant_operations devops
               ON devops.id = items.cross_tenant_operation_id
             WHERE devops.parent_op_id = $1`,
          [opId]
        );
        const totalDevPreviasUsd = Number(prevDevTotalQ.rows[0].dev_usd) || 0;

        // Lo que el buyer puede devolver = lo pagado − lo ya devuelto.
        // Tolerancia 1 centavo para floating point.
        const maxDevolvibleUsd = round2(totalPagadoUsd - totalDevPreviasUsd);
        if (totalUsdDev > maxDevolvibleUsd + 0.01) {
          await client.query('ROLLBACK');
          return {
            error: 'devolucion_excede_pagado', status: 409,
            details: {
              pagado_usd: round2(totalPagadoUsd),
              ya_devuelto_usd: round2(totalDevPreviasUsd),
              max_devolvible_usd: maxDevolvibleUsd,
              intentado_usd: totalUsdDev,
            },
          };
        }

        // Lookup tenants para descripciones.
        const tenantsQ = await client.query(
          `SELECT id, nombre, slug, plan FROM tenants WHERE id = ANY($1::int[])`,
          [[sellerTenantId, buyerTenantId]]
        );
        const tenantsById = new Map(tenantsQ.rows.map((r) => [r.id, r]));
        const sellerTenant = tenantsById.get(sellerTenantId);
        const buyerTenant  = tenantsById.get(buyerTenantId);

        // C. SET LOCAL seller: stock += cantidad + INSERT mov_cc devolución.
        await client.query(`SET LOCAL app.current_tenant = ${Number(sellerTenantId)}`);
        await client.query(
          `UPDATE productos p SET
              cantidad = p.cantidad + u.cant,
              estado = CASE
                WHEN p.cantidad + u.cant > 0 AND p.estado = 'vendido' THEN 'disponible'
                ELSE p.estado
              END
            FROM UNNEST($1::int[], $2::int[]) AS u(pid, cant)
            WHERE p.id = u.pid AND p.tenant_id = $3 AND p.deleted_at IS NULL`,
          [
            itemsDevolucion.map((x) => x.seller_producto_id),
            itemsDevolucion.map((x) => x.cantidad),
            sellerTenantId,
          ]
        );
        // Resolver cliente_cc del seller (mismo nombre del buyer).
        const sellerClienteCcId = await ensureSellerClienteCc(client, sellerTenantId, buyerTenant);
        // INSERT mov_cc tipo='devolucion' con monto USD ABSOLUTO + cross_tenant
        // FIELD. La devolucion en el módulo CC se trackea con tipo='devolucion'
        // (que ya existe en el CHECK desde la migration B2B saldo-inicial).
        const sellerDevMovQ = await client.query(
          `INSERT INTO movimientos_cc
             (tenant_id, cliente_cc_id, fecha, tipo, descripcion, monto_total,
              notas, caja_id, created_by_user_id, estado,
              cross_tenant_operation_id)
           VALUES ($1, $2, CURRENT_DATE, 'devolucion', $3, $4,
                   $5, NULL, $6, 'acreditado',
                   NULL)
           RETURNING id`,
          [
            sellerTenantId,
            sellerClienteCcId,
            `Red B2B devolución de op #${opId} ← ${buyerTenant.nombre}`,
            totalUsdDev,
            motivo || null,
            userId,
          ]
        );
        const sellerDevMovId = sellerDevMovQ.rows[0].id;

        // D. SET LOCAL buyer: stock -= cantidad (sin guard — puede quedar
        // negativo si ya vendió) + INSERT proveedor_mov tipo='devolucion'.
        //
        // COR-2 audit 2026-07-06: hasta ahora se usaba tipo='pago' porque el
        // CHECK de proveedor_movimientos.tipo no admitía 'devolucion'. La
        // migration 20260706000002 extendió el CHECK y backfilleó las filas
        // históricas — ahora usamos el tipo correcto para no inflar los KPIs
        // de "pagos al proveedor" y que los filtros por tipo funcionen bien.
        await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
        await client.query(
          `UPDATE productos p SET
              cantidad = p.cantidad - u.cant,
              estado = CASE
                WHEN p.cantidad - u.cant <= 0 THEN 'vendido'
                ELSE p.estado
              END
            FROM UNNEST($1::int[], $2::int[]) AS u(pid, cant)
            WHERE p.id = u.pid AND p.tenant_id = $3 AND p.deleted_at IS NULL`,
          [
            itemsDevolucion.map((x) => x.buyer_producto_id),
            itemsDevolucion.map((x) => x.cantidad),
            buyerTenantId,
          ]
        );
        const buyerProveedorId = await ensureBuyerProveedor(client, buyerTenantId, sellerTenant);
        const buyerDevMovQ = await client.query(
          `INSERT INTO proveedor_movimientos
             (tenant_id, proveedor_id, fecha, tipo, descripcion, monto, moneda, tc,
              monto_usd, caja_id, notas, created_by_user_id,
              cross_tenant_operation_id)
           VALUES ($1, $2, CURRENT_DATE, 'devolucion', $3, $4, 'USD', NULL,
                   $4, NULL, $5, $6,
                   NULL)
           RETURNING id`,
          [
            buyerTenantId,
            buyerProveedorId,
            `Red B2B devolución de op #${opId} → ${sellerTenant.nombre}`,
            totalUsdDev,
            motivo || null,
            userId,
          ]
        );
        const buyerDevMovId = buyerDevMovQ.rows[0].id;

        // E. INSERT cross_tenant_operations NEW (devolución).
        // Total y precios negativos para diferenciar. parent_op_id apunta a la
        // op original.
        //
        // P1-3 audit 2026-07-11: agregado `client_generated_id` al INSERT.
        // NULL cuando el cliente no manda `Idempotency-Key` (backwards compat).
        // Si viene, el UNIQUE index parcial `idx_ct_ops_devolucion_idempotency`
        // atrapa duplicados dentro del mismo parent_op_id (2do INSERT con misma
        // key en la misma op original → 23505 → 409 idempotency_conflict).
        let newOpQ;
        try {
          newOpQ = await client.query(
            `INSERT INTO cross_tenant_operations
               (partnership_id, seller_tenant_id, buyer_tenant_id,
                seller_venta_id, buyer_compra_id, status,
                total_usd, total_ars, tc_used, created_by_user_id,
                parent_op_id, client_generated_id)
             VALUES ($1, $2, $3, $4, $5, 'active',
                     $6, $7, $8, $9,
                     $10, $11)
             RETURNING id, created_at`,
            [
              op.partnership_id,
              sellerTenantId,
              buyerTenantId,
              sellerDevMovId,
              buyerDevMovId,
              -totalUsdDev,                        // total negativo
              -totalArsDev,
              Number(op.tc_used),
              userId,
              opId,                                 // parent
              idempotencyKey,                       // NULL si el caller no mandó header
            ]
          );
        } catch (err) {
          // P1-3: race del index parcial `idx_ct_ops_devolucion_idempotency`.
          // El SELECT del early-check no encontró duplicado, pero entre ese
          // SELECT y este INSERT otro request con la misma key ganó. El UNIQUE
          // viola con SQLSTATE 23505. Devolvemos 409 estable para que el
          // cliente retryee — el próximo intento encontrará la devolución
          // via el early-check.
          if (idempotencyKey && err.code === '23505' &&
              err.constraint === 'idx_ct_ops_devolucion_idempotency') {
            await client.query('ROLLBACK');
            return { error: 'idempotency_conflict', status: 409 };
          }
          throw err;
        }
        const devOpId = newOpQ.rows[0].id;

        // Items: cantidad POSITIVA (CHECK cantidad > 0 en la tabla). El
        // signo negativo de la op (total_usd) + parent_op_id IS NOT NULL
        // identifican que es una devolución. La suma de cantidades en
        // devoluciones se obtiene del agregado WHERE parent_op_id IS NOT NULL.
        // Precios POSITIVOS también — el total negativo aplica a nivel op.
        await client.query(
          `INSERT INTO cross_tenant_operation_items
             (cross_tenant_operation_id, seller_producto_id, buyer_producto_id,
              cantidad, precio_unitario_usd, precio_unitario_ars)
           SELECT $1, spid, bpid, cant, pu_usd, pu_ars
             FROM UNNEST(
               $2::int[], $3::int[], $4::int[],
               $5::numeric[], $6::numeric[]
             ) AS u(spid, bpid, cant, pu_usd, pu_ars)`,
          [
            devOpId,
            itemsDevolucion.map((x) => x.seller_producto_id),
            itemsDevolucion.map((x) => x.buyer_producto_id),
            itemsDevolucion.map((x) => x.cantidad),
            itemsDevolucion.map((x) => x.precio_unitario_usd),
            itemsDevolucion.map((x) => x.precio_unitario_ars),
          ]
        );

        // Link mov_cc + proveedor_mov a la nueva op.
        await client.query(`SET LOCAL app.current_tenant = ${Number(sellerTenantId)}`);
        await client.query(
          `UPDATE movimientos_cc SET cross_tenant_operation_id = $1
             WHERE id = $2 AND tenant_id = $3`,
          [devOpId, sellerDevMovId, sellerTenantId]
        );
        await client.query(`SET LOCAL app.current_tenant = ${Number(buyerTenantId)}`);
        await client.query(
          `UPDATE proveedor_movimientos SET cross_tenant_operation_id = $1
             WHERE id = $2 AND tenant_id = $3`,
          [devOpId, buyerDevMovId, buyerTenantId]
        );

        // F. Notificar a AMBOS lados (el seller necesita saber que llega
        // mercadería, el buyer queda con confirmación). Para el seller es
        // 'operation_modified' con payload flag de devolución (no creamos
        // nuevo type para evitar otra migration al CHECK del notification type).
        await notify(client, sellerTenantId, 'operation_modified', {
          partner: tenantSnapshot(buyerTenant),
          operation_id: opId,
          devolucion_op_id: devOpId,
          is_devolucion: true,
          total_usd_devuelto: totalUsdDev,
          items_count: itemsDevolucion.length,
          motivo: motivo || null,
          from_user_id: userId,
          from_username: req.user.username,
        }, { partnershipId: op.partnership_id, operationId: opId });

        // G. Audit del buyer (originador de la devolución).
        await client.query(`SET LOCAL app.current_tenant = ${Number(myTenantId)}`);
        await audit(client, {
          tenantId: myTenantId,
          userId,
          action: 'cross_tenant_devolucion',
          payload: {
            parent_operation_id: opId,
            devolucion_op_id: devOpId,
            total_usd_devuelto: totalUsdDev,
            items_count: itemsDevolucion.length,
            motivo: motivo || null,
          },
        });

        await client.query('COMMIT');
        return {
          ok: true,
          devOpId,
          opId,
          sellerTenantId,
          buyerTenantId,
          partnershipId: op.partnership_id,
          totalUsdDev,
        };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });

    if (result.error) {
      return res.status(result.status).json({
        error: errorMessage(result.error),
        reason: result.error,
        ...(result.details ? { details: result.details } : {}),
      });
    }

    // P1-3 audit 2026-07-11: Idempotency-Key replay.
    // El caller mandó una key ya vista → devolvemos 200 con la devolución
    // original. NO emitimos notif/audit/cache-invalidation ni corremos
    // logger.info de nueva creación — todo eso ya se ejecutó en la 1ra
    // request y volver a hacerlo confundiría el trail.
    //
    // El status es 200 (idempotent replay) vs 201 (created) para que el
    // frontend pueda diferenciar (si le importa mostrar toast distinto).
    if (result.idempotent_replay) {
      logger.info({
        parent_operation_id: opId,
        devolucion_op_id: result.existing_devolucion.id,
        tenant_id: myTenantId,
        user_id: userId,
      }, '[red-b2b/F4] Idempotency-Key replay — devolución existente');
      return res.status(200).json({
        idempotent_replay: true,
        devolucion: {
          id: result.existing_devolucion.id,
          parent_op_id: result.existing_devolucion.parent_op_id,
          total_usd_devuelto: Math.abs(Number(result.existing_devolucion.total_usd)),
        },
        // P2-3: estado actual del parent op para detectar cambios post-registro.
        op_status_now: result.op_status_now,
      });
    }

    // Invalidar caches de inventario en ambos tenants (cantidad cambió).
    // PR-D #463: conciliation ya no tiene cache (decisión Lucas).
    invalidateMetricas(result.sellerTenantId).catch(() => {});
    invalidateMetricas(result.buyerTenantId).catch(() => {});

    logger.info({
      parent_operation_id: result.opId,
      devolucion_op_id: result.devOpId,
      tenant_id: myTenantId,
      user_id: userId,
      total_usd_devuelto: result.totalUsdDev,
    }, '[red-b2b/F4] devolución cross-tenant registrada');

    return res.status(201).json({
      devolucion: {
        id: result.devOpId,
        parent_op_id: result.opId,
        total_usd_devuelto: result.totalUsdDev,
      },
    });
  } catch (err) {
    return next(err);
  }
});

function errorMessage(reason) {
  const map = {
    not_found:                   'Operación no encontrada.',
    op_cancelled:                'La operación fue cancelada — no se pueden registrar pagos.',
    op_frozen:                   'La operación está congelada (alguno de los tenants vencido).',
    op_not_active:                'La operación no está activa.',
    side_mismatch:               'El side declarado no coincide con tu rol en la operación.',
    overpayment:                 'El monto excede el saldo restante de la operación.',
    caja_not_found:              'La caja indicada no existe o está inactiva.',
    caja_moneda_incompatible:    'La caja no es compatible con la moneda del pago.',
    buyer_no_caja_compatible:    'El partner no tiene caja default compatible con la moneda del pago.',
    seller_no_caja_compatible:   'El partner no tiene caja default compatible con la moneda del pago.',
    only_buyer_can_devolucion:   'Solo el comprador puede iniciar una devolución cross-tenant.',
    cannot_return_a_return:      'No se puede devolver una devolución — devolvé sobre la operación original.',
    item_not_in_op:              'Alguno de los items no pertenece a la operación.',
    devolucion_excede_cantidad:  'La cantidad a devolver excede lo disponible (cantidad original menos lo ya devuelto).',
    // PR-B Bug H3: devolución solo hasta lo pagado (incluyendo crédito de
    // devoluciones previas).
    devolucion_excede_pagado:    'La devolución supera lo efectivamente pagado por esta operación. Sin pagos previos no hay deuda que descontar — pedile al seller que cancele la op o registrá el pago primero.',
    // COR-1 audit 2026-07-06 + P1-3 audit 2026-07-11 — race del index parcial
    // de idempotency. El mismo `idempotency_conflict` cubre POST /pagos (COR-1,
    // index `idx_ct_pagos_idempotency`) y POST /devolucion (P1-3, index
    // `idx_ct_ops_devolucion_idempotency`). Mensaje genérico "operación" así
    // el mismo string sirve para ambos casos sin confundir al operador.
    idempotency_conflict:        'Ya hay una operación en proceso con esta clave. Reintentá en 1 segundo.',
  };
  return map[reason] || 'Acción inválida.';
}

module.exports = router;

/**
 * Red B2B F4 — helpers para registrar pagos cross-tenant + multi-divisa.
 *
 * Diseño en docs/design/red-b2b-cross-tenant.md sección 6.3 (flujo de pago)
 * + decisión #16 (multi-divisa re-cálculo bilateral).
 *
 * Conceptos clave:
 *   - Una OPERACIÓN cross-tenant genera CC en ambos lados:
 *       seller: cliente_cc B2B con deuda (movimientos_cc tipo='compra')
 *       buyer:  proveedor_cc con deuda (proveedor_movimientos tipo='compra')
 *   - El PAGO de la op genera filas opuestas:
 *       seller: movimientos_cc tipo='pago' (entrada de plata, baja deuda cliente)
 *       buyer:  proveedor_movimientos tipo='pago' (salida de plata, baja deuda prov)
 *   - Multi-divisa: si moneda_pago !== moneda_venta (USD), se calcula la
 *     diferencia cambiaria y se asienta como movimiento en módulo Cambios
 *     de Divisa del seller (NO del buyer — la asimetría es intencional:
 *     el seller es quien define el TC y recibe el dinero, por eso la
 *     diferencia impacta a él).
 *
 * Patrón de cross-tenant safety:
 *   1. Caller (endpoint POST /operations/:id/pagos) maneja BEGIN/COMMIT en
 *      adminQuery + BYPASSRLS.
 *   2. Helpers asumen que el client tiene SET LOCAL del tenant correcto.
 *   3. Validación de partnership/op se hace en el endpoint ANTES.
 */

const { round2 } = require('./money');

/**
 * Calcula la diferencia cambiaria en ARS entre TC venta y TC pago.
 *
 * Lógica:
 *   - Si pago en USD → diferencia = 0 (no hay re-cálculo).
 *   - Si pago en ARS:
 *       valor_en_ars_segun_venta = monto_usd * tc_venta
 *       valor_en_ars_segun_pago  = monto_usd * tc_pago
 *       diferencia = valor_en_ars_segun_pago - valor_en_ars_segun_venta
 *
 *     Si tc_pago > tc_venta → diferencia POSITIVA (el seller recibió MÁS
 *       ARS que lo que esperaba al momento de vender → GANANCIA).
 *     Si tc_pago < tc_venta → diferencia NEGATIVA (recibió MENOS → PÉRDIDA).
 *
 * Pure function — sin DB, sin side effects. Fácil de testear suelta.
 *
 * @param {number} montoUsd — monto del pago expresado en USD (siempre)
 * @param {number|null} tcVenta — TC original de la venta (de cross_tenant_operations.tc_used)
 * @param {number|null} tcPago — TC efectivo del pago
 * @param {string} monedaPago — 'USD' o 'ARS'
 * @returns {{ diferencia_ars: number, ganancia_seller: boolean }}
 */
function calcularDiferenciaCambiaria(montoUsd, tcVenta, tcPago, monedaPago = 'ARS') {
  const usd = Number(montoUsd) || 0;
  const tv = Number(tcVenta) || 0;
  const tp = Number(tcPago) || 0;

  // Pago en USD: no hay diferencia cambiaria (no se cruzan TCs).
  if (monedaPago === 'USD') {
    return { diferencia_ars: 0, ganancia_seller: false };
  }

  // TCs faltantes o cero → sin diferencia calculable.
  if (tv <= 0 || tp <= 0) {
    return { diferencia_ars: 0, ganancia_seller: false };
  }

  const valorSegunVenta = usd * tv;
  const valorSegunPago  = usd * tp;
  const diferencia = round2(valorSegunPago - valorSegunVenta);

  return {
    diferencia_ars: diferencia,
    ganancia_seller: diferencia > 0,
  };
}

/**
 * Resuelve la caja default cross-tenant del tenant, o la primera caja
 * con moneda compatible si no está configurada.
 *
 * Llamada bajo SET LOCAL del tenant (RLS estándar de metodos_pago).
 *
 * @param {object} client — pg client
 * @param {number} tenantId
 * @param {string} moneda — 'USD' | 'ARS' | 'USDT' (compatibilidad de caja)
 * @param {number|null} defaultCajaId — tenants.red_b2b_caja_default_id
 * @returns {Promise<number|null>} caja_id o null si no hay caja compatible
 */
async function resolveCajaParaTenant(client, tenantId, moneda, defaultCajaId) {
  // Si hay default configurada, validar que existe + es de la moneda compatible.
  // metodos_pago NO tiene tenant_id directo (es catálogo global del portal —
  // ver migration 20260524000002). Sin RLS — usamos query directa.
  if (defaultCajaId) {
    const q = await client.query(
      `SELECT id, moneda FROM metodos_pago
         WHERE id = $1 AND activo = true AND deleted_at IS NULL`,
      [defaultCajaId]
    );
    if (q.rows[0]) {
      // Compatibilidad: USD ↔ USDT son intercambiables, ARS es estricto.
      const cajaMon = q.rows[0].moneda;
      if (moneda === 'ARS' && cajaMon === 'ARS') return q.rows[0].id;
      if (moneda === 'USD' && (cajaMon === 'USD' || cajaMon === 'USDT')) return q.rows[0].id;
      if (moneda === 'USDT' && (cajaMon === 'USD' || cajaMon === 'USDT')) return q.rows[0].id;
      // Default existe pero no compatible → caemos a la primera caja compatible.
    }
  }
  // Fallback: primera caja del catálogo con moneda compatible.
  const grupos = moneda === 'ARS' ? ['ARS'] : ['USD', 'USDT'];
  const q = await client.query(
    `SELECT id FROM metodos_pago
       WHERE moneda = ANY($1::text[]) AND activo = true AND deleted_at IS NULL
       ORDER BY orden ASC, id ASC
       LIMIT 1`,
    [grupos]
  );
  return q.rows[0]?.id || null;
}

/**
 * Busca o crea el cliente_cc del SELLER que representa al partner BUYER.
 * Idempotente por nombre (mismo patrón que createSellerVenta en F3).
 *
 * Llamada bajo SET LOCAL del seller.
 */
async function ensureSellerClienteCc(client, sellerTenantId, buyerTenant) {
  const buyerName = buyerTenant.nombre;
  const lookup = await client.query(
    `SELECT id FROM clientes_cc
       WHERE LOWER(nombre) = LOWER($1) AND deleted_at IS NULL
       LIMIT 1`,
    [buyerName]
  );
  if (lookup.rows[0]) return lookup.rows[0].id;
  const ins = await client.query(
    `INSERT INTO clientes_cc (tenant_id, nombre, categoria, notas)
     VALUES ($1, $2, 'A-', $3)
     RETURNING id`,
    [
      sellerTenantId,
      buyerName,
      `Cliente Red B2B auto-creado (F4 — al registrar primer pago) — partner tenant id=${buyerTenant.id}.`,
    ]
  );
  return ins.rows[0].id;
}

/**
 * Busca o crea el proveedor del BUYER que representa al partner SELLER.
 * Análogo a ensureSellerClienteCc.
 *
 * Llamada bajo SET LOCAL del buyer.
 */
async function ensureBuyerProveedor(client, buyerTenantId, sellerTenant) {
  const sellerName = sellerTenant.nombre;
  const lookup = await client.query(
    `SELECT id FROM proveedores
       WHERE LOWER(nombre) = LOWER($1) AND deleted_at IS NULL
       LIMIT 1`,
    [sellerName]
  );
  if (lookup.rows[0]) return lookup.rows[0].id;
  const ins = await client.query(
    `INSERT INTO proveedores (tenant_id, nombre, notas)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      buyerTenantId,
      sellerName,
      `Proveedor Red B2B auto-creado (F4 — al registrar primer pago) — partner tenant id=${sellerTenant.id}.`,
    ]
  );
  return ins.rows[0].id;
}

/**
 * Registra el lado SELLER del pago en movimientos_cc tipo='pago'.
 *
 * Llamada bajo SET LOCAL del seller tenant. SI moneda_pago !== USD (caja USD)
 * ADICIONALMENTE registra un movimiento en módulo Cambios de Divisa con la
 * diferencia cambiaria — decisión #16 del doc.
 *
 * @param {object} client — pg client bajo SET LOCAL del seller
 * @param {number} sellerTenantId
 * @param {object} args — { opId, buyerTenant, monto_usd, moneda_pago, monto_pago,
 *                          tc_pago, tc_venta, caja_id, fecha, callerUserId,
 *                          diferencia_cambiaria_ars }
 * @returns {Promise<{ movimiento_id: number, cambio_divisa_id: number|null,
 *                     cliente_cc_id: number }>}
 */
async function registerSellerCobro(client, sellerTenantId, args) {
  const {
    opId, buyerTenant, monto_usd, moneda_pago, monto_pago, tc_pago, tc_venta,
    caja_id, fecha, callerUserId, diferencia_cambiaria_ars,
  } = args;

  // 1. Cliente_cc del seller para este partner buyer.
  const clienteCcId = await ensureSellerClienteCc(client, sellerTenantId, buyerTenant);

  // 2. INSERT movimientos_cc tipo='pago'.
  // El monto_total siempre se guarda en USD (moneda neutra interna del portal,
  // mismo patrón que F3). El TC y monto en moneda_pago van en notas/descripcion.
  const descripcion = `Red B2B → pago cross-tenant op #${opId} (${moneda_pago === 'USD'
    ? `USD ${round2(monto_pago)}`
    : `ARS ${round2(monto_pago)} @ TC ${tc_pago}`})`;

  const movQ = await client.query(
    `INSERT INTO movimientos_cc
       (tenant_id, cliente_cc_id, fecha, tipo, descripcion, monto_total,
        notas, caja_id, created_by_user_id, estado,
        cross_tenant_operation_id)
     VALUES ($1, $2, $3, 'pago', $4, $5,
             $6, $7, $8, 'acreditado',
             $9)
     RETURNING id`,
    [
      sellerTenantId,
      clienteCcId,
      fecha,
      descripcion,
      round2(monto_usd),
      args.notas || null,
      caja_id,
      callerUserId,
      opId,
    ]
  );
  const movimientoId = movQ.rows[0].id;

  // 3. Si moneda_pago === 'ARS', registrar la diferencia cambiaria como
  //    movimiento en módulo Cambios de Divisa del seller (decisión #16).
  //    Solo si la diferencia es no-cero (puede ser cero si tc_pago == tc_venta).
  let cambioDivisaId = null;
  if (moneda_pago === 'ARS' && Math.abs(Number(diferencia_cambiaria_ars) || 0) >= 0.01) {
    // El módulo Cambios de Divisa tiene entidades (financieras). Para Red B2B,
    // creamos (o reusamos) una entidad llamada "Red B2B — diferencias cambiarias"
    // del seller. Esto centraliza el tracking sin contaminar entidades reales.
    const ENTIDAD_NOMBRE = 'Red B2B — diferencias cambiarias';
    const entQ = await client.query(
      `SELECT id FROM cambio_entidades
         WHERE LOWER(nombre) = LOWER($1) AND deleted_at IS NULL
         LIMIT 1`,
      [ENTIDAD_NOMBRE]
    );
    let entidadId = entQ.rows[0]?.id;
    if (!entidadId) {
      const insEnt = await client.query(
        `INSERT INTO cambio_entidades (tenant_id, nombre, activo)
         VALUES ($1, $2, true)
         RETURNING id`,
        [sellerTenantId, ENTIDAD_NOMBRE]
      );
      entidadId = insEnt.rows[0].id;
    }

    // INSERT cambio_movimientos. Diferencia positiva = ingreso USD (ganancia);
    // negativa = entrega ARS (pérdida).
    //
    // El módulo Cambios maneja 2 tipos: 'entrega_ars' (les damos pesos —
    // egreso ARS) y 'recibo_usd' (ingreso USD).
    //
    // Para Red B2B usamos una convención: diferencia POSITIVA (ganancia
    // seller) → 'recibo_usd' (mejor TC del esperado → el seller "ganó USD").
    // diferencia NEGATIVA → 'entrega_ars' (peor TC → "perdió" en ARS).
    //
    // El monto_usd se calcula como diferencia_ars / tc_pago (USD equivalente
    // a la diferencia ARS al TC del pago — coherente con la lógica de
    // cambio_movimientos).
    const diffArs = Number(diferencia_cambiaria_ars);
    const isGanancia = diffArs > 0;
    const absArs = Math.abs(diffArs);
    const absUsd = round2(absArs / Number(tc_pago || 1));
    const tipo = isGanancia ? 'recibo_usd' : 'entrega_ars';

    const cdQ = await client.query(
      `INSERT INTO cambio_movimientos
         (tenant_id, entidad_id, fecha, tipo, monto_ars, tc, monto_usd,
          caja_id, comentarios, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               NULL, $8, $9)
       RETURNING id`,
      [
        sellerTenantId,
        entidadId,
        fecha,
        tipo,
        round2(absArs),
        round2(Number(tc_pago)),
        absUsd,
        `Red B2B op #${opId}: ${isGanancia ? 'ganancia' : 'pérdida'} cambiaria por TC pago ${tc_pago} vs TC venta ${tc_venta} (monto USD ${round2(monto_usd)}).`,
        callerUserId,
      ]
    );
    cambioDivisaId = cdQ.rows[0].id;
  }

  return {
    movimiento_id: movimientoId,
    cambio_divisa_id: cambioDivisaId,
    cliente_cc_id: clienteCcId,
  };
}

/**
 * Registra el lado BUYER del pago en proveedor_movimientos tipo='pago'.
 *
 * Llamada bajo SET LOCAL del buyer tenant. NO toca módulo Cambios de Divisa
 * — la diferencia cambiaria es responsabilidad del seller (asimetría
 * intencional decisión #16).
 *
 * @param {object} client — pg client bajo SET LOCAL del buyer
 * @param {number} buyerTenantId
 * @param {object} args — { opId, sellerTenant, monto_usd, moneda_pago,
 *                          monto_pago, tc_pago, caja_id, fecha, callerUserId, notas }
 * @returns {Promise<{ movimiento_id: number, proveedor_id: number }>}
 */
async function registerBuyerPago(client, buyerTenantId, args) {
  const {
    opId, sellerTenant, monto_usd, moneda_pago, monto_pago, tc_pago,
    caja_id, fecha, callerUserId,
  } = args;

  const proveedorId = await ensureBuyerProveedor(client, buyerTenantId, sellerTenant);

  // Para proveedor_movimientos: monto en moneda_pago, tc si ARS, monto_usd
  // siempre el USD canónico.
  const descripcion = `Red B2B ← pago cross-tenant op #${opId} (${moneda_pago === 'USD'
    ? `USD ${round2(monto_pago)}`
    : `ARS ${round2(monto_pago)} @ TC ${tc_pago}`})`;

  const movQ = await client.query(
    `INSERT INTO proveedor_movimientos
       (tenant_id, proveedor_id, fecha, tipo, descripcion, monto, moneda, tc,
        monto_usd, caja_id, notas, created_by_user_id,
        cross_tenant_operation_id)
     VALUES ($1, $2, $3, 'pago', $4, $5, $6, $7,
             $8, $9, $10, $11,
             $12)
     RETURNING id`,
    [
      buyerTenantId,
      proveedorId,
      fecha,
      descripcion,
      round2(Number(monto_pago)),
      moneda_pago,
      moneda_pago === 'ARS' ? round2(Number(tc_pago)) : null,
      round2(Number(monto_usd)),
      caja_id,
      args.notas || null,
      callerUserId,
      opId,
    ]
  );

  return {
    movimiento_id: movQ.rows[0].id,
    proveedor_id: proveedorId,
  };
}

/**
 * Calcula el saldo de pagos de una operación cross-tenant.
 *
 * Suma todos los cross_tenant_pagos.monto_usd de la op + compara contra
 * cross_tenant_operations.total_usd. Devuelve saldo restante.
 *
 * @param {object} client — pg client (cualquier scope — usa BYPASSRLS si admin)
 * @param {number} opId
 * @returns {Promise<{ pagado_usd: number, total_usd: number, restante_usd: number, completo: boolean }>}
 */
async function calcularSaldoOperacion(client, opId) {
  const q = await client.query(
    `SELECT
        op.total_usd,
        COALESCE(SUM(p.monto_usd), 0) AS pagado_usd
      FROM cross_tenant_operations op
      LEFT JOIN cross_tenant_pagos p ON p.cross_tenant_operation_id = op.id
      WHERE op.id = $1
      GROUP BY op.id, op.total_usd`,
    [opId]
  );
  const row = q.rows[0];
  if (!row) {
    return { pagado_usd: 0, total_usd: 0, restante_usd: 0, completo: false };
  }
  const total = round2(Number(row.total_usd));
  const pagado = round2(Number(row.pagado_usd) || 0);
  // Diferencia con tolerancia floating point.
  const restante = round2(total - pagado);
  const completo = Math.abs(restante) < 0.01;
  return { pagado_usd: pagado, total_usd: total, restante_usd: restante, completo };
}

module.exports = {
  calcularDiferenciaCambiaria,
  resolveCajaParaTenant,
  registerSellerCobro,
  registerBuyerPago,
  calcularSaldoOperacion,
  ensureSellerClienteCc,
  ensureBuyerProveedor,
};

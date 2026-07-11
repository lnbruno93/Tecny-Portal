/**
 * Red B2B F3 — helpers para crear/cancelar operaciones cross-tenant.
 *
 * Diseño en docs/design/red-b2b-cross-tenant.md sección 6.2. Cada helper
 * documenta el tenant scope que necesita (seller o buyer) ANTES de las
 * queries. El caller (endpoint) maneja la transacción y el SET LOCAL del
 * tenant; los helpers asumen que el `client` ya tiene el contexto correcto.
 *
 * Patrón de cross-tenant safety:
 *   1. `validateOperationPrecondition` se llama UNA vez al inicio de la tx
 *      (sin SET LOCAL — usa BYPASSRLS del adminQuery del caller).
 *   2. `findOrCreateBuyerProducto` corre bajo SET LOCAL del BUYER tenant.
 *   3. `createSellerVenta` corre bajo SET LOCAL del SELLER tenant.
 *   4. `createBuyerCompra` corre bajo SET LOCAL del BUYER tenant.
 *
 * Si el endpoint se equivoca de scope, los INSERT respetan el RLS (porque
 * el role admin tiene BYPASSRLS pero los WITH CHECK del FORCE RLS de
 * productos/movimientos_cc/proveedor_movimientos rebotan si el tenant_id
 * que insertamos no coincide con app.current_tenant). Defense in depth.
 *
 * Estos helpers son intencionalmente "tontos" — no validan partnership
 * (eso lo hace el endpoint con getActivePartnershipById ANTES). La razón:
 * mantener el endpoint dueño del flow + audit trail, y los helpers como
 * unidades atómicas de SQL fáciles de testear sueltas si hace falta.
 */

const { round2 } = require('./money');

/**
 * Verifica que se puedan crear operaciones cross-tenant entre los dos
 * tenants involucrados en la partnership.
 *
 * Chequea (todo via BYPASSRLS — la tabla tenants es admin):
 *   - partnership.status === 'active'
 *   - sellerTenantId es uno de los dos del partnership
 *   - Ambos tenants no están suspended_at
 *   - Ambos tenants tienen paid_until válido (NULL o >= hoy)
 *
 * Devuelve:
 *   { ok: true, sellerTenant, buyerTenant }  ← happy path
 *   { ok: false, error: '<reason>' }          ← cualquier falla
 *
 * El caller mapea reason → status code + mensaje. Reasons posibles:
 *   - 'partnership_not_active'
 *   - 'caller_not_in_partnership'
 *   - 'seller_suspended', 'buyer_suspended'
 *   - 'seller_expired',    'buyer_expired'
 *
 * @param {object} client — pg client con BYPASSRLS (adminQuery)
 * @param {object} partnership — fila completa de tenant_partnerships
 * @param {number} sellerTenantId — el caller (que crea la venta)
 * @returns {Promise<object>}
 */
async function validateOperationPrecondition(client, partnership, sellerTenantId) {
  if (!partnership || partnership.status !== 'active') {
    return { ok: false, error: 'partnership_not_active' };
  }
  if (sellerTenantId !== partnership.tenant_a_id && sellerTenantId !== partnership.tenant_b_id) {
    // Defensa en depth — getActivePartnershipById ya filtra por tenant del
    // caller. Si llegamos acá con un tenant ajeno, es un bug grave.
    return { ok: false, error: 'caller_not_in_partnership' };
  }

  const buyerTenantId = partnership.tenant_a_id === sellerTenantId
    ? partnership.tenant_b_id
    : partnership.tenant_a_id;

  // Lookup de ambos tenants en una query.
  const { rows } = await client.query(
    `SELECT id, nombre, slug, plan, suspended_at, paid_until
       FROM tenants
      WHERE id = ANY($1::int[])`,
    [[sellerTenantId, buyerTenantId]]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seller = byId.get(sellerTenantId);
  const buyer  = byId.get(buyerTenantId);

  if (!seller || seller.suspended_at) return { ok: false, error: 'seller_suspended' };
  if (!buyer  || buyer.suspended_at)  return { ok: false, error: 'buyer_suspended' };

  // paid_until vs hoy (date-only). NULL = grandfathered = activo (mismo
  // criterio que lib/tenantStatus.js).
  const today = new Date(new Date().toISOString().slice(0, 10));
  if (seller.paid_until != null && new Date(seller.paid_until) < today) {
    return { ok: false, error: 'seller_expired' };
  }
  if (buyer.paid_until != null && new Date(buyer.paid_until) < today) {
    return { ok: false, error: 'buyer_expired' };
  }

  return { ok: true, sellerTenant: seller, buyerTenant: buyer };
}

/**
 * Auto-create de un producto en el catálogo del BUYER con flag
 * pending_cross_tenant_review=true.
 *
 * @deprecated PR-D #463: usar findOrCreateBuyerProductos (plural) para bulk.
 * Esta versión singular hace N round-trips si se llama en loop (N+1 perf bug).
 * Se mantiene para compat por si reaparece un caller — el caller real
 * (operations.js POST /operations) ya migró a la bulk.
 *
 * F3 decisión #2 fuera del doc: SIEMPRE crea un producto nuevo, sin dedup
 * por nombre. Razones documentadas abajo en findOrCreateBuyerProductos.
 *
 * IMPORTANTE: el caller DEBE haber hecho SET LOCAL app.current_tenant =
 * buyerTenantId ANTES de invocar este helper — el INSERT respeta el FORCE
 * RLS de productos.
 *
 * @param {object} client — pg client bajo SET LOCAL del buyer tenant
 * @param {number} buyerTenantId — el receptor del producto
 * @param {object} sellerProducto — { nombre, descripcion?, costo_usd, cantidad }
 * @returns {Promise<number>} buyer_producto_id
 */
async function findOrCreateBuyerProducto(client, buyerTenantId, sellerProducto) {
  const { rows } = await client.query(
    `INSERT INTO productos (
        tenant_id, nombre, costo, costo_moneda, precio_venta, precio_moneda,
        cantidad, observaciones, pending_cross_tenant_review
     ) VALUES (
        $1, $2, $3, 'USD', $3, 'USD',
        $4, $5, true
     ) RETURNING id`,
    [
      buyerTenantId,
      sellerProducto.nombre,
      round2(Number(sellerProducto.costo_usd) || 0),
      Number(sellerProducto.cantidad) || 0,
      sellerProducto.descripcion || null,
    ]
  );
  return rows[0].id;
}

/**
 * PR-D #463 — versión BULK del auto-create. Crea N productos en el catálogo
 * del BUYER en UN solo round-trip, preservando el orden del input.
 *
 * F3 decisión #2 fuera del doc: SIEMPRE crea un producto nuevo por item,
 * sin dedup por nombre. Razones:
 *   - El doc original menciona "dedup por (nombre, descripcion, partner)"
 *     como mitigación de 9.3, pero F3 prioriza simplicidad y atomicidad.
 *     Si el buyer recibe N ventas del mismo SKU del seller, va a tener N
 *     productos pending — el endpoint merge-into de F2 ya lo resuelve con
 *     un click.
 *   - Si dedupeáramos acá, tendríamos que decidir qué pasa con stock (suma?
 *     reemplaza?), qué pasa si el buyer ya mergeo uno (el "duplicado pending"
 *     reaparecería?), etc. Esa lógica se difiere con feedback real.
 *
 * IMPORTANTE: el caller DEBE haber hecho SET LOCAL app.current_tenant =
 * buyerTenantId ANTES — el INSERT respeta el FORCE RLS de productos.
 *
 * ORDEN PRESERVADO (estrategia PR-D, OPCIÓN A del plan):
 *   Usamos `UNNEST(...) WITH ORDINALITY` para dar a cada input un índice
 *   estable, después `INSERT INTO productos ... SELECT ... ORDER BY ord
 *   RETURNING id`, y mapeamos el orden via `ROW_NUMBER() OVER ()` sobre el
 *   RETURNING dentro del mismo CTE.
 *
 *   PostgreSQL no garantiza FORMALMENTE el orden de filas en RETURNING para
 *   INSERT...SELECT (https://www.postgresql.org/docs/current/sql-insert.html
 *   no menciona orden de output), PERO en la práctica el planner ejecuta
 *   single-process en TX y devuelve las filas en el mismo orden en que las
 *   evaluó del SELECT con ORDER BY. Esta es la observación estable
 *   discutida en pgsql-hackers y verificada en testing exhaustivo.
 *
 *   El test bulk-orden incluido en redB2b-operations.test.js valida
 *   empíricamente esta asunción con 10 items distintos.
 *
 *   Si en el futuro pgsql cambia este comportamiento, el test fallaría y
 *   migraríamos a estrategia "match por nombre + costo" (más compleja
 *   pero formalmente correcta).
 *
 * Campos insertados (mismos defaults que la versión singular):
 *   - costo = costo_usd del seller, costo_moneda='USD'.
 *     Decisión #4 doc: TC siempre lo define el seller. Stock que entra al
 *     buyer queda valuado en USD (moneda neutra interna).
 *   - precio_venta = costo_usd también (el buyer lo edita después).
 *   - cantidad = lo que el seller le mandó.
 *   - estado='disponible' (default), trackear_stock=true (default).
 *   - pending_cross_tenant_review=true.
 *
 * @param {object} client — pg client bajo SET LOCAL del buyer tenant
 * @param {number} buyerTenantId
 * @param {Array<object>} items — [{ nombre, descripcion?, costo_usd, cantidad }, ...]
 * @returns {Promise<Array<number>>} buyer_producto_id en MISMO orden que input
 */
async function findOrCreateBuyerProductos(client, buyerTenantId, items) {
  if (!items || items.length === 0) return [];

  const sql = `
    WITH input AS (
      SELECT u.ord, u.nombre, u.descripcion, u.costo_usd, u.cantidad
        FROM UNNEST($2::text[], $3::text[], $4::numeric[], $5::numeric[])
             WITH ORDINALITY AS u(nombre, descripcion, costo_usd, cantidad, ord)
    ),
    ins AS (
      INSERT INTO productos (
        tenant_id, nombre, costo, costo_moneda, precio_venta, precio_moneda,
        cantidad, observaciones, pending_cross_tenant_review
      )
      SELECT $1, i.nombre, ROUND(i.costo_usd::numeric, 2), 'USD',
             ROUND(i.costo_usd::numeric, 2), 'USD',
             i.cantidad, i.descripcion, true
        FROM input i
        ORDER BY i.ord
      RETURNING id
    )
    SELECT id, ROW_NUMBER() OVER () AS ord FROM ins ORDER BY ord
  `;
  const { rows } = await client.query(sql, [
    buyerTenantId,
    items.map((it) => it.nombre),
    items.map((it) => it.descripcion || null),
    items.map((it) => round2(Number(it.costo_usd) || 0)),
    items.map((it) => Number(it.cantidad) || 0),
  ]);
  return rows.map((r) => Number(r.id));
}

/**
 * Crea la venta B2B del lado SELLER usando el módulo Cuentas Corrientes.
 *
 * IMPORTANTE: el caller DEBE haber hecho SET LOCAL app.current_tenant =
 * sellerTenantId. Decrementa stock atómicamente (UPDATE WHERE cantidad >=
 * pedida) y lanza error si alguno no alcanza — el caller debe ROLLBACK.
 *
 * El módulo CC del repo (routes/cuentas.js) usa:
 *   - movimientos_cc: row maestra con tipo='compra' (= venta nuestra a ese
 *     cliente), monto_total en USD, estado='acreditado'|'pendiente'.
 *   - items_movimiento_cc: line items con producto_id + cantidad + valor +
 *     costo_unit + costo_moneda.
 *   - clientes_cc: el cliente B2B. Para cross-tenant SIEMPRE el seller tiene
 *     un cliente_cc dedicado al buyer (se busca por nombre del buyer; si no
 *     existe, se crea on-the-fly).
 *
 * Decisión #3 fuera del doc: el cliente_cc del seller para representar al
 * buyer partner se crea on-the-fly si no existe (idempotente por nombre).
 * F4 podría agregar una marca `linked_tenant_id` análoga a contactos.
 *
 * Stock: decrement atómico con guard `cantidad >= u.cant` — race-safe
 * (mismo patrón que routes/cuentas.js#L706-748). Si rowCount < items con
 * stock, throw `Error('stock_insufficient')` con metadata. El caller hace
 * ROLLBACK.
 *
 * @param {object} client — pg client bajo SET LOCAL del seller tenant
 * @param {number} sellerTenantId
 * @param {object} args — { items, tc, total_usd, total_ars, notes, callerUserId, buyerTenant }
 * @returns {Promise<{ movimientoCcId, clienteCcId, productosUsados }>}
 */
async function createSellerVenta(client, sellerTenantId, args) {
  // tc viene en args para futura columna en items (F4 multi-divisa
  // bilateral); por ahora no se persiste — el seller fija TC pero los
  // valores se guardan en USD (moneda neutra interna). El TC se rescata
  // del cross_tenant_operations.tc_used en F4.
  const { items, total_usd, notes, callerUserId, buyerTenant } = args;

  // ── 1. Resolver cliente_cc del seller para este partner ───────────────────
  // Buscar uno con el mismo nombre. Si no existe, crear.
  // Idempotente: si hay varios partners con el mismo nombre en ESTE tenant,
  // usamos el primero. La UNIQUE (tenant_id, LOWER(nombre)) de la migration
  // 20260711170000_... previene el escenario en el futuro.
  // 2026-07-11 (auditoría Red B2B P0-1): filtro `AND tenant_id = $1` inline.
  // Antes, el SELECT sin filtro tenant podía devolver el id de un cliente_cc
  // de OTRO tenant con el mismo nombre → contabilidad cross-tenant contaminada
  // (adminQuery bypassea RLS y el SET LOCAL no filtra en el WHERE).
  const buyerName = buyerTenant.nombre;
  const lookupQ = await client.query(
    `SELECT id FROM clientes_cc
       WHERE tenant_id = $1
         AND LOWER(nombre) = LOWER($2)
         AND deleted_at IS NULL
       LIMIT 1`,
    [sellerTenantId, buyerName]
  );
  let clienteCcId = lookupQ.rows[0]?.id;
  if (!clienteCcId) {
    const insQ = await client.query(
      `INSERT INTO clientes_cc (tenant_id, nombre, categoria, notas)
       VALUES ($1, $2, 'A-', $3)
       RETURNING id`,
      [
        sellerTenantId,
        buyerName,
        `Cliente Red B2B auto-creado al hacer la primera venta cross-tenant (partner tenant id=${buyerTenant.id}).`,
      ]
    );
    clienteCcId = insQ.rows[0].id;
  }

  // ── 2. Validar productos pertenecen al seller (defensa en depth) ──────────
  // RLS de productos ya filtra por tenant_id = app.current_tenant, pero
  // chequeamos explícito para devolver 404 limpio si alguno no existe.
  const prodIds = items.map((it) => Number(it.producto_id));
  const prodsQ = await client.query(
    `SELECT id, nombre, observaciones, cantidad, costo, costo_moneda
       FROM productos
      WHERE id = ANY($1::int[]) AND deleted_at IS NULL
      ORDER BY id`,
    [prodIds]
  );
  const prodMap = new Map(prodsQ.rows.map((p) => [Number(p.id), p]));
  for (const it of items) {
    if (!prodMap.get(Number(it.producto_id))) {
      const e = new Error('producto_not_found');
      e.reason = 'producto_not_found';
      e.detail = { producto_id: it.producto_id };
      throw e;
    }
  }

  // ── 3. Stock decrement atómico (UPDATE WHERE cantidad >= u.cant) ─────────
  // Sin SELECT FOR UPDATE previo — el UPDATE atómico es el guard real
  // (mismo patrón que routes/cuentas.js POST /movimientos).
  // Dedup interno de producto_id (cantidad sumada) NO se hace acá: el caller
  // valida con Zod min(1) pero no enforcea unicidad de producto_id (un mismo
  // SKU en 2 line items es legítimo). Sumamos las cantidades antes del UPDATE.
  const qtyByProd = new Map();
  for (const it of items) {
    const pid = Number(it.producto_id);
    qtyByProd.set(pid, (qtyByProd.get(pid) || 0) + Number(it.cantidad));
  }
  const decPids = [...qtyByProd.keys()].sort((a, b) => a - b); // ordered to avoid deadlock
  const decQtys = decPids.map((p) => qtyByProd.get(p));

  const updRes = await client.query(
    `UPDATE productos p SET
        cantidad = p.cantidad - u.cant,
        estado = CASE
          WHEN p.cantidad - u.cant <= 0 THEN 'vendido'
          ELSE p.estado
        END
      FROM UNNEST($1::int[], $2::int[]) AS u(pid, cant)
      WHERE p.id = u.pid AND p.tenant_id = $3 AND p.cantidad >= u.cant`,
    [decPids, decQtys, sellerTenantId]
  );

  if (updRes.rowCount !== decPids.length) {
    // Identificar qué producto faltó — útil para mensaje claro.
    const insuf = [];
    for (const [pid, qty] of qtyByProd.entries()) {
      const p = prodMap.get(pid);
      if (!p) continue;
      if (Number(p.cantidad) < qty) {
        insuf.push({ producto_id: pid, nombre: p.nombre, disponible: p.cantidad, pedido: qty });
      }
    }
    const e = new Error('stock_insufficient');
    e.reason = 'stock_insufficient';
    e.detail = { faltantes: insuf };
    throw e;
  }

  // ── 4. INSERT movimientos_cc (la "venta B2B") ────────────────────────────
  // Campo descripcion incluye marca "Red B2B" + nombre del partner para que
  // sea identificable en el listado de movimientos del cliente_cc.
  const descripcion = `Red B2B → ${buyerTenant.nombre}${notes ? ` — ${notes.slice(0, 200)}` : ''}`;
  const movQ = await client.query(
    `INSERT INTO movimientos_cc
       (tenant_id, cliente_cc_id, fecha, tipo, descripcion, monto_total,
        notas, caja_id, created_by_user_id, estado)
     VALUES ($1, $2, CURRENT_DATE, 'compra', $3, $4,
             $5, NULL, $6, 'pendiente')
     RETURNING id`,
    [
      sellerTenantId,
      clienteCcId,
      descripcion,
      round2(Number(total_usd)),
      notes || null,
      callerUserId,
    ]
  );
  const movimientoCcId = movQ.rows[0].id;

  // ── 5. INSERT items_movimiento_cc (line items) ───────────────────────────
  // Bulk INSERT con UNNEST (mismo patrón que routes/cuentas.js).
  // precio (valor) = precio_usd del item × cantidad. costo_unit snapshot
  // del producto al momento de la venta (igual que CC normal).
  // tc: para tracking, lo guardamos en `notas` del item (no hay columna tc
  // en items_movimiento_cc; F4+ podría extender el schema).
  const itemValues = items.map((it) => {
    const p = prodMap.get(Number(it.producto_id));
    return {
      producto: p.nombre,
      imei_serial: null,
      valor: round2(Number(it.precio_usd) * Number(it.cantidad)),
      cantidad: Number(it.cantidad),
      producto_id: Number(it.producto_id),
      costo_unit: Number(p.costo) || 0,
      costo_moneda: p.costo_moneda || 'USD',
    };
  });
  await client.query(
    `INSERT INTO items_movimiento_cc
       (tenant_id, movimiento_cc_id, producto, imei_serial, valor, cantidad,
        producto_id, costo_unit, costo_moneda)
     SELECT $1, $2, p, i, v, cant, pid, cu, cm
       FROM UNNEST(
         $3::text[], $4::text[], $5::numeric[], $6::int[],
         $7::int[], $8::numeric[], $9::text[]
       ) AS u(p, i, v, cant, pid, cu, cm)`,
    [
      sellerTenantId,
      movimientoCcId,
      itemValues.map((x) => x.producto),
      itemValues.map((x) => x.imei_serial),
      itemValues.map((x) => x.valor),
      itemValues.map((x) => x.cantidad),
      itemValues.map((x) => x.producto_id),
      itemValues.map((x) => x.costo_unit),
      itemValues.map((x) => x.costo_moneda),
    ]
  );

  return {
    movimientoCcId,
    clienteCcId,
    productosUsados: itemValues.map((x) => ({ producto_id: x.producto_id, cantidad: x.cantidad })),
  };
}

/**
 * Crea la compra a proveedor del lado BUYER usando el módulo Proveedores.
 *
 * IMPORTANTE: el caller DEBE haber hecho SET LOCAL app.current_tenant =
 * buyerTenantId ANTES. Incrementa stock atómico (UPDATE) en los productos
 * auto-creados con findOrCreateBuyerProducto.
 *
 * Estructura del módulo Proveedores (routes/proveedores.js):
 *   - proveedor_movimientos: row maestra con tipo='compra', monto en USD,
 *     monto_usd persistido.
 *   - proveedor_movimiento_items: line items (producto, valor, cantidad).
 *   - proveedores: el partner aparece como un proveedor. Se busca por
 *     nombre del seller; si no existe, se crea on-the-fly.
 *
 * Decisión análoga a #3: el proveedor del buyer para representar al seller
 * partner se crea on-the-fly (idempotente por nombre).
 *
 * Stock: increment SIN guard — el producto del buyer fue recién creado o
 * matcheado, no hay race con vendas concurrentes (en F3 buyer no puede
 * vender ese stock todavía; solo va a Pendientes de Revisión).
 *
 * @param {object} client — pg client bajo SET LOCAL del buyer tenant
 * @param {number} buyerTenantId
 * @param {object} args — { items (con buyer_producto_id), total_usd, notes, callerUserId, sellerTenant, mappedItems }
 *                  mappedItems: [{ seller_producto_id, buyer_producto_id, cantidad, precio_usd, nombre }]
 * @returns {Promise<{ proveedorMovimientoId, proveedorId }>}
 */
async function createBuyerCompra(client, buyerTenantId, args) {
  const { mappedItems, total_usd, notes, callerUserId, sellerTenant } = args;

  // ── 1. Resolver proveedor del buyer para este partner ────────────────────
  // 2026-07-11 (auditoría Red B2B P0-1): filtro `AND tenant_id = $1` inline.
  // Ver comentario en createSellerVenta arriba — mismo bug, mismo fix.
  const sellerName = sellerTenant.nombre;
  const lookupQ = await client.query(
    `SELECT id FROM proveedores
       WHERE tenant_id = $1
         AND LOWER(nombre) = LOWER($2)
         AND deleted_at IS NULL
       LIMIT 1`,
    [buyerTenantId, sellerName]
  );
  let proveedorId = lookupQ.rows[0]?.id;
  if (!proveedorId) {
    const insQ = await client.query(
      `INSERT INTO proveedores (tenant_id, nombre, notas)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [
        buyerTenantId,
        sellerName,
        `Proveedor Red B2B auto-creado al recibir la primera compra cross-tenant (partner tenant id=${sellerTenant.id}).`,
      ]
    );
    proveedorId = insQ.rows[0].id;
  }

  // ── 2. INSERT proveedor_movimientos ───────────────────────────────────────
  const descripcion = `Red B2B ← ${sellerTenant.nombre}${notes ? ` — ${notes.slice(0, 200)}` : ''}`;
  const movQ = await client.query(
    `INSERT INTO proveedor_movimientos
       (tenant_id, proveedor_id, fecha, tipo, descripcion, monto, moneda, tc,
        monto_usd, caja_id, notas, created_by_user_id)
     VALUES ($1, $2, CURRENT_DATE, 'compra', $3, $4, 'USD', NULL,
             $4, NULL, $5, $6)
     RETURNING id`,
    [
      buyerTenantId,
      proveedorId,
      descripcion,
      round2(Number(total_usd)),
      notes || null,
      callerUserId,
    ]
  );
  const proveedorMovimientoId = movQ.rows[0].id;

  // ── 3. INSERT proveedor_movimiento_items (bulk con UNNEST) ────────────────
  // proveedor_movimiento_items NO tiene producto_id (FK a productos) — solo
  // guarda el nombre del producto en texto + serial + valor. Los productos
  // del buyer (con pending_cross_tenant_review=true) se crean aparte por
  // findOrCreateBuyerProducto y se trackean en cross_tenant_operation_items.
  await client.query(
    `INSERT INTO proveedor_movimiento_items
       (tenant_id, proveedor_movimiento_id, producto, valor)
     SELECT $1, $2, p, v
       FROM UNNEST($3::text[], $4::numeric[]) AS u(p, v)`,
    [
      buyerTenantId,
      proveedorMovimientoId,
      mappedItems.map((x) => x.nombre),
      mappedItems.map((x) => round2(Number(x.precio_usd) * Number(x.cantidad))),
    ]
  );

  // ── 4. Increment stock de los productos auto-creados del buyer ────────────
  // No es atómico ni necesita guard — los productos fueron recién creados
  // con cantidad inicial = cantidad del item. Pero por consistencia con
  // los demás módulos, hacemos UPDATE explícito + reiniciar estado.
  //
  // En realidad findOrCreateBuyerProducto YA inserta con la cantidad correcta,
  // así que NO hay que sumar más. Esta función deja el stock al valor inicial.
  // Si en F4+ se agrega dedup (buscar match en lugar de crear), entonces
  // SÍ habría que sumar — lo dejamos preparado pero no-op por ahora.

  return { proveedorMovimientoId, proveedorId };
}

module.exports = {
  validateOperationPrecondition,
  findOrCreateBuyerProducto,   // @deprecated PR-D #463 — usar plural bulk
  findOrCreateBuyerProductos,
  createSellerVenta,
  createBuyerCompra,
};

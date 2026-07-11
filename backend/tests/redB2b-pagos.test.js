/**
 * Tests integration para Red B2B F4 — pagos + conciliación + devoluciones.
 *
 * Cobertura (20+ tests críticos):
 *
 *   Capability gate (1):
 *     · sin cross_tenant.write → 403 en POST /pagos
 *
 *   Happy path POST /pagos (4):
 *     · seller registra cobro → INSERT mov_cc tipo='pago' del seller +
 *       proveedor_mov tipo='pago' propagado al buyer + cross_tenant_pago +
 *       notif al buyer
 *     · buyer registra pago → análogo, cobro propagado al seller
 *     · pago parcial actualiza saldo restante (saldo > 0)
 *     · pago completo deja saldo 0 (completo=true)
 *
 *   Multi-divisa (4 críticos #16):
 *     · pago USD/USD tc=tc → diferencia=0, sin cambio_divisa_id
 *     · pago ARS tc_pago=tc_venta → diferencia=0, sin cambio_divisa_id
 *     · pago ARS tc_pago > tc_venta → diferencia positiva, cambio_divisa_id NOT NULL
 *     · pago ARS tc_pago < tc_venta → diferencia negativa, cambio_divisa_id NOT NULL
 *
 *   Validation (3):
 *     · sobre-pago (monto > restante) → 400 overpayment
 *     · op cancelled → 409
 *     · side body !== caller real side → 403 side_mismatch
 *
 *   Conciliation (1):
 *     · GET /conciliation devuelve saldos coherentes (sin diff)
 *       (PR-D #463: cache in-memory eliminado — multi-instance bug + frecuencia
 *       de hit baja. Cada GET recomputa fresh. Tests legacy de cache borrados.)
 *
 *   Devolución (4):
 *     · devolución parcial revierte stock + crea nueva op con parent_op_id
 *     · devolución supera lo pagado → queda saldo a favor del buyer
 *     · solo buyer puede devolución (seller → 403)
 *     · devolución con cantidad > disponible → 400
 *
 *   RLS leak (2):
 *     · Tenant C intenta POST /pagos en op A↔B → 404
 *     · Tenant C intenta GET /conciliation A↔B → 404
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');
// PR-D #463: conciliation ya no tiene cache — no requiere helper de clear.

const TENANT_A = { slug: 'red-b2b-pago-test-a', nombre: 'RedB2B Pago Test A', plan: 'starter' };
const TENANT_B = { slug: 'red-b2b-pago-test-b', nombre: 'RedB2B Pago Test B', plan: 'pro' };
const TENANT_C = { slug: 'red-b2b-pago-test-c', nombre: 'RedB2B Pago Test C', plan: 'starter' };

let pool;
let tenantAId, tenantBId, tenantCId;
let userAId, userBId, userCId, userANoCapId;
let tokenA, tokenB, tokenC, tokenANoCap;
// SEG-1 (audit 2026-07-06): cajas per-tenant. Antes el test asumía que
// `metodos_pago` era catálogo global y tomaba cualquier caja del DB —
// precisamente el bug que estamos parchando. Ahora creamos cajas propias
// para cada tenant y usamos las de A por default (la caller de casi todos
// los tests). Los pocos tests con tokenB/tokenC usan las de B/C
// explícitamente.
let cajaArsId, cajaUsdId;         // shortcuts a las de tenantA
let cajaArsAId, cajaUsdAId;
let cajaArsBId, cajaUsdBId;
let cajaArsCId, cajaUsdCId;

function signToken({ id, username, email, tenant_id, caps = {} }) {
  return jwt.sign(
    {
      id, username, email,
      role: 'op',
      tenant_id,
      tenant_rol: 'admin',
      tenant_cap_rol: 'custom',
      caps,
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

async function createTenant({ slug, nombre, plan }) {
  const r = await pool.query(
    `INSERT INTO tenants (nombre, slug, plan) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre, plan = EXCLUDED.plan,
       suspended_at = NULL, red_b2b_caja_default_id = NULL
     RETURNING id`,
    [nombre, slug, plan]
  );
  return r.rows[0].id;
}

async function createUserForTenant(tenantId, { username, email }) {
  const hash = await bcrypt.hash('testpass1234', 10);
  const u = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
     VALUES ($1, $2, $3, $4, 'op', NOW()) RETURNING id`,
    [username, username, email, hash]
  );
  const userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'admin')
     ON CONFLICT DO NOTHING`,
    [tenantId, userId]
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${tenantId}`);
    await client.query(
      `INSERT INTO tenant_user_roles (tenant_id, user_id, rol) VALUES ($1, $2, 'custom')
       ON CONFLICT DO NOTHING`,
      [tenantId, userId]
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  return userId;
}

async function insertSellerProducto(tenantId, opts = {}) {
  const { nombre = `Producto Test ${Date.now()}`, cantidad = 10, costo = 100, precio = 150 } = opts;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${tenantId}`);
    const r = await client.query(
      `INSERT INTO productos
         (tenant_id, nombre, cantidad, costo, costo_moneda, precio_venta, precio_moneda, estado)
       VALUES ($1, $2, $3, $4, 'USD', $5, 'USD', 'disponible')
       RETURNING id`,
      [tenantId, nombre, cantidad, costo, precio]
    );
    await client.query('COMMIT');
    return r.rows[0].id;
  } finally {
    client.release();
  }
}

async function createActivePartnership(t1, t2, invitedBy) {
  const [a, b] = t1 < t2 ? [t1, t2] : [t2, t1];
  const r = await pool.query(
    `INSERT INTO tenant_partnerships
       (tenant_a_id, tenant_b_id, status,
        invited_by_tenant_id, invited_by_user_id,
        accepted_by_user_id, accepted_at)
     VALUES ($1, $2, 'active', $3, $4, $4, NOW())
     RETURNING id`,
    [a, b, invitedBy, userAId]
  );
  return r.rows[0].id;
}

/**
 * Crea una operación cross-tenant directa en DB (sin pasar por POST endpoint,
 * que ya está testeado en F3). Devuelve { opId, sellerVentaId, buyerCompraId,
 * itemIds, prodSellerId, prodBuyerId }.
 */
async function createCrossOp({ sellerTenantId, buyerTenantId, partnershipId,
                                cantidad = 2, precio_usd = 100, tc = 1000 }) {
  const total_usd = cantidad * precio_usd;
  const total_ars = total_usd * tc;
  const prodSellerId = await insertSellerProducto(sellerTenantId, {
    nombre: `Prod Test ${Date.now()}`,
    cantidad: cantidad + 5, // extra stock
    costo: precio_usd * 0.8,
  });

  // Insert producto buyer auto-created (con flag pending) directo en DB.
  const client = await pool.connect();
  let prodBuyerId, opId, sellerMovId, buyerMovId;
  try {
    await client.query('BEGIN');
    // ── Producto buyer ──
    await client.query(`SET LOCAL app.current_tenant = ${buyerTenantId}`);
    const pbQ = await client.query(
      `INSERT INTO productos
         (tenant_id, nombre, cantidad, costo, costo_moneda, precio_venta, precio_moneda,
          estado, pending_cross_tenant_review)
       VALUES ($1, $2, $3, $4, 'USD', $4, 'USD', 'disponible', true)
       RETURNING id`,
      [buyerTenantId, `Prod Buyer ${Date.now()}`, cantidad, precio_usd]
    );
    prodBuyerId = pbQ.rows[0].id;

    // ── cliente_cc del seller ──
    await client.query(`SET LOCAL app.current_tenant = ${sellerTenantId}`);
    const ccQ = await client.query(
      `INSERT INTO clientes_cc (tenant_id, nombre, categoria)
       VALUES ($1, 'B2B Partner Test', 'A-')
       RETURNING id`,
      [sellerTenantId]
    );
    const clienteCcId = ccQ.rows[0].id;

    // ── movimientos_cc del seller (venta CC) ──
    const movQ = await client.query(
      `INSERT INTO movimientos_cc
         (tenant_id, cliente_cc_id, fecha, tipo, descripcion, monto_total, estado, created_by_user_id)
       VALUES ($1, $2, CURRENT_DATE, 'compra', 'Test cross-tenant', $3, 'pendiente', $4)
       RETURNING id`,
      [sellerTenantId, clienteCcId, total_usd, userAId]
    );
    sellerMovId = movQ.rows[0].id;

    // Decrement seller stock.
    await client.query(
      `UPDATE productos SET cantidad = cantidad - $1 WHERE id = $2 AND tenant_id = $3`,
      [cantidad, prodSellerId, sellerTenantId]
    );

    // ── proveedor del buyer ──
    await client.query(`SET LOCAL app.current_tenant = ${buyerTenantId}`);
    const pvQ = await client.query(
      `INSERT INTO proveedores (tenant_id, nombre)
       VALUES ($1, 'B2B Seller Test')
       RETURNING id`,
      [buyerTenantId]
    );
    const proveedorId = pvQ.rows[0].id;

    // ── proveedor_movimientos (compra) ──
    const pmQ = await client.query(
      `INSERT INTO proveedor_movimientos
         (tenant_id, proveedor_id, fecha, tipo, descripcion, monto, moneda, monto_usd, created_by_user_id)
       VALUES ($1, $2, CURRENT_DATE, 'compra', 'Test cross-tenant', $3, 'USD', $3, $4)
       RETURNING id`,
      [buyerTenantId, proveedorId, total_usd, userAId]
    );
    buyerMovId = pmQ.rows[0].id;

    // ── cross_tenant_operations + items + UPDATE links ──
    const opQ = await client.query(
      `INSERT INTO cross_tenant_operations
         (partnership_id, seller_tenant_id, buyer_tenant_id,
          seller_venta_id, buyer_compra_id,
          total_usd, total_ars, tc_used, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [partnershipId, sellerTenantId, buyerTenantId, sellerMovId, buyerMovId,
       total_usd, total_ars, tc, userAId]
    );
    opId = opQ.rows[0].id;

    const itemsQ = await client.query(
      `INSERT INTO cross_tenant_operation_items
         (cross_tenant_operation_id, seller_producto_id, buyer_producto_id,
          cantidad, precio_unitario_usd, precio_unitario_ars)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [opId, prodSellerId, prodBuyerId, cantidad, precio_usd, precio_usd * tc]
    );
    const itemId = itemsQ.rows[0].id;

    // Link mov_cc + proveedor_mov.
    await client.query(`SET LOCAL app.current_tenant = ${sellerTenantId}`);
    await client.query(
      `UPDATE movimientos_cc SET cross_tenant_operation_id = $1 WHERE id = $2`,
      [opId, sellerMovId]
    );
    await client.query(`SET LOCAL app.current_tenant = ${buyerTenantId}`);
    await client.query(
      `UPDATE proveedor_movimientos SET cross_tenant_operation_id = $1 WHERE id = $2`,
      [opId, buyerMovId]
    );

    await client.query('COMMIT');
    return { opId, sellerMovId, buyerMovId, itemId, prodSellerId, prodBuyerId, total_usd, total_ars, tc };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  // setupTestDb depends on tenant_id=1 existing (re-seeds config.tenant_id=1
  // after TRUNCATE). The original migration inserts tenant 1, but if a
  // previous test run wiped it, setup fails. We need to bootstrap BEFORE
  // setupTestDb. Since TRUNCATE users CASCADE doesn't normally remove
  // tenants, the previous failure is likely from another suite's afterAll
  // that DELETE'd it. Make this idempotent for resilience.
  const { Pool } = require('pg');
  const bootstrapPool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await bootstrapPool.query(
      `INSERT INTO tenants (id, nombre, slug, plan) VALUES (1, 'Tecny', 'tecny', 'enterprise')
         ON CONFLICT (id) DO UPDATE SET nombre = 'Tecny', deleted_at = NULL`
    );
    await bootstrapPool.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1))`);
  } catch (e) {
    // If tenants table doesn't exist yet (fresh DB) — fine, setupTestDb's
    // migrate will create it + insert tenant 1.
  }
  await bootstrapPool.end();

  pool = await setupTestDb();

  tenantAId = await createTenant(TENANT_A);
  tenantBId = await createTenant(TENANT_B);
  tenantCId = await createTenant(TENANT_C);

  userAId = await createUserForTenant(tenantAId, {
    username: 'rb2b-pago-user-a', email: 'rb2b-pago-a@test.local',
  });
  userBId = await createUserForTenant(tenantBId, {
    username: 'rb2b-pago-user-b', email: 'rb2b-pago-b@test.local',
  });
  userCId = await createUserForTenant(tenantCId, {
    username: 'rb2b-pago-user-c', email: 'rb2b-pago-c@test.local',
  });
  userANoCapId = await createUserForTenant(tenantAId, {
    username: 'rb2b-pago-user-a-nocap', email: 'rb2b-pago-a-nocap@test.local',
  });

  const capsOn = { 'cross_tenant.write': true };
  tokenA = signToken({
    id: userAId, username: 'rb2b-pago-user-a', email: 'rb2b-pago-a@test.local',
    tenant_id: tenantAId, caps: capsOn,
  });
  tokenB = signToken({
    id: userBId, username: 'rb2b-pago-user-b', email: 'rb2b-pago-b@test.local',
    tenant_id: tenantBId, caps: capsOn,
  });
  tokenC = signToken({
    id: userCId, username: 'rb2b-pago-user-c', email: 'rb2b-pago-c@test.local',
    tenant_id: tenantCId, caps: capsOn,
  });
  tokenANoCap = signToken({
    id: userANoCapId, username: 'rb2b-pago-user-a-nocap',
    email: 'rb2b-pago-a-nocap@test.local',
    tenant_id: tenantAId, caps: {},
  });

  // SEG-1 (audit 2026-07-06): seed cajas per-tenant.
  async function seedCajas(tId, suffix) {
    const ars = await pool.query(
      `INSERT INTO metodos_pago (tenant_id, nombre, moneda, activo)
       VALUES ($1, $2, 'ARS', true) RETURNING id`,
      [tId, `RB2B-Pago ${suffix} ARS`]
    );
    const usd = await pool.query(
      `INSERT INTO metodos_pago (tenant_id, nombre, moneda, activo)
       VALUES ($1, $2, 'USD', true) RETURNING id`,
      [tId, `RB2B-Pago ${suffix} USD`]
    );
    return { ars: ars.rows[0].id, usd: usd.rows[0].id };
  }
  const [ca, cb, cc] = await Promise.all([
    seedCajas(tenantAId, 'A'),
    seedCajas(tenantBId, 'B'),
    seedCajas(tenantCId, 'C'),
  ]);
  cajaArsAId = ca.ars; cajaUsdAId = ca.usd;
  cajaArsBId = cb.ars; cajaUsdBId = cb.usd;
  cajaArsCId = cc.ars; cajaUsdCId = cc.usd;
  // Aliases retro-compat: casi todos los tests usan tokenA → cajas de A.
  cajaArsId = cajaArsAId;
  cajaUsdId = cajaUsdAId;
});

beforeEach(async () => {
  const ids = [tenantAId, tenantBId, tenantCId];

  // PR-D #463: ya no hay cache que limpiar — conciliación recomputa fresh cada GET.

  // Unlink FKs first.
  await pool.query(
    `UPDATE movimientos_cc SET cross_tenant_operation_id = NULL WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `UPDATE proveedor_movimientos SET cross_tenant_operation_id = NULL WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `UPDATE productos SET created_from_cross_tenant_op_id = NULL WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );

  // Delete child rows first.
  await pool.query(`DELETE FROM cross_tenant_pagos
    WHERE cross_tenant_operation_id IN (
      SELECT id FROM cross_tenant_operations
       WHERE seller_tenant_id = ANY($1::int[]) OR buyer_tenant_id = ANY($1::int[]))`,
    [ids]);
  await pool.query(
    `DELETE FROM cross_tenant_notifications WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  // Devoluciones (parent_op_id ref) — delete those FIRST so they don't
  // block the parent op delete via FK self-ref.
  await pool.query(
    `DELETE FROM cross_tenant_operations
       WHERE parent_op_id IN (
         SELECT id FROM cross_tenant_operations
          WHERE seller_tenant_id = ANY($1::int[]) OR buyer_tenant_id = ANY($1::int[]))`,
    [ids]
  );
  await pool.query(
    `DELETE FROM cross_tenant_operations
       WHERE seller_tenant_id = ANY($1::int[]) OR buyer_tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `DELETE FROM tenant_partnerships
       WHERE tenant_a_id = ANY($1::int[]) OR tenant_b_id = ANY($1::int[])`,
    [ids]
  );

  await pool.query(`DELETE FROM cambio_movimientos WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM cambio_entidades WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM items_movimiento_cc WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM movimientos_cc WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM clientes_cc WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM proveedor_movimiento_items WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM proveedor_movimientos WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM proveedores WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM productos WHERE tenant_id = ANY($1::int[])`, [ids]);

  await pool.query(
    `UPDATE tenants SET suspended_at = NULL, paid_until = NULL,
                        red_b2b_caja_default_id = NULL
       WHERE id = ANY($1::int[])`,
    [ids]
  );
});

afterAll(async () => {
  const ids = [tenantAId, tenantBId, tenantCId];
  const userIds = [userAId, userBId, userCId, userANoCapId];

  await pool.query(
    `UPDATE movimientos_cc SET cross_tenant_operation_id = NULL WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `UPDATE proveedor_movimientos SET cross_tenant_operation_id = NULL WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `UPDATE productos SET created_from_cross_tenant_op_id = NULL WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(`DELETE FROM cross_tenant_pagos
    WHERE cross_tenant_operation_id IN (
      SELECT id FROM cross_tenant_operations
       WHERE seller_tenant_id = ANY($1::int[]) OR buyer_tenant_id = ANY($1::int[]))`,
    [ids]);
  await pool.query(`DELETE FROM cross_tenant_notifications WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(
    `DELETE FROM cross_tenant_operations
       WHERE parent_op_id IN (
         SELECT id FROM cross_tenant_operations
          WHERE seller_tenant_id = ANY($1::int[]) OR buyer_tenant_id = ANY($1::int[]))`,
    [ids]
  );
  await pool.query(
    `DELETE FROM cross_tenant_operations
       WHERE seller_tenant_id = ANY($1::int[]) OR buyer_tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `DELETE FROM tenant_partnerships
       WHERE tenant_a_id = ANY($1::int[]) OR tenant_b_id = ANY($1::int[])`,
    [ids]
  );

  await pool.query(`DELETE FROM cambio_movimientos WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM cambio_entidades WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM items_movimiento_cc WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM movimientos_cc WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM clientes_cc WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM proveedor_movimiento_items WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM proveedor_movimientos WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM proveedores WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM productos WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM tenant_admin_actions WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM contactos WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM user_capabilities WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM tenant_user_roles WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM tenant_users WHERE user_id = ANY($1::int[])`, [userIds]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
  // SEG-1 audit 2026-07-06: cajas per-tenant seedeadas.
  await pool.query(`DELETE FROM metodos_pago WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM tenants WHERE id = ANY($1::int[])`, [ids]);

  await teardownTestDb(pool);
});

// ──────────────────────────────────────────────────────────────────────────
// Capability gate
// ──────────────────────────────────────────────────────────────────────────
describe('cross_tenant.write gate (F4)', () => {
  it('user SIN cap → 403 en POST /pagos', async () => {
    const r = await request(app)
      .post('/api/red-b2b/operations/1/pagos')
      .set('Authorization', `Bearer ${tokenANoCap}`)
      .send({});
    expect(r.status).toBe(403);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Happy path POST /pagos
// ──────────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// 2026-07-11 (auditoría Red B2B P0-1): contaminación cross-tenant en helpers
// ensureSellerClienteCc / ensureBuyerProveedor.
//
// Escenario del bug: bajo `adminQuery` (BYPASSRLS), el `SET LOCAL
// app.current_tenant` no filtra el WHERE del SELECT. Si otro tenant tiene un
// cliente_cc/proveedor con el mismo nombre que el partner buyer, el helper
// devolvía ese `id` cross-tenant → el INSERT en movimientos_cc del seller
// quedaba con `cliente_cc_id` de otro tenant.
//
// Fix: agregar `AND tenant_id = $N` inline al SELECT (con la migration
// UNIQUE (tenant_id, LOWER(nombre)) como blindaje adicional).
// ═══════════════════════════════════════════════════════════════════════════
describe('P0-1: contaminación cross-tenant en helpers ensure* (auditoría 2026-07-11)', () => {
  let partnershipId;
  let contaminantClientCcId;
  let contaminantProveedorId;

  // El beforeEach GLOBAL (arriba en el file) limpia clientes_cc, proveedores
  // y partnerships de los 3 tenants entre CADA test. Por eso el sembrado del
  // contaminante + el partnership tienen que estar en un beforeEach del
  // describe (corre DESPUÉS del global → semilla válida cuando corre el `it`).
  beforeEach(async () => {
    // Sembrar un cliente_cc en tenant C con el MISMO nombre que tenant B.
    // Si el bug persistiera, ensureSellerClienteCc de A→B usaría ESTE id
    // (cross-tenant leak). Con el fix, debe ignorar tenant C y crear/reusar
    // uno del tenant A.
    const contamClient = await pool.connect();
    try {
      await contamClient.query('BEGIN');
      await contamClient.query(`SET LOCAL app.current_tenant = ${tenantCId}`);
      const r = await contamClient.query(
        `INSERT INTO clientes_cc (tenant_id, nombre, categoria, notas)
         VALUES ($1, $2, 'A-', 'Cliente retail SIN relación con Red B2B — semilla de test')
         RETURNING id`,
        [tenantCId, TENANT_B.nombre]
      );
      contaminantClientCcId = r.rows[0].id;
      const p = await contamClient.query(
        `INSERT INTO proveedores (tenant_id, nombre, notas)
         VALUES ($1, $2, 'Proveedor retail SIN relación con Red B2B — semilla de test')
         RETURNING id`,
        [tenantCId, TENANT_A.nombre]
      );
      contaminantProveedorId = p.rows[0].id;
      await contamClient.query('COMMIT');
    } catch (e) {
      await contamClient.query('ROLLBACK');
      throw e;
    } finally {
      contamClient.release();
    }

    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
  });

  it('POST /operations crea cliente_cc/proveedor NUEVOS del propio tenant (no cross-tenant)', async () => {
    const op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 1, precio_usd: 100, tc: 1000,
    });

    // El movimientos_cc del seller debe usar un cliente_cc del tenant A,
    // NO el `contaminantClientCcId` del tenant C.
    const sellerMov = await pool.query(
      `SELECT cliente_cc_id FROM movimientos_cc
         WHERE tenant_id = $1 AND cross_tenant_operation_id = $2 AND tipo = 'compra'`,
      [tenantAId, op.opId]
    );
    expect(sellerMov.rows.length).toBe(1);
    expect(sellerMov.rows[0].cliente_cc_id).not.toBe(contaminantClientCcId);

    // Verificar que ese cliente_cc pertenece al tenant A (defense-in-depth).
    const cliente = await pool.query(
      `SELECT tenant_id FROM clientes_cc WHERE id = $1`,
      [sellerMov.rows[0].cliente_cc_id]
    );
    expect(cliente.rows[0].tenant_id).toBe(tenantAId);

    // Idem proveedor del buyer.
    const buyerMov = await pool.query(
      `SELECT proveedor_id FROM proveedor_movimientos
         WHERE tenant_id = $1 AND cross_tenant_operation_id = $2 AND tipo = 'compra'`,
      [tenantBId, op.opId]
    );
    expect(buyerMov.rows.length).toBe(1);
    expect(buyerMov.rows[0].proveedor_id).not.toBe(contaminantProveedorId);
    const prov = await pool.query(
      `SELECT tenant_id FROM proveedores WHERE id = $1`,
      [buyerMov.rows[0].proveedor_id]
    );
    expect(prov.rows[0].tenant_id).toBe(tenantBId);
  });

  it('POST /pagos usa cliente_cc/proveedor del propio tenant (no cross-tenant)', async () => {
    const op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 1, precio_usd: 100, tc: 1000,
    });

    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'USD', monto_pago: 100,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      });
    expect(r.status).toBe(201);

    // El mov_cc del pago del seller usa cliente_cc del tenant A.
    const sellerPagoMov = await pool.query(
      `SELECT cliente_cc_id FROM movimientos_cc
         WHERE tenant_id = $1 AND cross_tenant_operation_id = $2 AND tipo = 'pago'`,
      [tenantAId, op.opId]
    );
    expect(sellerPagoMov.rows.length).toBe(1);
    expect(sellerPagoMov.rows[0].cliente_cc_id).not.toBe(contaminantClientCcId);
    const cliente = await pool.query(
      `SELECT tenant_id FROM clientes_cc WHERE id = $1`,
      [sellerPagoMov.rows[0].cliente_cc_id]
    );
    expect(cliente.rows[0].tenant_id).toBe(tenantAId);

    // El proveedor_mov del pago del buyer usa proveedor del tenant B.
    const buyerPagoMov = await pool.query(
      `SELECT proveedor_id FROM proveedor_movimientos
         WHERE tenant_id = $1 AND cross_tenant_operation_id = $2 AND tipo = 'pago'`,
      [tenantBId, op.opId]
    );
    expect(buyerPagoMov.rows.length).toBe(1);
    expect(buyerPagoMov.rows[0].proveedor_id).not.toBe(contaminantProveedorId);
    const prov = await pool.query(
      `SELECT tenant_id FROM proveedores WHERE id = $1`,
      [buyerPagoMov.rows[0].proveedor_id]
    );
    expect(prov.rows[0].tenant_id).toBe(tenantBId);
  });

  it('UNIQUE (tenant_id, LOWER(nombre)) previene duplicados case-insensitive', async () => {
    // Intentar crear un cliente_cc "Duplicated" y después "duplicated" en
    // el mismo tenant. La constraint UNIQUE parcial debe rechazar el segundo.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = ${tenantAId}`);
      await client.query(
        `INSERT INTO clientes_cc (tenant_id, nombre, categoria)
         VALUES ($1, 'DuplicateTest', 'A-')`,
        [tenantAId]
      );
      await expect(
        client.query(
          `INSERT INTO clientes_cc (tenant_id, nombre, categoria)
           VALUES ($1, 'duplicatetest', 'A-')`,
          [tenantAId]
        )
      ).rejects.toThrow(/uq_clientes_cc_tenant_nombre_ci|duplicate key/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('POST /operations/:id/pagos — happy path', () => {
  let partnershipId;
  let op;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 2, precio_usd: 100, tc: 1000,
    });
  });

  it('seller registra cobro → INSERT en mov_cc seller + proveedor_mov buyer + cross_tenant_pago + notif', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 200,
        moneda_pago: 'USD',
        monto_pago: 200,
        tc_pago: 1000,
        caja_id: cajaUsdId,
        side: 'seller',
      });
    expect(r.status).toBe(201);
    expect(r.body.pago).toBeDefined();
    expect(r.body.pago.side).toBe('seller');
    expect(r.body.pago.monto_usd).toBe(200);
    expect(r.body.pago.diferencia_cambiaria_ars).toBe(0);
    expect(r.body.pago.cambio_divisa_id).toBeNull();

    // Verifico mov_cc del seller con tipo='pago'.
    const sellerMov = await pool.query(
      `SELECT tipo, monto_total FROM movimientos_cc
         WHERE tenant_id = $1 AND tipo = 'pago' AND cross_tenant_operation_id = $2`,
      [tenantAId, op.opId]
    );
    expect(sellerMov.rows.length).toBe(1);
    expect(Number(sellerMov.rows[0].monto_total)).toBe(200);

    // Verifico proveedor_mov del buyer con tipo='pago'.
    const buyerMov = await pool.query(
      `SELECT tipo, monto_usd FROM proveedor_movimientos
         WHERE tenant_id = $1 AND tipo = 'pago' AND cross_tenant_operation_id = $2`,
      [tenantBId, op.opId]
    );
    expect(buyerMov.rows.length).toBe(1);
    expect(Number(buyerMov.rows[0].monto_usd)).toBe(200);

    // Verifico cross_tenant_pagos.
    const cp = await pool.query(
      `SELECT * FROM cross_tenant_pagos WHERE cross_tenant_operation_id = $1`,
      [op.opId]
    );
    expect(cp.rows.length).toBe(1);
    expect(cp.rows[0].registered_by_side).toBe('seller');
    expect(cp.rows[0].moneda_pago).toBe('USD');

    // Notif al buyer (payment_received).
    const notif = await pool.query(
      `SELECT type FROM cross_tenant_notifications
         WHERE tenant_id = $1 AND cross_tenant_operation_id = $2`,
      [tenantBId, op.opId]
    );
    expect(notif.rows.some((r) => r.type === 'payment_received')).toBe(true);
  });

  it('buyer registra pago → notif payment_registered al seller', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        monto_usd: 200,
        moneda_pago: 'USD',
        monto_pago: 200,
        tc_pago: 1000,
        caja_id: cajaUsdBId,  // SEG-1: caller = tenantB → caja de B
        side: 'buyer',
      });
    expect(r.status).toBe(201);

    const notif = await pool.query(
      `SELECT type FROM cross_tenant_notifications
         WHERE tenant_id = $1 AND cross_tenant_operation_id = $2`,
      [tenantAId, op.opId]
    );
    expect(notif.rows.some((r) => r.type === 'payment_registered')).toBe(true);
  });

  it('pago parcial actualiza saldo restante', async () => {
    // op total 200, pago 50 → restante 150.
    await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 50, moneda_pago: 'USD', monto_pago: 50,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      })
      .expect(201);

    const r = await request(app)
      .get(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.saldo.pagado_usd).toBe(50);
    expect(r.body.saldo.restante_usd).toBe(150);
    expect(r.body.saldo.completo).toBe(false);
    expect(r.body.pagos.length).toBe(1);
  });

  it('pago completo deja saldo 0 (completo=true)', async () => {
    await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 200, moneda_pago: 'USD', monto_pago: 200,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      })
      .expect(201);

    const r = await request(app)
      .get(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.body.saldo.completo).toBe(true);
    expect(r.body.saldo.restante_usd).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Multi-divisa (decisión #16 — crítico)
// ──────────────────────────────────────────────────────────────────────────
describe('POST /operations/:id/pagos — multi-divisa', () => {
  let partnershipId;
  let op;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    // Op de 200 USD a TC venta = 1000.
    op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 2, precio_usd: 100, tc: 1000,
    });
  });

  it('pago USD/USD → diferencia=0, sin cambio_divisa', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'USD', monto_pago: 100,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      });
    expect(r.status).toBe(201);
    expect(r.body.pago.diferencia_cambiaria_ars).toBe(0);
    expect(r.body.pago.cambio_divisa_id).toBeNull();
    // No hay cambio_movimientos del seller.
    const cm = await pool.query(
      `SELECT id FROM cambio_movimientos WHERE tenant_id = $1`,
      [tenantAId]
    );
    expect(cm.rows.length).toBe(0);
  });

  it('pago ARS tc_pago=tc_venta → diferencia=0, sin cambio_divisa', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'ARS', monto_pago: 100000,
        tc_pago: 1000, caja_id: cajaArsId, side: 'seller',
      });
    expect(r.status).toBe(201);
    expect(r.body.pago.diferencia_cambiaria_ars).toBe(0);
    expect(r.body.pago.cambio_divisa_id).toBeNull();
  });

  it('pago ARS tc_pago > tc_venta → diferencia positiva + INSERT en cambio_movimientos', async () => {
    // TC venta = 1000, TC pago = 1200 → diferencia = (1200-1000)*100 = 20000 ARS positivos.
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'ARS', monto_pago: 120000,
        tc_pago: 1200, caja_id: cajaArsId, side: 'seller',
      });
    expect(r.status).toBe(201);
    expect(r.body.pago.diferencia_cambiaria_ars).toBe(20000);
    expect(r.body.pago.cambio_divisa_id).not.toBeNull();

    // Verifico cambio_movimientos del seller.
    const cm = await pool.query(
      `SELECT tipo, monto_ars, monto_usd, comentarios FROM cambio_movimientos
         WHERE tenant_id = $1`,
      [tenantAId]
    );
    expect(cm.rows.length).toBe(1);
    expect(cm.rows[0].tipo).toBe('recibo_usd'); // ganancia → recibo_usd
    expect(Number(cm.rows[0].monto_ars)).toBe(20000);
  });

  it('pago ARS tc_pago < tc_venta → diferencia negativa + INSERT en cambio_movimientos', async () => {
    // TC venta = 1000, TC pago = 800 → diferencia = (800-1000)*100 = -20000 ARS (pérdida).
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'ARS', monto_pago: 80000,
        tc_pago: 800, caja_id: cajaArsId, side: 'seller',
      });
    expect(r.status).toBe(201);
    expect(r.body.pago.diferencia_cambiaria_ars).toBe(-20000);
    expect(r.body.pago.cambio_divisa_id).not.toBeNull();

    const cm = await pool.query(
      `SELECT tipo, monto_ars FROM cambio_movimientos WHERE tenant_id = $1`,
      [tenantAId]
    );
    expect(cm.rows.length).toBe(1);
    expect(cm.rows[0].tipo).toBe('entrega_ars'); // pérdida → entrega_ars
    expect(Number(cm.rows[0].monto_ars)).toBe(20000); // abs value
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────────
describe('POST /operations/:id/pagos — validation', () => {
  let partnershipId;
  let op;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 2, precio_usd: 100, tc: 1000,
    });
  });

  it('sobre-pago (monto > restante) → 400 overpayment', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 500, // op es 200
        moneda_pago: 'USD', monto_pago: 500,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe('overpayment');
  });

  it('op cancelled → 409', async () => {
    await pool.query(
      `UPDATE cross_tenant_operations SET status = 'cancelled' WHERE id = $1`,
      [op.opId]
    );
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 50, moneda_pago: 'USD', monto_pago: 50,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('op_cancelled');
  });

  it('side body !== caller real side → 403 side_mismatch', async () => {
    // A es seller. Si declara side='buyer', rebote.
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 50, moneda_pago: 'USD', monto_pago: 50,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'buyer',
      });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('side_mismatch');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Conciliación
// ──────────────────────────────────────────────────────────────────────────
describe('GET /partnerships/:id/conciliation', () => {
  let partnershipId;
  let op;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 2, precio_usd: 100, tc: 1000,
    });
  });

  it('devuelve saldos coherentes después de pago', async () => {
    // Pago completo.
    await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 200, moneda_pago: 'USD', monto_pago: 200,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      })
      .expect(201);

    const r = await request(app)
      .get(`/api/red-b2b/partnerships/${partnershipId}/conciliation`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.totales.operaciones_usd).toBe(200);
    expect(r.body.totales.pagado_usd).toBe(200);
    expect(r.body.totales.saldo_neto_usd).toBe(0);
    expect(r.body.saldos_bilaterales.difieren).toBe(false);
  });

  // COR-hotfix audit 2026-07-06: después de COR-2 (proveedor_movimientos.tipo=
  // 'devolucion' en vez de 'pago'), la query de saldos bilaterales de
  // conciliation.js:181-184 no contemplaba el nuevo tipo → el saldo del buyer
  // en proveedor_movimientos quedaba inflado. La conciliación bilateral
  // reportaba discrepancia (`difieren: true`) sin razón financiera válida.
  //
  // Este test simula el escenario: pago 200 + devolución 1 item (100 USD).
  // Sin el fix, provMovBuyer sería 200 (compra) − 200 (pago) + 0 (devolución
  // ignorada) = 0, mientras movCcSeller sería 200 − 200 − 100 = −100. Rompía.
  it('COR-hotfix: conciliación bilateral matchea cuando hay devolución (tipo=devolucion)', async () => {
    // Pago completo (200 = cubre 2 items × 100).
    await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 200, moneda_pago: 'USD', monto_pago: 200,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      })
      .expect(201);

    // Devolución 1 unidad → 100 USD. Fuerza a la conciliación a considerar
    // los 3 tipos (compra + pago + devolucion) en el CASE del buyer.
    await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/devolucion`)
      .set('Authorization', `Bearer ${tokenB}`) // buyer
      .send({
        items: [{ cross_tenant_operation_item_id: op.itemId, cantidad: 1 }],
        motivo: 'hotfix conciliation test',
      })
      .expect(201);

    const r = await request(app)
      .get(`/api/red-b2b/partnerships/${partnershipId}/conciliation`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.saldos_bilaterales.difieren).toBe(false);
  });

  // PR-D #463: el cache in-memory fue eliminado (multi-instance bug + frecuencia
  // de hit baja). Verificamos que el response shape ya no expone `cached` ni
  // `cached_at`, y que dos GETs consecutivos devuelven el mismo payload (sin
  // depender de un flag de cache).
  it('PR-D: response no incluye cached ni cached_at (cache eliminado)', async () => {
    const r1 = await request(app)
      .get(`/api/red-b2b/partnerships/${partnershipId}/conciliation`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r1.status).toBe(200);
    expect(r1.body).not.toHaveProperty('cached');
    expect(r1.body).not.toHaveProperty('cached_at');

    const r2 = await request(app)
      .get(`/api/red-b2b/partnerships/${partnershipId}/conciliation`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r2.status).toBe(200);
    expect(r2.body).not.toHaveProperty('cached');
    expect(r2.body).not.toHaveProperty('cached_at');
    // Mismo data (sin cambios de estado entre calls).
    expect(r2.body.totales).toEqual(r1.body.totales);
    expect(r2.body.saldos_bilaterales).toEqual(r1.body.saldos_bilaterales);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Devoluciones (decisión #11)
// ──────────────────────────────────────────────────────────────────────────
describe('POST /operations/:id/devolucion', () => {
  let partnershipId;
  let op;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 5, precio_usd: 100, tc: 1000,
    });
  });

  it('devolución parcial: stock revierte + nueva op con parent_op_id', async () => {
    // Stock inicial del seller después de createCrossOp: 5+5-5 = 5 (10 inicial - 5 vendidos).
    const stockBeforeQ = await pool.query(
      `SELECT cantidad FROM productos WHERE id = $1`, [op.prodSellerId]
    );
    const stockBefore = Number(stockBeforeQ.rows[0].cantidad);

    // PR-B Bug H3: para que la devolución pase la guard `devolucion_excede_pagado`,
    // el buyer tiene que haber pagado al menos lo que se va a devolver. Op es
    // 5*100=500 USD; vamos a devolver 2 items × 100 = 200 USD. Registramos un
    // pago de 200 USD primero.
    await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 200, moneda_pago: 'USD', monto_pago: 200,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      })
      .expect(201);

    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/devolucion`)
      .set('Authorization', `Bearer ${tokenB}`) // buyer
      .send({
        items: [{ cross_tenant_operation_item_id: op.itemId, cantidad: 2 }],
        motivo: 'Stock dañado',
      });
    expect(r.status).toBe(201);
    // parent_op_id and op.opId are BIGSERIAL so compare loosely (string vs int).
    expect(String(r.body.devolucion.parent_op_id)).toBe(String(op.opId));
    expect(r.body.devolucion.total_usd_devuelto).toBe(200); // 2 * 100

    // Stock del seller +2.
    const stockAfter = await pool.query(
      `SELECT cantidad FROM productos WHERE id = $1`, [op.prodSellerId]
    );
    expect(Number(stockAfter.rows[0].cantidad)).toBe(stockBefore + 2);

    // Stock del buyer -2.
    const buyerStockAfter = await pool.query(
      `SELECT cantidad FROM productos WHERE id = $1`, [op.prodBuyerId]
    );
    // Original: cantidad inicial = 5 en createCrossOp.
    expect(Number(buyerStockAfter.rows[0].cantidad)).toBe(5 - 2);

    // Nueva op con parent.
    const newOp = await pool.query(
      `SELECT id, total_usd, parent_op_id FROM cross_tenant_operations
         WHERE parent_op_id = $1`, [op.opId]
    );
    expect(newOp.rows.length).toBe(1);
    expect(Number(newOp.rows[0].total_usd)).toBe(-200);
  });

  it('solo buyer puede devolución (seller → 403 only_buyer_can_devolucion)', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/devolucion`)
      .set('Authorization', `Bearer ${tokenA}`) // seller (incorrect)
      .send({
        items: [{ cross_tenant_operation_item_id: op.itemId, cantidad: 1 }],
      });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('only_buyer_can_devolucion');
  });

  it('devolución con cantidad > cantidad original → 400', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/devolucion`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        items: [{ cross_tenant_operation_item_id: op.itemId, cantidad: 999 }],
      });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe('devolucion_excede_cantidad');
  });

  it('devolución contra op cancelled → 409 op_not_active', async () => {
    await pool.query(
      `UPDATE cross_tenant_operations SET status = 'cancelled' WHERE id = $1`,
      [op.opId]
    );
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/devolucion`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        items: [{ cross_tenant_operation_item_id: op.itemId, cantidad: 1 }],
      });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('op_not_active');
  });

  // COR-2 audit 2026-07-06: proveedor_movimientos.tipo debe ser 'devolucion'
  // (antes era 'pago' porque el CHECK constraint no admitía 'devolucion' —
  // workaround explícito en el código con comentario "semánticamente NO ES
  // un pago"). Ahora la migration 20260706000002 extendió el CHECK.
  it('COR-2: devolución crea proveedor_mov con tipo=devolucion y baja saldo del proveedor buyer', async () => {
    // Pre-pago para pasar guard `devolucion_excede_pagado` (200 USD = lo que
    // vamos a devolver).
    await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 200, moneda_pago: 'USD', monto_pago: 200,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      })
      .expect(201);

    // Saldo del buyer al proveedor ANTES de la devolución:
    //   compra (createCrossOp)   +500
    //   pago    (pre-pago arriba) -200
    //   ─────────────────────────────
    //   saldo                     300
    const saldoBefore = await pool.query(
      `SELECT COALESCE(SUM(
         CASE
           WHEN tipo='pago'                             THEN -monto_usd
           WHEN tipo='devolucion'                       THEN -monto_usd
           WHEN tipo='compra' AND caja_id IS NOT NULL   THEN 0
           ELSE monto_usd
         END
       ), 0)::float AS saldo
         FROM proveedor_movimientos
        WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [tenantBId]
    );
    expect(saldoBefore.rows[0].saldo).toBe(300);

    // Devolución: 2 items × 100 USD.
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/devolucion`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        items: [{ cross_tenant_operation_item_id: op.itemId, cantidad: 2 }],
        motivo: 'COR-2 test',
      });
    expect(r.status).toBe(201);

    // El proveedor_mov de la devolución tiene tipo='devolucion' (antes: 'pago').
    const devMov = await pool.query(
      `SELECT tipo, monto_usd FROM proveedor_movimientos
        WHERE tenant_id = $1
          AND cross_tenant_operation_id IN (
            SELECT id FROM cross_tenant_operations WHERE parent_op_id = $2
          )`,
      [tenantBId, op.opId]
    );
    expect(devMov.rows.length).toBe(1);
    expect(devMov.rows[0].tipo).toBe('devolucion');
    expect(Number(devMov.rows[0].monto_usd)).toBe(200);

    // Saldo del buyer al proveedor BAJÓ en 200 USD (300 - 200 = 100).
    const saldoAfter = await pool.query(
      `SELECT COALESCE(SUM(
         CASE
           WHEN tipo='pago'                             THEN -monto_usd
           WHEN tipo='devolucion'                       THEN -monto_usd
           WHEN tipo='compra' AND caja_id IS NOT NULL   THEN 0
           ELSE monto_usd
         END
       ), 0)::float AS saldo
         FROM proveedor_movimientos
        WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [tenantBId]
    );
    expect(saldoAfter.rows[0].saldo).toBe(100);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// RLS leak
// ──────────────────────────────────────────────────────────────────────────
describe('RLS leak — tenant C', () => {
  let partnershipId;
  let op;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 2, precio_usd: 100, tc: 1000,
    });
  });

  it('Tenant C intenta POST /pagos en op A↔B → 404', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenC}`)
      .send({
        monto_usd: 100, moneda_pago: 'USD', monto_pago: 100,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      });
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('not_found');
  });

  it('Tenant C intenta GET /conciliation A↔B → 404', async () => {
    const r = await request(app)
      .get(`/api/red-b2b/partnerships/${partnershipId}/conciliation`)
      .set('Authorization', `Bearer ${tokenC}`);
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('not_found');
  });

  // PR-E #464: gaps detectados en audit focal Red B2B — 3 endpoints sin test
  // de RLS leak. El patrón es idéntico al de los 2 existentes arriba (lookup
  // op + filtro `seller_tenant_id = $caller OR buyer_tenant_id = $caller`).
  it('Tenant C intenta POST /:id/devolucion sobre op A↔B → 404', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/devolucion`)
      .set('Authorization', `Bearer ${tokenC}`)
      .send({
        items: [{ cross_tenant_operation_item_id: op.itemId, cantidad: 1 }],
      });
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('not_found');

    // Defensa adicional: no se creó NINGUNA op derivada (parent_op_id).
    const childrenQ = await pool.query(
      `SELECT id FROM cross_tenant_operations WHERE parent_op_id = $1`,
      [op.opId]
    );
    expect(childrenQ.rows.length).toBe(0);
  });

  it('Tenant C intenta GET /:id/pagos sobre op A↔B → 404 (incluso con pago previo)', async () => {
    // Seed: 1 pago real registrado por A (seller).
    const seed = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 50, moneda_pago: 'USD', monto_pago: 50,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      });
    expect(seed.status).toBe(201);

    // Tenant C intenta consultar.
    const r = await request(app)
      .get(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenC}`);
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('not_found');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Config endpoints
// ──────────────────────────────────────────────────────────────────────────
describe('GET/PATCH /config', () => {
  it('GET devuelve caja_default null por defecto', async () => {
    const r = await request(app)
      .get('/api/red-b2b/config')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.red_b2b.caja_default_id).toBeNull();
  });

  it('PATCH /caja-default actualiza la caja', async () => {
    const r = await request(app)
      .patch('/api/red-b2b/config/caja-default')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ caja_id: cajaUsdId });
    expect(r.status).toBe(200);
    expect(r.body.caja_default_id).toBe(cajaUsdId);

    // Verifico DB.
    const t = await pool.query(
      `SELECT red_b2b_caja_default_id FROM tenants WHERE id = $1`, [tenantAId]
    );
    expect(t.rows[0].red_b2b_caja_default_id).toBe(cajaUsdId);
  });

  it('PATCH /caja-default con caja inexistente → 404', async () => {
    const r = await request(app)
      .patch('/api/red-b2b/config/caja-default')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ caja_id: 99999 });
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('caja_not_found');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PR-B Bug B1 — caja resolve único + no doble call con SET LOCAL incorrecto
// ──────────────────────────────────────────────────────────────────────────
describe('PR-B Bug B1: caja resolve único + sin NULL constraint risk', () => {
  let partnershipId;
  let op;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 2, precio_usd: 100, tc: 1000,
    });
  });

  it('seller pago con red_b2b_caja_default_id configurada → caja_buyer_id matchea default', async () => {
    // SEG-1: el default del buyer debe ser una caja PROPIA de B.
    await pool.query(
      `UPDATE tenants SET red_b2b_caja_default_id = $1 WHERE id = $2`,
      [cajaUsdBId, tenantBId]
    );

    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'USD', monto_pago: 100,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller', // caller A → A's caja
      });
    expect(r.status).toBe(201);

    const cp = await pool.query(
      `SELECT caja_seller_id, caja_buyer_id FROM cross_tenant_pagos
         WHERE cross_tenant_operation_id = $1`,
      [op.opId]
    );
    expect(cp.rows.length).toBe(1);
    // Caller is seller → caja_seller_id = body.caja_id (A's caja).
    expect(cp.rows[0].caja_seller_id).toBe(cajaUsdAId);
    // Default del buyer → caja_buyer_id = default configurado (B's caja).
    expect(cp.rows[0].caja_buyer_id).toBe(cajaUsdBId);
    // Ambos NOT NULL (defensa contra el bug original).
    expect(cp.rows[0].caja_seller_id).not.toBeNull();
    expect(cp.rows[0].caja_buyer_id).not.toBeNull();
  });

  it('buyer pago con red_b2b_caja_default_id del seller configurada → caja_seller_id matchea', async () => {
    await pool.query(
      `UPDATE tenants SET red_b2b_caja_default_id = $1 WHERE id = $2`,
      [cajaUsdId, tenantAId]
    );

    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        monto_usd: 100, moneda_pago: 'USD', monto_pago: 100,
        tc_pago: 1000, caja_id: cajaUsdBId, side: 'buyer', // SEG-1: B propia
      });
    expect(r.status).toBe(201);

    const cp = await pool.query(
      `SELECT caja_seller_id, caja_buyer_id FROM cross_tenant_pagos
         WHERE cross_tenant_operation_id = $1`,
      [op.opId]
    );
    // SEG-1: caller (buyer=B) usa su propia caja; seller (A) usa su
    // red_b2b_caja_default_id (= cajaUsdAId, la propia de A).
    expect(cp.rows[0].caja_buyer_id).toBe(cajaUsdBId);
    expect(cp.rows[0].caja_seller_id).toBe(cajaUsdAId);
  });

  it('sin caja default → fallback a primera caja con moneda compatible', async () => {
    // No setear red_b2b_caja_default_id (default null por beforeEach).
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'USD', monto_pago: 100,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      });
    expect(r.status).toBe(201);

    const cp = await pool.query(
      `SELECT caja_seller_id, caja_buyer_id FROM cross_tenant_pagos
         WHERE cross_tenant_operation_id = $1`,
      [op.opId]
    );
    // caja_buyer_id viene del fallback (primera USD/USDT del PROPIO buyer).
    expect(cp.rows[0].caja_buyer_id).toBe(cajaUsdBId);
    expect(cp.rows[0].caja_seller_id).toBe(cajaUsdId);
  });

  // SEG-1 regresión (audit 2026-07-06): seller pasa la caja_id del BUYER
  // (otro tenant). Antes: adminQuery (BYPASSRLS) + WHERE sin tenant_id →
  // 201 y persistía la caja ajena en caja_seller_id. Ahora: 404 caja_not_found.
  it('SEG-1: rechaza caja_id de otro tenant en POST /pagos', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'USD', monto_pago: 100,
        tc_pago: 1000, caja_id: cajaUsdBId, // ← caja de OTRO tenant
        side: 'seller',
      });
    expect(r.status).toBe(404);
    // El wrapper del router traduce el error code a `reason` y el user-facing
    // message a `error`. Chequeamos el code estable.
    expect(r.body.reason).toBe('caja_not_found');
    // Verificar que NO se creó ningún pago.
    const cp = await pool.query(
      `SELECT COUNT(*)::int AS n FROM cross_tenant_pagos
         WHERE cross_tenant_operation_id = $1`,
      [op.opId]
    );
    expect(cp.rows[0].n).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PR-B Bug B2 — monto_pago se persiste tal como lo declaró el operador
// ──────────────────────────────────────────────────────────────────────────
describe('PR-B Bug B2: monto_pago declarado vs recomputado (drift contable)', () => {
  let partnershipId;
  let op;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    // Op de 200 USD a TC venta = 1000 → total_ars = 200000.
    op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 2, precio_usd: 100, tc: 1000,
    });
  });

  it('ARS con monto_pago = monto_usd × tc_pago exacto → persiste igual (sin drift)', async () => {
    // 100 USD × 1000 TC = 100000 ARS exacto.
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'ARS', monto_pago: 100000,
        tc_pago: 1000, caja_id: cajaArsId, side: 'seller',
      });
    expect(r.status).toBe(201);

    const cp = await pool.query(
      `SELECT monto_usd, monto_ars FROM cross_tenant_pagos
         WHERE cross_tenant_operation_id = $1`,
      [op.opId]
    );
    expect(Number(cp.rows[0].monto_usd)).toBe(100);
    expect(Number(cp.rows[0].monto_ars)).toBe(100000);
  });

  it('ARS con monto_pago distinto (dentro de tolerancia 1 ARS) → persiste el DECLARADO, no recomputado', async () => {
    // 100 USD × 1000 TC = 100000 ARS esperado. Operador declara 99999.5.
    // Tolerancia refine es 1 ARS → válido.
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'ARS', monto_pago: 99999.5,
        tc_pago: 1000, caja_id: cajaArsId, side: 'seller',
      });
    expect(r.status).toBe(201);

    const cp = await pool.query(
      `SELECT monto_ars FROM cross_tenant_pagos
         WHERE cross_tenant_operation_id = $1`,
      [op.opId]
    );
    // CRÍTICO: monto_ars persiste el monto_pago declarado (99999.5),
    // NO la multiplicación recomputada (100000).
    expect(Number(cp.rows[0].monto_ars)).toBe(99999.5);
    expect(Number(cp.rows[0].monto_ars)).not.toBe(100000);
  });

  it('ARS con drift: diferencia_cambiaria_ars = monto_pago − (monto_usd × tc_venta)', async () => {
    // tc_venta = 1000 (de la op), tc_pago = 1100, monto_pago declarado = 109999.5
    // (≈ 100 × 1100 = 110000, drift de 0.5 ARS dentro de tolerancia <1.0).
    //
    // diferencia esperada = 109999.5 − (100 × 1000) = 109999.5 − 100000 = 9999.5.
    //
    // (Si se calculara contra monto_usd × tc_pago daría 10000, lo cual
    // ignoraría el drift de 0.5 ARS que el operador asentó).
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'ARS', monto_pago: 109999.5,
        tc_pago: 1100, caja_id: cajaArsId, side: 'seller',
      });
    expect(r.status).toBe(201);
    expect(r.body.pago.diferencia_cambiaria_ars).toBe(9999.5);

    const cp = await pool.query(
      `SELECT monto_ars, diferencia_cambiaria_ars FROM cross_tenant_pagos
         WHERE cross_tenant_operation_id = $1`,
      [op.opId]
    );
    expect(Number(cp.rows[0].monto_ars)).toBe(109999.5);
    expect(Number(cp.rows[0].diferencia_cambiaria_ars)).toBe(9999.5);
  });

  it('USD: monto_ars = monto_usd × tc_pago (retro-compat — no hay drift posible)', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'USD', monto_pago: 100,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      });
    expect(r.status).toBe(201);

    const cp = await pool.query(
      `SELECT monto_ars FROM cross_tenant_pagos
         WHERE cross_tenant_operation_id = $1`,
      [op.opId]
    );
    // USD path: monto_ars = monto_usd × tc_pago (no drift posible).
    expect(Number(cp.rows[0].monto_ars)).toBe(100000);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PR-B Bug H3 — devolución no puede exceder lo pagado (saldo a favor solo
// si hubo pagos previos)
// ──────────────────────────────────────────────────────────────────────────
describe('PR-B Bug H3: devolución validada contra pagos efectivos', () => {
  let partnershipId;
  let op;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 5, precio_usd: 100, tc: 1000,
    });
  });

  it('sin pagos previos → 409 devolucion_excede_pagado', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/devolucion`)
      .set('Authorization', `Bearer ${tokenB}`) // buyer
      .send({
        items: [{ cross_tenant_operation_item_id: op.itemId, cantidad: 1 }],
      });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('devolucion_excede_pagado');
    expect(r.body.details.pagado_usd).toBe(0);
    expect(r.body.details.intentado_usd).toBe(100);
    expect(r.body.details.max_devolvible_usd).toBe(0);
  });

  it('pago parcial → puede devolver hasta lo pagado, no más', async () => {
    // Pago de 200 USD (de 500 total).
    await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 200, moneda_pago: 'USD', monto_pago: 200,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      })
      .expect(201);

    // Devolver 2 items × 100 = 200 USD → OK (matchea lo pagado).
    const ok = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/devolucion`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        items: [{ cross_tenant_operation_item_id: op.itemId, cantidad: 2 }],
      });
    expect(ok.status).toBe(201);
  });

  it('pago parcial 100 USD, intento devolver 300 USD → 409', async () => {
    await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 100, moneda_pago: 'USD', monto_pago: 100,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      })
      .expect(201);

    // Intento devolver 3 items × 100 = 300 USD > 100 pagado.
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/devolucion`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        items: [{ cross_tenant_operation_item_id: op.itemId, cantidad: 3 }],
      });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('devolucion_excede_pagado');
    expect(r.body.details.pagado_usd).toBe(100);
    expect(r.body.details.max_devolvible_usd).toBe(100);
    expect(r.body.details.intentado_usd).toBe(300);
  });

  it('pago total + devolución total → OK (caso ideal saldo 0)', async () => {
    // Pago total 500 USD.
    await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 500, moneda_pago: 'USD', monto_pago: 500,
        tc_pago: 1000, caja_id: cajaUsdId, side: 'seller',
      })
      .expect(201);

    // Devolver 5 items × 100 = 500.
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/devolucion`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        items: [{ cross_tenant_operation_item_id: op.itemId, cantidad: 5 }],
      });
    expect(r.status).toBe(201);
    expect(r.body.devolucion.total_usd_devuelto).toBe(500);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PR-E #464 — F4 atomicidad: rollback completo si INSERT a cambio_movimientos
// falla
//
// Caso real: el pago ARS con diferencia cambiaria !== 0 inserta:
//   1. movimientos_cc del seller (tipo='pago')
//   2. cambio_entidades (find or insert) + cambio_movimientos (diff)
//   3. proveedor_movimientos del buyer (tipo='pago')
//   4. cross_tenant_pagos (maestro)
//   5. cross_tenant_notifications (notif al otro lado)
//   6. tenant_admin_actions (audit, vía SAVEPOINT)
//
// Si CUALQUIERA falla (excepto el audit con SAVEPOINT), TODO debe rollbackearse
// — no puede quedar mov_cc del seller sin mov_prov del buyer ni cross_tenant_pagos
// sin la mov de uno de los dos lados, sino la conciliación se rompe.
//
// Estrategia del test: spy sobre crossTenantPagos.registerSellerCobro
// (helper exportado). Ese helper es el que en su segundo INSERT escribe
// cambio_movimientos (cuando moneda_pago=ARS y diff != 0). Lo reemplazamos
// para que arranque la sub-secuencia y luego throw al llegar al INSERT del
// cambio. Más limpio que parchar client.query y evita deadlock con ROLLBACK.
//
// TODO: este test es frágil al refactor — si crossTenantPagos cambia el
// orden de operaciones o renombra registerSellerCobro, el spy debe ajustarse.
// El invariante (rollback completo en fallo) se mantiene sin importar la
// implementación interna.
// ──────────────────────────────────────────────────────────────────────────
describe('PR-E F4 atomicity — INSERT cambio_movimientos falla → tx completa rollbackea', () => {
  const db = require('../src/config/database');

  let partnershipId;
  let op;
  let adminQuerySpy;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantBId,
      partnershipId, cantidad: 2, precio_usd: 100, tc: 1000,
    });
  });

  afterEach(() => {
    if (adminQuerySpy) {
      adminQuerySpy.mockRestore();
      adminQuerySpy = null;
    }
  });

  it('pago ARS con tc_pago != tc_venta: si cambio_movimientos INSERT falla → 0 nuevas filas en mov_cc/mov_prov/cross_pagos/cambio_mov', async () => {
    const baseQuery = async (table, where) => {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${table} ${where}`
      );
      return r.rows[0].n;
    };

    // Pre-baseline: cleanup en beforeEach del file dejó todo en 0 — verificamos.
    expect(await baseQuery(
      'movimientos_cc',
      `WHERE tenant_id = ${tenantAId} AND tipo = 'pago' AND cross_tenant_operation_id = ${op.opId}`
    )).toBe(0);
    expect(await baseQuery(
      'cambio_movimientos',
      `WHERE tenant_id = ${tenantAId}`
    )).toBe(0);
    expect(await baseQuery(
      'cross_tenant_pagos',
      `WHERE cross_tenant_operation_id = ${op.opId}`
    )).toBe(0);

    // Spy: interceptamos db.adminQuery para envolver client.query y forzar
    // throw cuando llegue el INSERT a cambio_movimientos. Esto simula un
    // fallo "natural" (CHECK violation, FK orphan, deadlock) sin tocar
    // schema ni código de producción.
    //
    // El throw se gatilla SOLO en el INSERT específico. Las demás queries
    // (incluyendo el ROLLBACK que el handler emite en catch) pasan al
    // originalQuery sin tocar, así PG las procesa normal y la tx aborta
    // limpio sin dejar la conexión en estado inconsistente.
    const originalAdminQuery = db.adminQuery.bind(db);
    adminQuerySpy = jest.spyOn(db, 'adminQuery').mockImplementation(async (callback) => {
      return originalAdminQuery(async (client) => {
        const originalQuery = client.query.bind(client);
        // eslint-disable-next-line no-param-reassign
        client.query = function patchedQuery(textOrConfig, ...rest) {
          const text = typeof textOrConfig === 'string'
            ? textOrConfig
            : (textOrConfig && textOrConfig.text) || '';
          // Match: el INSERT en crossTenantPagos.js#registerSellerCobro
          // arranca con `INSERT INTO cambio_movimientos`. Whitespace
          // intermedio normalizado por la regex.
          if (/INSERT\s+INTO\s+cambio_movimientos/i.test(text)) {
            const err = new Error(
              'simulated INSERT cambio_movimientos failure (PR-E atomicity test)'
            );
            err.code = '23514'; // check_violation — error real plausible
            return Promise.reject(err);
          }
          return originalQuery(textOrConfig, ...rest);
        };
        return callback(client);
      });
    });

    // Pago ARS con tc_pago=1200 vs tc_venta=1000 → diff_ars positiva no-cero
    // → registerSellerCobro intenta INSERT a cambio_movimientos → spy throw.
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 50, moneda_pago: 'ARS', monto_pago: 60000, // 50 * 1200
        tc_pago: 1200, caja_id: cajaArsId, side: 'seller',
      });

    // El handler propaga el throw via next(err) → app-level error handler
    // mapea 23514 a 400 con mensaje genérico (ver app.js línea ~810).
    // Lo crítico no es el status code exacto sino que NO sea 200/201
    // (tx commiteada).
    expect(r.status).not.toBe(200);
    expect(r.status).not.toBe(201);

    // ── INVARIANTE CRÍTICO: 0 filas nuevas en TODAS las tablas afectadas ──
    // En el flujo real, antes del INSERT a cambio_movimientos hay un
    // INSERT a movimientos_cc del seller (tipo='pago'). El ROLLBACK del
    // catch del handler DEBE haberlo revertido. Lo mismo aplica a
    // cualquier otro INSERT pendiente. Si alguna de estas counts es > 0,
    // la atomicidad está rota → el partner queda con CC desbalanceado.
    expect(await baseQuery(
      'movimientos_cc',
      `WHERE tenant_id = ${tenantAId} AND tipo = 'pago' AND cross_tenant_operation_id = ${op.opId}`
    )).toBe(0);
    expect(await baseQuery(
      'proveedor_movimientos',
      `WHERE tenant_id = ${tenantBId} AND tipo = 'pago' AND cross_tenant_operation_id = ${op.opId}`
    )).toBe(0);
    expect(await baseQuery(
      'cross_tenant_pagos',
      `WHERE cross_tenant_operation_id = ${op.opId}`
    )).toBe(0);
    expect(await baseQuery(
      'cambio_movimientos',
      `WHERE tenant_id = ${tenantAId}`
    )).toBe(0);

    // Sanity: el spy se disparó (sino no estaríamos testeando rollback real).
    expect(adminQuerySpy).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// COR-1 (audit 2026-07-06) — idempotency para POST /pagos.
//
// Antes: doble-click / retry 502 / dos pestañas creaban 2 cross_tenant_pagos
// idénticos + 2 movs_cc + 2 proveedor_movs + 2 asientos Cambios. El
// `FOR UPDATE` sobre la op serializaba pero no impedía el 2do si quedaba
// saldo. Ahora: `Idempotency-Key` header (UUID). Retry con misma key →
// 200 + pago original, sin side effects.
//
// NOTA: el outer `beforeEach` de este file BORRA cross_tenant_operations
// para A/B/C antes de cada test → tenemos que crear la op EN CADA test
// (o dentro de un `beforeEach` interno). Usamos A↔C partnership (fresca)
// para no chocar con otros describes que crean A↔B.
// ──────────────────────────────────────────────────────────────────────────
describe('COR-1 idempotency — Idempotency-Key en POST /pagos', () => {
  const crypto = require('crypto');
  let partnershipId;
  let op;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantCId, tenantAId);
    op = await createCrossOp({
      sellerTenantId: tenantAId, buyerTenantId: tenantCId,
      partnershipId, cantidad: 5, precio_usd: 100,
    });
    // Fail-fast si el helper no devolvió opId — evita el "404 vago".
    expect(op.opId).toBeDefined();
  });

  it('POST sin header → legacy path (client_generated_id NULL, 201)', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        monto_usd: 50, moneda_pago: 'USD', monto_pago: 50,
        tc_pago: 1000, caja_id: cajaUsdAId, side: 'seller',
      });
    expect(r.status).toBe(201);
    const p = await pool.query(
      `SELECT client_generated_id FROM cross_tenant_pagos WHERE id = $1`,
      [r.body.pago.id]
    );
    expect(p.rows[0].client_generated_id).toBeNull();
  });

  it('POST con MISMA Idempotency-Key (retry) → 200 + payload original, SIN duplicar cross_tenant_pagos', async () => {
    const key = crypto.randomUUID();

    // Primer request → crea el pago.
    const r1 = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', key)
      .send({
        monto_usd: 70, moneda_pago: 'USD', monto_pago: 70,
        tc_pago: 1000, caja_id: cajaUsdAId, side: 'seller',
      });
    expect(r1.status).toBe(201);
    const originalPagoId = r1.body.pago.id;

    // Verificar que la key quedó persistida en la 1ra fila.
    const p1 = await pool.query(
      `SELECT client_generated_id FROM cross_tenant_pagos WHERE id = $1`,
      [originalPagoId]
    );
    expect(p1.rows[0].client_generated_id).toBe(key);

    // Retry: MISMO body, MISMA key.
    const r2 = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', key)
      .send({
        monto_usd: 70, moneda_pago: 'USD', monto_pago: 70,
        tc_pago: 1000, caja_id: cajaUsdAId, side: 'seller',
      });
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent_replay).toBe(true);
    expect(r2.body.pago.id).toBe(originalPagoId);

    // Sanity: 1 sola fila de pago en la op (no se duplicó).
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM cross_tenant_pagos WHERE cross_tenant_operation_id = $1`,
      [op.opId]
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('POST con Idempotency-Key malformado → 400 idempotency_key_invalid', async () => {
    const r = await request(app)
      .post(`/api/red-b2b/operations/${op.opId}/pagos`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', 'not-a-uuid')
      .send({
        monto_usd: 10, moneda_pago: 'USD', monto_pago: 10,
        tc_pago: 1000, caja_id: cajaUsdAId, side: 'seller',
      });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe('idempotency_key_invalid');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Helper puro: calcularDiferenciaCambiaria
// ──────────────────────────────────────────────────────────────────────────
describe('calcularDiferenciaCambiaria (helper puro)', () => {
  const { calcularDiferenciaCambiaria } = require('../src/lib/crossTenantPagos');

  it('moneda USD → diferencia 0', () => {
    const r = calcularDiferenciaCambiaria(100, 1000, 1500, 'USD');
    expect(r.diferencia_ars).toBe(0);
    expect(r.diferencia_local).toBe(0);
    expect(r.moneda_local).toBe('USD');
  });

  it('ARS, tc iguales → diferencia 0', () => {
    const r = calcularDiferenciaCambiaria(100, 1000, 1000, 'ARS');
    expect(r.diferencia_ars).toBe(0);
    expect(r.diferencia_local).toBe(0);
  });

  it('ARS, tc_pago > tc_venta → ganancia (positivo)', () => {
    const r = calcularDiferenciaCambiaria(100, 1000, 1200, 'ARS');
    expect(r.diferencia_ars).toBe(20000);
    expect(r.diferencia_local).toBe(20000);
    expect(r.moneda_local).toBe('ARS');
    expect(r.ganancia_seller).toBe(true);
  });

  it('ARS, tc_pago < tc_venta → pérdida (negativo)', () => {
    const r = calcularDiferenciaCambiaria(100, 1000, 800, 'ARS');
    expect(r.diferencia_ars).toBe(-20000);
    expect(r.diferencia_local).toBe(-20000);
    expect(r.ganancia_seller).toBe(false);
  });

  // BLOCKER 2026-07-05 (multi-país UYU): antes UYU caía al bloque ARS y
  // devolvía la diff en el campo `diferencia_ars` sin serlo. Ahora el campo
  // legacy `diferencia_ars` queda en 0 para UYU y el valor real vive en
  // `diferencia_local`. El call-site persiste `diferencia_local` en la
  // columna `cross_tenant_pagos.diferencia_cambiaria_ars` (nombre legacy).
  it('UYU, tc_pago > tc_venta → ganancia (positivo) en diferencia_local; diferencia_ars queda en 0', () => {
    const r = calcularDiferenciaCambiaria(100, 40, 42, 'UYU');
    expect(r.diferencia_local).toBe(200); // 100 * (42-40)
    expect(r.moneda_local).toBe('UYU');
    expect(r.diferencia_ars).toBe(0); // legacy field vacío en UYU
    expect(r.ganancia_seller).toBe(true);
  });

  it('UYU, tc_pago < tc_venta → pérdida (negativo)', () => {
    const r = calcularDiferenciaCambiaria(100, 40, 38, 'UYU');
    expect(r.diferencia_local).toBe(-200);
    expect(r.moneda_local).toBe('UYU');
    expect(r.ganancia_seller).toBe(false);
  });

  it('USDT → diferencia 0 (tratada como USD)', () => {
    const r = calcularDiferenciaCambiaria(100, 1000, 1200, 'USDT');
    expect(r.diferencia_ars).toBe(0);
    expect(r.diferencia_local).toBe(0);
    expect(r.moneda_local).toBe('USDT');
  });
});

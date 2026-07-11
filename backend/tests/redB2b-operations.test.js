/**
 * Tests integration para Red B2B operations (F3 #456).
 *
 * Cobertura (28 tests críticos):
 *
 *   Capability gate (2):
 *     · sin cross_tenant.write → 403 en POST
 *     · sin cross_tenant.write → 403 en GET
 *
 *   Happy path POST (5):
 *     · 201 con operation_id + my_side='seller'
 *     · stock del seller decremento
 *     · auto-create de productos en el buyer (pending_cross_tenant_review=true)
 *     · movimientos_cc creado del seller (B2B venta)
 *     · proveedor_movimientos creado del buyer (compra)
 *
 *   Validation POST (5):
 *     · partnership_id no existe → 404
 *     · partnership revocada → 409 partnership_not_active
 *     · producto del seller no existe → 404
 *     · total_usd no matchea suma items → 400 total_usd_mismatch
 *     · seller suspended (suspended_at) → 409 seller_suspended
 *
 *   Atomicity (3):
 *     · stock insuficiente revierte TODO (no se crean rows en ninguna tabla)
 *     · cross_tenant_operations.id se enlaza correctamente a venta+compra
 *     · COMMIT solo si todo OK
 *
 *   RLS leak (4):
 *     · Tenant C intenta POST con partnership A↔B → 403 caller_not_in_partnership
 *     · Tenant C intenta GET /:id de op A↔B → 404
 *     · GET / no retorna ops ajenas
 *     · Tenant C intenta cancel op A↔B → 404
 *
 *   Cancel (4):
 *     · POST /:id/cancel revierte stock del seller (suma cantidades)
 *     · POST /:id/cancel idempotente → 409 already_cancelled
 *     · Solo seller puede cancelar (buyer → 403 only_seller_can_cancel)
 *     · Notif al buyer creada
 *
 *   PATCH /:id (2):
 *     · PATCH notes solo seller (buyer → 403)
 *     · PATCH actualiza last_modified
 *
 *   GET /:id (2):
 *     · Devuelve detalle full con items + my_side
 *     · 404 si no existe
 *
 *   Stock edge (1):
 *     · multi-item con un producto insuficiente → rollback completo
 *
 * Setup similar a F1/F2 — 3 tenants (A, B, C) + users con/sin cap.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

const TENANT_A = { slug: 'red-b2b-op-test-a', nombre: 'RedB2B Op Test A', plan: 'starter' };
const TENANT_B = { slug: 'red-b2b-op-test-b', nombre: 'RedB2B Op Test B', plan: 'pro' };
const TENANT_C = { slug: 'red-b2b-op-test-c', nombre: 'RedB2B Op Test C', plan: 'starter' };

let pool;
let tenantAId, tenantBId, tenantCId;
let userAId, userBId, userCId, userANoCapId;
let tokenA, tokenB, tokenC, tokenANoCap;

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
     ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre, plan = EXCLUDED.plan, suspended_at = NULL
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

// Inserta un producto del seller con stock = `cantidad`.
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

// Crea una partnership ACTIVA entre two tenants (insert directo, sin pasar
// por endpoint invite/accept que ya están testeados en F1).
async function createActivePartnership(tenantAId_, tenantBId_, invitedBy) {
  const [a, b] = tenantAId_ < tenantBId_ ? [tenantAId_, tenantBId_] : [tenantBId_, tenantAId_];
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

beforeAll(async () => {
  pool = await setupTestDb();

  tenantAId = await createTenant(TENANT_A);
  tenantBId = await createTenant(TENANT_B);
  tenantCId = await createTenant(TENANT_C);

  userAId = await createUserForTenant(tenantAId, {
    username: 'rb2b-op-user-a', email: 'rb2b-op-a@test.local',
  });
  userBId = await createUserForTenant(tenantBId, {
    username: 'rb2b-op-user-b', email: 'rb2b-op-b@test.local',
  });
  userCId = await createUserForTenant(tenantCId, {
    username: 'rb2b-op-user-c', email: 'rb2b-op-c@test.local',
  });
  userANoCapId = await createUserForTenant(tenantAId, {
    username: 'rb2b-op-user-a-nocap', email: 'rb2b-op-a-nocap@test.local',
  });

  const capsOn = { 'cross_tenant.write': true };
  tokenA = signToken({
    id: userAId, username: 'rb2b-op-user-a', email: 'rb2b-op-a@test.local',
    tenant_id: tenantAId, caps: capsOn,
  });
  tokenB = signToken({
    id: userBId, username: 'rb2b-op-user-b', email: 'rb2b-op-b@test.local',
    tenant_id: tenantBId, caps: capsOn,
  });
  tokenC = signToken({
    id: userCId, username: 'rb2b-op-user-c', email: 'rb2b-op-c@test.local',
    tenant_id: tenantCId, caps: capsOn,
  });
  tokenANoCap = signToken({
    id: userANoCapId, username: 'rb2b-op-user-a-nocap',
    email: 'rb2b-op-a-nocap@test.local',
    tenant_id: tenantAId, caps: {},
  });
});

beforeEach(async () => {
  const ids = [tenantAId, tenantBId, tenantCId];

  // Order matters por FKs. cross_tenant_operation_items → CASCADE de operations.
  // movimientos_cc / proveedor_movimientos referencian cross_tenant_operations
  // (FK con NULL allowed) → primero los unlinkeamos, luego dropeamos las ops.
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

  await pool.query(
    `DELETE FROM cross_tenant_notifications WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  // PR-B Bug H2 tests: cross_tenant_pagos referencia cross_tenant_operations
  // con FK NOT NULL → hay que borrar pagos antes de operations. También las
  // ops de devolución (parent_op_id self-ref) bloquean si están vivas.
  await pool.query(
    `DELETE FROM cross_tenant_pagos
       WHERE cross_tenant_operation_id IN (
         SELECT id FROM cross_tenant_operations
          WHERE seller_tenant_id = ANY($1::int[]) OR buyer_tenant_id = ANY($1::int[]))`,
    [ids]
  );
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

  // Limpiar cambios de divisa (PR-B Bug H2 tests pueden insertar acá vía
  // pagos ARS con diferencia cambiaria).
  await pool.query(`DELETE FROM cambio_movimientos WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM cambio_entidades WHERE tenant_id = ANY($1::int[])`, [ids]);

  // Limpiar movimientos y productos para empezar limpio.
  await pool.query(`DELETE FROM items_movimiento_cc WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM movimientos_cc WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM clientes_cc WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM proveedor_movimiento_items WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM proveedor_movimientos WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM proveedores WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM productos WHERE tenant_id = ANY($1::int[])`, [ids]);

  // Reset suspended_at + red_b2b_caja_default_id por si algún test lo seteó.
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

  await pool.query(`DELETE FROM cross_tenant_notifications WHERE tenant_id = ANY($1::int[])`, [ids]);
  // PR-B Bug H2 tests: borrar pagos antes de operations (FK NOT NULL).
  await pool.query(
    `DELETE FROM cross_tenant_pagos
       WHERE cross_tenant_operation_id IN (
         SELECT id FROM cross_tenant_operations
          WHERE seller_tenant_id = ANY($1::int[]) OR buyer_tenant_id = ANY($1::int[]))`,
    [ids]
  );
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
  await pool.query(`DELETE FROM tenants WHERE id = ANY($1::int[])`, [ids]);

  await teardownTestDb(pool);
});

// ──────────────────────────────────────────────────────────────────────────
// Capability gate
// ──────────────────────────────────────────────────────────────────────────
describe('cross_tenant.write gate', () => {
  it('user SIN cap → 403 en POST /operations', async () => {
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenANoCap}`)
      .send({});
    expect(r.status).toBe(403);
  });

  it('user SIN cap → 403 en GET /operations', async () => {
    const r = await request(app)
      .get('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenANoCap}`);
    expect(r.status).toBe(403);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Happy path POST /
// ──────────────────────────────────────────────────────────────────────────
describe('POST /api/red-b2b/operations — happy path', () => {
  let partnershipId;
  let prodId;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    prodId = await insertSellerProducto(tenantAId, { nombre: 'iPhone Test', cantidad: 10, costo: 800 });
  });

  it('201 con operation_id + my_side=seller', async () => {
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 3, precio_usd: 1000 }],
        tc: 1000,
        total_usd: 3000,
        total_ars: 3000000,
      });
    expect(r.status).toBe(201);
    expect(r.body.operation).toBeDefined();
    expect(r.body.operation.my_side).toBe('seller');
    expect(r.body.operation.status).toBe('active');
    expect(r.body.operation.total_usd).toBe(3000);
    expect(r.body.operation.items_count).toBe(1);
  });

  it('stock del seller decrementa por la cantidad vendida', async () => {
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 3, precio_usd: 1000 }],
        tc: 1000, total_usd: 3000, total_ars: 3000000,
      });
    expect(r.status).toBe(201);
    const row = await pool.query(
      `SELECT cantidad FROM productos WHERE id = $1`,
      [prodId]
    );
    expect(Number(row.rows[0].cantidad)).toBe(7); // 10 - 3
  });

  it('auto-create de producto en el buyer con pending_cross_tenant_review=true', async () => {
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 3, precio_usd: 1000 }],
        tc: 1000, total_usd: 3000, total_ars: 3000000,
      });
    expect(r.status).toBe(201);
    const buyerProds = await pool.query(
      `SELECT id, nombre, cantidad, pending_cross_tenant_review, created_from_cross_tenant_op_id
         FROM productos WHERE tenant_id = $1`,
      [tenantBId]
    );
    expect(buyerProds.rows.length).toBe(1);
    expect(buyerProds.rows[0].nombre).toBe('iPhone Test');
    expect(Number(buyerProds.rows[0].cantidad)).toBe(3);
    expect(buyerProds.rows[0].pending_cross_tenant_review).toBe(true);
    expect(buyerProds.rows[0].created_from_cross_tenant_op_id).toBeTruthy();
  });

  it('crea movimientos_cc en el seller con cross_tenant_operation_id', async () => {
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 2, precio_usd: 1000 }],
        tc: 1000, total_usd: 2000, total_ars: 2000000,
      });
    expect(r.status).toBe(201);
    const movQ = await pool.query(
      `SELECT id, tipo, monto_total, cross_tenant_operation_id, estado
         FROM movimientos_cc WHERE tenant_id = $1`,
      [tenantAId]
    );
    expect(movQ.rows.length).toBe(1);
    expect(movQ.rows[0].tipo).toBe('compra');
    expect(Number(movQ.rows[0].monto_total)).toBe(2000);
    expect(movQ.rows[0].cross_tenant_operation_id).toBeTruthy();
    expect(movQ.rows[0].estado).toBe('pendiente');
  });

  it('crea proveedor_movimientos en el buyer con cross_tenant_operation_id', async () => {
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 2, precio_usd: 1000 }],
        tc: 1000, total_usd: 2000, total_ars: 2000000,
      });
    expect(r.status).toBe(201);
    const movQ = await pool.query(
      `SELECT id, tipo, monto_usd, cross_tenant_operation_id
         FROM proveedor_movimientos WHERE tenant_id = $1`,
      [tenantBId]
    );
    expect(movQ.rows.length).toBe(1);
    expect(movQ.rows[0].tipo).toBe('compra');
    expect(Number(movQ.rows[0].monto_usd)).toBe(2000);
    expect(movQ.rows[0].cross_tenant_operation_id).toBeTruthy();
  });

  it('crea notification operation_received en el buyer', async () => {
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 1500 }],
        tc: 1000, total_usd: 1500, total_ars: 1500000,
      });
    expect(r.status).toBe(201);
    const notifQ = await pool.query(
      `SELECT type, payload FROM cross_tenant_notifications WHERE tenant_id = $1`,
      [tenantBId]
    );
    expect(notifQ.rows.length).toBe(1);
    expect(notifQ.rows[0].type).toBe('operation_received');
    expect(notifQ.rows[0].payload.partner).toBeDefined();
    expect(notifQ.rows[0].payload.total_usd).toBe(1500);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Validation POST /
// ──────────────────────────────────────────────────────────────────────────
describe('POST /api/red-b2b/operations — validation', () => {
  it('partnership_id que no existe → 404', async () => {
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: 9999999,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
      });
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('partnership_not_active');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2026-07-11 (auditoría Red B2B P0-2): paid_until timezone tenant-aware.
  //
  // Bug: la comparación anterior usaba `new Date(...ISOString().slice(0,10))`
  // → midnight UTC. Server PG en UTC → tenant AR con paid_until=2026-07-11
  // era rebotado como expired desde las 21:00 AR del 11 hasta las 21:00 AR
  // del 12 (3h de bloqueo diario). Fix: comparar contra
  // `(NOW() AT TIME ZONE tenant_tz)::date` derivando tz de tenant.pais.
  // ═══════════════════════════════════════════════════════════════════════
  it('P0-2 timezone: paid_until = HOY en zona del tenant NO se marca como expired', async () => {
    // Setear paid_until = "hoy" en zona AR (donde vive el tenant por default).
    const { rows: hoyRes } = await pool.query(
      `SELECT (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS hoy_ar`
    );
    const hoyAR = hoyRes[0].hoy_ar;
    await pool.query(
      `UPDATE tenants SET paid_until = $1 WHERE id = ANY($2::int[])`,
      [hoyAR, [tenantAId, tenantBId]]
    );

    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });

    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
      });
    // Debería crear la op OK (paid_until = hoy AR → activo).
    expect(r.status).toBe(201);
  });

  it('P0-2 timezone: paid_until = AYER en zona del tenant → rebota (expired)', async () => {
    // Setear paid_until = "ayer" en zona AR — tenant DEBE quedar expired.
    const { rows: ayerRes } = await pool.query(
      `SELECT ((NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - INTERVAL '1 day')::date AS ayer_ar`
    );
    const ayerAR = ayerRes[0].ayer_ar;
    await pool.query(
      `UPDATE tenants SET paid_until = $1 WHERE id = $2`,
      [ayerAR, tenantAId]
    );
    // Invalidar cache de tenantStatus para que el middleware releea (sin
    // esto, si otro test previo cacheó el tenant como active, seguirá dando OK).
    const { invalidateTenantStatus } = require('../src/lib/tenantStatus');
    await invalidateTenantStatus(tenantAId);

    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });

    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
      });
    // El middleware `requireActiveTenant` rebota primero con 402
    // (tenant expirado a nivel billing). Si por alguna razón el middleware
    // no está activo en el test env, el handler devuelve 409 seller_expired.
    // Ambos son válidos: lo importante es que NO devuelve 201 (op creada).
    expect(r.status).not.toBe(201);
    expect([402, 409]).toContain(r.status);
    if (r.status === 409) {
      expect(r.body.reason).toBe('seller_expired');
    }
  });

  it('partnership revocada → 409 partnership_not_active', async () => {
    const [a, b] = tenantAId < tenantBId ? [tenantAId, tenantBId] : [tenantBId, tenantAId];
    const ins = await pool.query(
      `INSERT INTO tenant_partnerships
         (tenant_a_id, tenant_b_id, status,
          invited_by_tenant_id, invited_by_user_id,
          revoked_by_tenant_id, revoked_by_user_id, revoked_at)
       VALUES ($1, $2, 'revoked', $3, $4, $3, $4, NOW())
       RETURNING id`,
      [a, b, tenantAId, userAId]
    );
    const partnershipId = ins.rows[0].id;
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
      });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('partnership_not_active');
  });

  it('producto que no existe → 404 producto_not_found', async () => {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: 9999999, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
      });
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('producto_not_found');
  });

  it('total_usd no matchea suma items → 400 total_usd_mismatch', async () => {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 2, precio_usd: 500 }],
        tc: 1000, total_usd: 9999, total_ars: 9999000, // wrong (should be 1000)
      });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe('total_usd_mismatch');
  });

  it('seller suspended → bloqueado (4XX)', async () => {
    // Cuando el tenant está suspended, el middleware requireActiveTenant
    // global del portal rechaza CUALQUIER write con 402 (Payment Required)
    // antes incluso de llegar a nuestro endpoint. Nuestra propia validación
    // de seller_suspended (en validateOperationPrecondition) es defense
    // in depth — se ejecutaría si el middleware fuera bypaseado.
    // Aceptamos 402 (middleware) o 409 (validación nuestra) — ambos
    // bloquean la operación, que es el invariant que importa.
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });
    await pool.query(`UPDATE tenants SET suspended_at = NOW() WHERE id = $1`, [tenantAId]);
    try {
      const r = await request(app)
        .post('/api/red-b2b/operations')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          partnership_id: partnershipId,
          items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
          tc: 1000, total_usd: 100, total_ars: 100000,
        });
      expect([402, 409]).toContain(r.status);
      // Verificar nada se persistió.
      const ops = await pool.query(`SELECT COUNT(*) FROM cross_tenant_operations WHERE seller_tenant_id = $1`, [tenantAId]);
      expect(Number(ops.rows[0].count)).toBe(0);
    } finally {
      await pool.query(`UPDATE tenants SET suspended_at = NULL WHERE id = $1`, [tenantAId]);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Atomicity: stock_insufficient revierte TODO
// ──────────────────────────────────────────────────────────────────────────
describe('POST /api/red-b2b/operations — atomicity', () => {
  it('stock_insufficient revierte TODO (sin filas en ninguna tabla)', async () => {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 2 }); // solo 2
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 5, precio_usd: 100 }],
        tc: 1000, total_usd: 500, total_ars: 500000,
      });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('stock_insufficient');

    // Verify nada se persistió.
    const opsQ = await pool.query(`SELECT COUNT(*) FROM cross_tenant_operations WHERE seller_tenant_id = $1`, [tenantAId]);
    expect(Number(opsQ.rows[0].count)).toBe(0);

    const movsSellerQ = await pool.query(`SELECT COUNT(*) FROM movimientos_cc WHERE tenant_id = $1`, [tenantAId]);
    expect(Number(movsSellerQ.rows[0].count)).toBe(0);

    const movsBuyerQ = await pool.query(`SELECT COUNT(*) FROM proveedor_movimientos WHERE tenant_id = $1`, [tenantBId]);
    expect(Number(movsBuyerQ.rows[0].count)).toBe(0);

    const buyerProdsQ = await pool.query(`SELECT COUNT(*) FROM productos WHERE tenant_id = $1`, [tenantBId]);
    expect(Number(buyerProdsQ.rows[0].count)).toBe(0);

    // Stock del seller intacto.
    const sellerProdQ = await pool.query(`SELECT cantidad FROM productos WHERE id = $1`, [prodId]);
    expect(Number(sellerProdQ.rows[0].cantidad)).toBe(2);
  });

  it('cross_tenant_operations.id se enlaza correctamente a venta + compra', async () => {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
      });
    const opId = r.body.operation.id;
    const sellerMovQ = await pool.query(
      `SELECT cross_tenant_operation_id FROM movimientos_cc WHERE tenant_id = $1`,
      [tenantAId]
    );
    const buyerMovQ = await pool.query(
      `SELECT cross_tenant_operation_id FROM proveedor_movimientos WHERE tenant_id = $1`,
      [tenantBId]
    );
    expect(Number(sellerMovQ.rows[0].cross_tenant_operation_id)).toBe(Number(opId));
    expect(Number(buyerMovQ.rows[0].cross_tenant_operation_id)).toBe(Number(opId));
  });

  it('multi-item con un producto insuficiente → rollback completo', async () => {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodOkId = await insertSellerProducto(tenantAId, { nombre: 'OK', cantidad: 100 });
    const prodLowId = await insertSellerProducto(tenantAId, { nombre: 'LOW', cantidad: 1 });
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [
          { producto_id: prodOkId,  cantidad: 5, precio_usd: 50 },
          { producto_id: prodLowId, cantidad: 5, precio_usd: 50 }, // solo hay 1
        ],
        tc: 1000, total_usd: 500, total_ars: 500000,
      });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('stock_insufficient');
    // Stock del producto OK NO debe haberse decrementado.
    const okStockQ = await pool.query(`SELECT cantidad FROM productos WHERE id = $1`, [prodOkId]);
    expect(Number(okStockQ.rows[0].cantidad)).toBe(100);
    const lowStockQ = await pool.query(`SELECT cantidad FROM productos WHERE id = $1`, [prodLowId]);
    expect(Number(lowStockQ.rows[0].cantidad)).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// RLS leak attempts
// ──────────────────────────────────────────────────────────────────────────
describe('RLS leak attempts', () => {
  it('Tenant C POST con partnership A↔B → 403/404 caller_not_in_partnership', async () => {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantCId, { cantidad: 10 });
    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenC}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
      });
    // getPartnershipByIdForTenant no encuentra la partnership porque tenant C no
    // participa → result.error = 'partnership_not_active' (status 404).
    expect([403, 404]).toContain(r.status);
    expect(['partnership_not_active', 'caller_not_in_partnership']).toContain(r.body.reason);
  });

  it('Tenant C GET /:id de op A↔B → 404', async () => {
    // Crear op entre A y B.
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });
    const created = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
      });
    expect(created.status).toBe(201);
    const opId = created.body.operation.id;

    // Tenant C intenta leer.
    const r = await request(app)
      .get(`/api/red-b2b/operations/${opId}`)
      .set('Authorization', `Bearer ${tokenC}`);
    expect(r.status).toBe(404);
  });

  it('GET / no retorna ops ajenas (tenant C lista, no ve la op A↔B)', async () => {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });
    await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
      });
    const r = await request(app)
      .get('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenC}`);
    expect(r.status).toBe(200);
    expect(r.body.operations).toEqual([]);
  });

  it('Tenant C intenta cancel op A↔B → 404', async () => {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });
    const created = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
      });
    expect(created.status).toBe(201);
    const opId = created.body.operation.id;
    const r = await request(app)
      .post(`/api/red-b2b/operations/${opId}/cancel`)
      .set('Authorization', `Bearer ${tokenC}`)
      .send({ reason: 'hack attempt' });
    expect(r.status).toBe(404);
  });

  // PR-E #464: gap detectado en audit focal Red B2B — PATCH /:id sin test
  // de cross-tenant. Mismo filtro que cancel (`seller_tenant_id = $caller OR
  // buyer_tenant_id = $caller`) → tenant C no ve la op → 404 + las notas
  // originales no se tocan.
  it('Tenant C intenta PATCH op A↔B (edit notes) → 404 + notes no cambian', async () => {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });
    const created = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
        notes: 'nota original del seller',
      });
    expect(created.status).toBe(201);
    const opId = created.body.operation.id;

    const r = await request(app)
      .patch(`/api/red-b2b/operations/${opId}`)
      .set('Authorization', `Bearer ${tokenC}`)
      .send({ notes: 'leak cross-tenant intento' });
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('not_found');

    // Las notas del seller (movimientos_cc.notas) siguen siendo las originales.
    const movQ = await pool.query(
      `SELECT notas FROM movimientos_cc
         WHERE tenant_id = $1 AND cross_tenant_operation_id = $2`,
      [tenantAId, opId]
    );
    expect(movQ.rows.length).toBe(1);
    expect(movQ.rows[0].notas).toBe('nota original del seller');
    expect(movQ.rows[0].notas).not.toContain('leak');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /:id
// ──────────────────────────────────────────────────────────────────────────
describe('GET /api/red-b2b/operations/:id', () => {
  it('devuelve detalle full con items + my_side', async () => {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });
    const created = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 2, precio_usd: 250 }],
        tc: 1200, total_usd: 500, total_ars: 600000, notes: 'Test note',
      });
    expect(created.status).toBe(201);
    const opId = created.body.operation.id;
    const r = await request(app)
      .get(`/api/red-b2b/operations/${opId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.operation.id).toBeDefined();
    expect(r.body.operation.my_side).toBe('seller');
    expect(r.body.operation.items.length).toBe(1);
    expect(Number(r.body.operation.items[0].cantidad)).toBe(2);
    expect(r.body.operation.partner).toBeTruthy();

    // El buyer también puede leer y my_side='buyer'.
    const rb = await request(app)
      .get(`/api/red-b2b/operations/${opId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(rb.status).toBe(200);
    expect(rb.body.operation.my_side).toBe('buyer');
  });

  it('404 si la op no existe', async () => {
    const r = await request(app)
      .get('/api/red-b2b/operations/9999999')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /:id/cancel
// ──────────────────────────────────────────────────────────────────────────
describe('POST /api/red-b2b/operations/:id/cancel', () => {
  async function createOp() {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { nombre: 'Cancel test', cantidad: 10 });
    const created = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 3, precio_usd: 100 }],
        tc: 1000, total_usd: 300, total_ars: 300000,
      });
    expect(created.status).toBe(201);
    return { opId: created.body.operation.id, sellerProdId: prodId };
  }

  it('revierte stock del seller (suma cantidades)', async () => {
    const { opId, sellerProdId } = await createOp();
    // Stock del seller debería ser 7 (10 - 3).
    const before = await pool.query(`SELECT cantidad FROM productos WHERE id = $1`, [sellerProdId]);
    expect(Number(before.rows[0].cantidad)).toBe(7);

    const r = await request(app)
      .post(`/api/red-b2b/operations/${opId}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ reason: 'test cancel' });
    expect(r.status).toBe(200);

    // Stock del seller debería volver a 10.
    const after = await pool.query(`SELECT cantidad FROM productos WHERE id = $1`, [sellerProdId]);
    expect(Number(after.rows[0].cantidad)).toBe(10);
  });

  it('idempotente: segundo cancel → 409 already_cancelled', async () => {
    const { opId } = await createOp();
    await request(app)
      .post(`/api/red-b2b/operations/${opId}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    const r = await request(app)
      .post(`/api/red-b2b/operations/${opId}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('already_cancelled');
  });

  it('solo seller puede cancelar (buyer → 403 only_seller_can_cancel)', async () => {
    const { opId } = await createOp();
    const r = await request(app)
      .post(`/api/red-b2b/operations/${opId}/cancel`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({});
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('only_seller_can_cancel');
  });

  it('notif operation_cancelled al buyer', async () => {
    const { opId } = await createOp();
    // Limpiar notifs previas del buyer (la de operation_received).
    await pool.query(`DELETE FROM cross_tenant_notifications WHERE tenant_id = $1 AND type = 'operation_received'`, [tenantBId]);
    await request(app)
      .post(`/api/red-b2b/operations/${opId}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ reason: 'mistake' });
    const notifQ = await pool.query(
      `SELECT type, payload FROM cross_tenant_notifications WHERE tenant_id = $1 AND type = 'operation_cancelled'`,
      [tenantBId]
    );
    expect(notifQ.rows.length).toBe(1);
    expect(notifQ.rows[0].payload.reason).toBe('mistake');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /:id (solo notes)
// ──────────────────────────────────────────────────────────────────────────
describe('PATCH /api/red-b2b/operations/:id', () => {
  async function createOp() {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { cantidad: 10 });
    const created = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 1, precio_usd: 100 }],
        tc: 1000, total_usd: 100, total_ars: 100000,
      });
    return created.body.operation.id;
  }

  it('PATCH notes solo seller (buyer → 403)', async () => {
    const opId = await createOp();
    const r = await request(app)
      .patch(`/api/red-b2b/operations/${opId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ notes: 'Buyer trying to edit' });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('only_seller_can_edit');
  });

  it('PATCH actualiza last_modified_at', async () => {
    const opId = await createOp();
    const before = await pool.query(`SELECT last_modified_at FROM cross_tenant_operations WHERE id = $1`, [opId]);
    expect(before.rows[0].last_modified_at).toBeNull();

    const r = await request(app)
      .patch(`/api/red-b2b/operations/${opId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ notes: 'Updated note' });
    expect(r.status).toBe(200);

    const after = await pool.query(`SELECT last_modified_at, last_modified_by_user_id FROM cross_tenant_operations WHERE id = $1`, [opId]);
    expect(after.rows[0].last_modified_at).not.toBeNull();
    expect(after.rows[0].last_modified_by_user_id).toBe(userAId);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PR-B Bug H2: cancel rebote cuando hay pagos cross-tenant previos.
//
// Decisión #10 (cancelaciones unilaterales NO permitidas que rompan saldos).
// Si la op tiene pagos en cross_tenant_pagos, el cancel:
//   - soft-deletea movimientos_cc/proveedor_movimientos de la COMPRA original
//   - pero NO toca los pagos previos ni los movimientos tipo='pago'
//   - resultado: cliente CC con plata fantasma + proveedor pagado sin compra
//
// Fix: 409 op_has_pagos con detalle. Sin override. El operador usa devolución
// bilateral o coordina reverso manual.
// ──────────────────────────────────────────────────────────────────────────
describe('PR-B Bug H2: cancel guard cuando op tiene pagos', () => {
  // SEG-1 (audit 2026-07-06): metodos_pago es tenant-scoped. Caller es tokenA
  // (seller) → necesitamos caja PROPIA de A. `resolveCajaParaTenant` para el
  // buyer (B) también filtra por tenant — así que B también necesita su caja.
  let cajaUsdIdOps, cajaUsdIdOpsB;

  beforeAll(async () => {
    const cA = await pool.query(
      `INSERT INTO metodos_pago (tenant_id, nombre, moneda, activo)
       VALUES ($1, 'RB2B-Ops H2 A USD', 'USD', true) RETURNING id`,
      [tenantAId]
    );
    cajaUsdIdOps = cA.rows[0].id;
    const cB = await pool.query(
      `INSERT INTO metodos_pago (tenant_id, nombre, moneda, activo)
       VALUES ($1, 'RB2B-Ops H2 B USD', 'USD', true) RETURNING id`,
      [tenantBId]
    );
    cajaUsdIdOpsB = cB.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM metodos_pago WHERE id = ANY($1::int[])',
      [[cajaUsdIdOps, cajaUsdIdOpsB].filter(Boolean)]);
  });

  async function createOpAndPay(montoUsd) {
    const partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
    const prodId = await insertSellerProducto(tenantAId, { nombre: `H2 test ${Date.now()}`, cantidad: 10 });
    const created = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [{ producto_id: prodId, cantidad: 3, precio_usd: 100 }],
        tc: 1000, total_usd: 300, total_ars: 300000,
      });
    expect(created.status).toBe(201);
    const opId = created.body.operation.id;

    if (montoUsd && montoUsd > 0) {
      const pago = await request(app)
        .post(`/api/red-b2b/operations/${opId}/pagos`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          monto_usd: montoUsd, moneda_pago: 'USD', monto_pago: montoUsd,
          tc_pago: 1000, caja_id: cajaUsdIdOps, side: 'seller',
        });
      expect(pago.status).toBe(201);
    }
    return { opId, sellerProdId: prodId };
  }

  it('op SIN pagos → cancel 200 OK (regresión: comportamiento normal)', async () => {
    const { opId } = await createOpAndPay(0);
    const r = await request(app)
      .post(`/api/red-b2b/operations/${opId}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ reason: 'no pagos previos' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('cancelled');
  });

  it('op CON pagos → 409 op_has_pagos + payload con pagos_count y pagado_usd', async () => {
    const { opId } = await createOpAndPay(100);

    const r = await request(app)
      .post(`/api/red-b2b/operations/${opId}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ reason: 'intent to cancel with pagos' });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('op_has_pagos');
    expect(r.body.details.pagos_count).toBe(1);
    expect(r.body.details.pagado_usd).toBe(100);

    // Verificar que la op SIGUE active (no se cancelled).
    const opStatus = await pool.query(
      `SELECT status FROM cross_tenant_operations WHERE id = $1`, [opId]
    );
    expect(opStatus.rows[0].status).toBe('active');
  });

  it('op CON pagos: stock del seller NO se revierte (guard antes del SET LOCAL stock)', async () => {
    const { opId, sellerProdId } = await createOpAndPay(100);

    // Stock pre-cancel: 10 inicial - 3 vendidos = 7.
    const before = await pool.query(`SELECT cantidad FROM productos WHERE id = $1`, [sellerProdId]);
    expect(Number(before.rows[0].cantidad)).toBe(7);

    const r = await request(app)
      .post(`/api/red-b2b/operations/${opId}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    expect(r.status).toBe(409);

    // Stock NO se revirtió (el guard frenó antes del UPDATE productos).
    const after = await pool.query(`SELECT cantidad FROM productos WHERE id = $1`, [sellerProdId]);
    expect(Number(after.rows[0].cantidad)).toBe(7);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PR-D #463 — Bulk auto-create de productos del buyer (N+1 → 1 query)
//
// Verifica que la nueva findOrCreateBuyerProductos:
//   1. Crea N productos del buyer en orden correcto cuando hay N items.
//   2. Maneja correctamente items con MISMO nombre (sin dedup, ambos creados).
//   3. Reduce drásticamente el query count en POST /operations.
// ──────────────────────────────────────────────────────────────────────────
describe('PR-D Bulk B3: auto-create productos buyer en una query', () => {
  let partnershipId;

  beforeEach(async () => {
    partnershipId = await createActivePartnership(tenantAId, tenantBId, tenantAId);
  });

  it('10 items distintos → 10 productos del buyer en ORDEN correcto', async () => {
    // Crear 10 productos del seller con nombres distintos y costos distintos
    // (para poder asociar cada producto del buyer con su seller_producto_id
    // específico via cross_tenant_operation_items).
    const prods = [];
    for (let i = 1; i <= 10; i++) {
      const id = await insertSellerProducto(tenantAId, {
        nombre: `BulkProd-${String(i).padStart(2, '0')}`,  // BulkProd-01..BulkProd-10
        cantidad: 50,
        costo: 100 + i,  // distinto por item
      });
      prods.push({ id, nombre: `BulkProd-${String(i).padStart(2, '0')}`, costo: 100 + i });
    }

    // Construir 10 items con cantidad distinta por item (1..10) y precio
    // distinto (200..209) para poder verificar el mapping post-insert.
    const items = prods.map((p, idx) => ({
      producto_id: p.id,
      cantidad: idx + 1,
      precio_usd: 200 + idx,
    }));
    const total_usd = items.reduce((acc, it) => acc + it.cantidad * it.precio_usd, 0);

    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items,
        tc: 1000,
        total_usd,
        total_ars: total_usd * 1000,
      });
    expect(r.status).toBe(201);

    // Verificar que se crearon EXACTAMENTE 10 productos del buyer, con
    // mapping correcto: seller_producto_id ↔ buyer_producto_id según cantidad
    // y costo (nombre + cantidad son identificadores únicos por item).
    const buyerProds = await pool.query(
      `SELECT id, nombre, cantidad, costo, created_from_cross_tenant_op_id
         FROM productos WHERE tenant_id = $1 ORDER BY id`,
      [tenantBId]
    );
    expect(buyerProds.rows.length).toBe(10);

    // Verificar el mapping leyendo cross_tenant_operation_items y matcheando
    // por seller_producto_id → seller.nombre y seller.costo.
    const itemsQ = await pool.query(
      `SELECT cti.seller_producto_id, cti.buyer_producto_id, cti.cantidad,
              cti.precio_unitario_usd, bp.nombre AS buyer_nombre, bp.costo AS buyer_costo
         FROM cross_tenant_operation_items cti
         JOIN productos bp ON bp.id = cti.buyer_producto_id
         WHERE cti.cross_tenant_operation_id = $1
         ORDER BY cti.id`,
      [r.body.operation.id]
    );
    expect(itemsQ.rows.length).toBe(10);

    // Para cada item input, verificar que el buyer_producto tiene el
    // nombre y costo correctos derivados del seller_producto correspondiente.
    for (let idx = 0; idx < 10; idx++) {
      const row = itemsQ.rows[idx];
      const sellerProd = prods[idx];
      // El seller_producto_id en cti debe matchear el del input.
      expect(Number(row.seller_producto_id)).toBe(sellerProd.id);
      // El buyer_producto.nombre debe ser el nombre del seller correspondiente.
      expect(row.buyer_nombre).toBe(sellerProd.nombre);
      // El buyer_producto.costo debe ser el precio_usd del item (regla F3).
      expect(Number(row.buyer_costo)).toBe(200 + idx);
      // La cantidad en cti debe matchear el input.
      expect(Number(row.cantidad)).toBe(idx + 1);
    }
  });

  it('2 items con seller_prods de MISMO nombre → 2 productos buyer separados (sin dedup)', async () => {
    // Dos productos del seller con NOMBRE igual pero costos distintos.
    // (En el catálogo retail nada impide nombres duplicados.)
    const prodAId = await insertSellerProducto(tenantAId, {
      nombre: 'Mismo Nombre',
      cantidad: 5,
      costo: 100,
    });
    const prodBId = await insertSellerProducto(tenantAId, {
      nombre: 'Mismo Nombre',
      cantidad: 5,
      costo: 200,
    });

    const r = await request(app)
      .post('/api/red-b2b/operations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        partnership_id: partnershipId,
        items: [
          { producto_id: prodAId, cantidad: 2, precio_usd: 150 },
          { producto_id: prodBId, cantidad: 3, precio_usd: 250 },
        ],
        tc: 1000,
        total_usd: 2 * 150 + 3 * 250,
        total_ars: (2 * 150 + 3 * 250) * 1000,
      });
    expect(r.status).toBe(201);

    // El buyer debe tener 2 productos creados (SIN dedup por nombre).
    const buyerProds = await pool.query(
      `SELECT id, nombre, cantidad, costo
         FROM productos WHERE tenant_id = $1
         ORDER BY id`,
      [tenantBId]
    );
    expect(buyerProds.rows.length).toBe(2);
    expect(buyerProds.rows[0].nombre).toBe('Mismo Nombre');
    expect(buyerProds.rows[1].nombre).toBe('Mismo Nombre');

    // Verificar el orden + mapeo via cti.
    const itemsQ = await pool.query(
      `SELECT cti.seller_producto_id, cti.buyer_producto_id, cti.cantidad,
              bp.costo AS buyer_costo
         FROM cross_tenant_operation_items cti
         JOIN productos bp ON bp.id = cti.buyer_producto_id
         WHERE cti.cross_tenant_operation_id = $1
         ORDER BY cti.id`,
      [r.body.operation.id]
    );
    expect(itemsQ.rows.length).toBe(2);
    expect(Number(itemsQ.rows[0].seller_producto_id)).toBe(prodAId);
    expect(Number(itemsQ.rows[0].cantidad)).toBe(2);
    expect(Number(itemsQ.rows[0].buyer_costo)).toBe(150);  // primer item precio_usd
    expect(Number(itemsQ.rows[1].seller_producto_id)).toBe(prodBId);
    expect(Number(itemsQ.rows[1].cantidad)).toBe(3);
    expect(Number(itemsQ.rows[1].buyer_costo)).toBe(250);  // segundo item precio_usd
  });

  it('smoke perf: 10 items hace 1 sola sentencia INSERT INTO productos del buyer', async () => {
    // Contamos las sentencias `INSERT INTO productos` ejecutadas durante el
    // request, instrumentando `pool.connect` (mismo pattern que el repo usa
    // internamente para el int-cast logger). Cada client devuelto por el pool
    // tiene su `query` patcheado por la instrumentación; lo sobre-patcheamos
    // para contar también.
    //
    // Si volvemos a N+1 (loop singular), este test detecta 10 inserts en
    // lugar de 1.
    // `db` ES el pool (module.exports = pool en database.js). Ya tiene
    // .connect instrumentado. Replicamos el mismo pattern (soporta callback
    // y promise styles) para contar los INSERT INTO productos sin romper la
    // instrumentación previa.
    const db = require('../src/config/database');
    const originalConnect = db.connect.bind(db);
    const inserts = [];

    function patchClientForCount(client) {
      if (!client || client.__bulkCountPatched) return client;
      const origClientQuery = client.query.bind(client);
      client.query = function countingQuery(text, values, ...rest) {
        const sql = typeof text === 'string' ? text : (text && text.text) || '';
        if (/insert\s+into\s+productos\b/i.test(sql)) {
          inserts.push(sql.replace(/\s+/g, ' ').slice(0, 120));
        }
        return origClientQuery(text, values, ...rest);
      };
      client.__bulkCountPatched = true;
      return client;
    }

    db.connect = function instrumentedConnectForCount(...args) {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        const userCb = last;
        const newArgs = args.slice(0, -1);
        return originalConnect(...newArgs, (err, client, done) => {
          if (!err) patchClientForCount(client);
          userCb(err, client, done);
        });
      }
      return originalConnect(...args).then(patchClientForCount);
    };

    try {
      const prods = [];
      for (let i = 1; i <= 10; i++) {
        const id = await insertSellerProducto(tenantAId, {
          nombre: `SmokePerf-${i}`, cantidad: 20, costo: 50,
        });
        prods.push(id);
      }
      // Reset counter — solo nos interesan los INSERT durante el request,
      // no los del setup (insertSellerProducto hace INSERT INTO productos
      // del seller).
      inserts.length = 0;

      const items = prods.map((id, idx) => ({
        producto_id: id, cantidad: 1, precio_usd: 100 + idx,
      }));
      const total_usd = items.reduce((a, it) => a + it.cantidad * it.precio_usd, 0);

      const r = await request(app)
        .post('/api/red-b2b/operations')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          partnership_id: partnershipId,
          items, tc: 1000, total_usd, total_ars: total_usd * 1000,
        });
      expect(r.status).toBe(201);

      // Exactamente 1 sentencia INSERT INTO productos del buyer (la CTE bulk).
      // Antes del PR-D era N=10 (loop singular). Test guardia contra
      // regresión a N+1.
      expect(inserts.length).toBe(1);
    } finally {
      db.connect = originalConnect;
    }
  });
});

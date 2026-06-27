/**
 * Tests integration para Red B2B productos-pending-review (F2 #455).
 *
 * Cobertura (14 tests):
 *
 *   GET /:
 *     · Devuelve productos del propio tenant con pending=true
 *     · NO devuelve productos sin pending=true
 *     · NO devuelve productos deleted_at IS NOT NULL
 *     · NO devuelve productos de otros tenants (RLS leak test)
 *
 *   POST /:id/confirm-new:
 *     · Clearea el flag (UPDATE) y responde con producto
 *     · 404 si no existe
 *     · 404 si pertenece a otro tenant (RLS leak attempt)
 *     · 409 si ya estaba confirmed
 *
 *   POST /:id/merge-into:
 *     · Suma stock al target + soft-delete source
 *     · Migra referencias en venta_items
 *     · 400 si source == target
 *     · 404 si target pertenece a otro tenant
 *     · 400 si target ya está deleted
 *     · 409 si source no está pending (defensive)
 *
 *   Capability gate:
 *     · User sin cross_tenant.write → 403
 *
 * F2 trigger nota: el flag pending_cross_tenant_review SE FLIPPEA EN F3 por
 * el endpoint POST /api/red-b2b/operations cuando el seller crea una op. F2
 * solo agrega los endpoints buyer-side — los tests insertan el flag a mano
 * para simular F3. Las `created_from_cross_tenant_op_id` van NULL en F2
 * (no hay operations todavía), excepto en un test específico que verifica
 * la hidratación del partner.
 *
 * Setup:
 *   2 tenants extra (red-b2b-pr-test-a/-b) + 2 users con cap +
 *   1 user sin cap. Cleanup acotado al namespace en beforeEach + afterAll.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

const TENANT_A = { slug: 'red-b2b-pr-test-a', nombre: 'RedB2B PR Test A', plan: 'starter' };
const TENANT_B = { slug: 'red-b2b-pr-test-b', nombre: 'RedB2B PR Test B', plan: 'pro' };

let pool;
let tenantAId, tenantBId;
let userAId, userBId, userANoCapId;
let tokenA, tokenB, tokenANoCap;

function signToken({ id, username, email, tenant_id, caps = {} }) {
  return jwt.sign(
    {
      id, username, email,
      role: 'op',
      tenant_id,
      tenant_rol: 'admin',         // adminOnly bypassea — no nos importa acá
      tenant_cap_rol: 'custom',    // no bypass por rol del tenant
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
     ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre, plan = EXCLUDED.plan
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

// Inserta un producto con el flag pending_cross_tenant_review=true para
// simular el auto-create que F3 hará. Como `productos` tiene FORCE RLS,
// necesitamos SET LOCAL antes del INSERT.
async function insertPendingProducto(tenantId, opts = {}) {
  const { nombre = 'iPhone 15 Pro Test', cantidad = 5, costo = 800, precio = 1000, opId = null } = opts;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${tenantId}`);
    const r = await client.query(
      `INSERT INTO productos
         (tenant_id, nombre, cantidad, costo, precio_venta,
          pending_cross_tenant_review, created_from_cross_tenant_op_id)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       RETURNING id`,
      [tenantId, nombre, cantidad, costo, precio, opId]
    );
    await client.query('COMMIT');
    return r.rows[0].id;
  } finally {
    client.release();
  }
}

// Inserta un producto normal (sin el flag). Para casos donde queremos un
// "producto target" del catálogo del buyer.
async function insertNormalProducto(tenantId, opts = {}) {
  const { nombre = 'iPhone 15 Pro', cantidad = 10, costo = 800, precio = 1000 } = opts;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${tenantId}`);
    const r = await client.query(
      `INSERT INTO productos
         (tenant_id, nombre, cantidad, costo, precio_venta)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [tenantId, nombre, cantidad, costo, precio]
    );
    await client.query('COMMIT');
    return r.rows[0].id;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  pool = await setupTestDb();

  tenantAId = await createTenant(TENANT_A);
  tenantBId = await createTenant(TENANT_B);

  userAId = await createUserForTenant(tenantAId, {
    username: 'rb2b-pr-user-a', email: 'rb2b-pr-a@test.local',
  });
  userBId = await createUserForTenant(tenantBId, {
    username: 'rb2b-pr-user-b', email: 'rb2b-pr-b@test.local',
  });
  userANoCapId = await createUserForTenant(tenantAId, {
    username: 'rb2b-pr-user-a-nocap', email: 'rb2b-pr-a-nocap@test.local',
  });

  const capsOn = { 'cross_tenant.write': true };
  tokenA = signToken({
    id: userAId, username: 'rb2b-pr-user-a', email: 'rb2b-pr-a@test.local',
    tenant_id: tenantAId, caps: capsOn,
  });
  tokenB = signToken({
    id: userBId, username: 'rb2b-pr-user-b', email: 'rb2b-pr-b@test.local',
    tenant_id: tenantBId, caps: capsOn,
  });
  tokenANoCap = signToken({
    id: userANoCapId, username: 'rb2b-pr-user-a-nocap', email: 'rb2b-pr-a-nocap@test.local',
    tenant_id: tenantAId, caps: {},
  });
});

beforeEach(async () => {
  const ids = [tenantAId, tenantBId];
  // Productos + ventas del namespace — borramos también soft-deleted para
  // empezar limpios. Orden: venta_items (FK a ventas + productos) → ventas
  // → productos. CASCADE de venta_items por venta_id ya cubre el resto, pero
  // hacemos DELETE explícito por claridad.
  await pool.query(
    `DELETE FROM venta_items WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `DELETE FROM ventas WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `DELETE FROM productos WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
});

afterAll(async () => {
  const ids = [tenantAId, tenantBId];
  const userIds = [userAId, userBId, userANoCapId];

  await pool.query(`DELETE FROM venta_items WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM ventas WHERE tenant_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM productos WHERE tenant_id = ANY($1::int[])`, [ids]);
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
  it('user SIN cap → 403 en GET /', async () => {
    const r = await request(app)
      .get('/api/red-b2b/productos-pending-review')
      .set('Authorization', `Bearer ${tokenANoCap}`);
    expect(r.status).toBe(403);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /
// ──────────────────────────────────────────────────────────────────────────
describe('GET /api/red-b2b/productos-pending-review', () => {
  it('devuelve solo productos del propio tenant con pending=true', async () => {
    const idPendingA = await insertPendingProducto(tenantAId, { nombre: 'Pending A' });
    await insertNormalProducto(tenantAId, { nombre: 'Normal A' });
    await insertPendingProducto(tenantBId, { nombre: 'Pending B' });

    const r = await request(app)
      .get('/api/red-b2b/productos-pending-review')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.pendientes)).toBe(true);
    const ids = r.body.pendientes.map((p) => p.id);
    expect(ids).toContain(idPendingA);
    // Producto normal de A NO aparece (sin flag).
    // Producto pending de B NO aparece (otro tenant, RLS).
    expect(r.body.pendientes.length).toBe(1);
    expect(r.body.pendientes[0].nombre).toBe('Pending A');
  });

  it('NO devuelve productos sin el flag pending', async () => {
    await insertNormalProducto(tenantAId, { nombre: 'Normal solo' });
    const r = await request(app)
      .get('/api/red-b2b/productos-pending-review')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.pendientes.length).toBe(0);
  });

  it('NO devuelve productos soft-deleted', async () => {
    const id = await insertPendingProducto(tenantAId, { nombre: 'Pending deleted' });
    // Soft-delete vía SET LOCAL.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = ${tenantAId}`);
      await client.query(`UPDATE productos SET deleted_at = NOW() WHERE id = $1`, [id]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const r = await request(app)
      .get('/api/red-b2b/productos-pending-review')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.pendientes.length).toBe(0);
  });

  it('NO leakea productos pending de otros tenants (RLS)', async () => {
    await insertPendingProducto(tenantBId, { nombre: 'Solo B' });
    // A no tiene nada propio. Igual debe devolver lista vacía SIN ver lo de B.
    const r = await request(app)
      .get('/api/red-b2b/productos-pending-review')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.pendientes.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /:id/confirm-new
// ──────────────────────────────────────────────────────────────────────────
describe('POST /:id/confirm-new', () => {
  it('clearea el flag (UPDATE) y responde 200', async () => {
    const id = await insertPendingProducto(tenantAId);
    const r = await request(app)
      .post(`/api/red-b2b/productos-pending-review/${id}/confirm-new`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.producto.pending_cross_tenant_review).toBe(false);

    // Verificar en DB.
    const row = await pool.query(
      `SELECT pending_cross_tenant_review FROM productos WHERE id = $1`,
      [id]
    );
    expect(row.rows[0].pending_cross_tenant_review).toBe(false);
  });

  it('404 si el producto no existe', async () => {
    const r = await request(app)
      .post('/api/red-b2b/productos-pending-review/9999999/confirm-new')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('not_found');
  });

  it('404 si el producto pertenece a otro tenant (RLS leak attempt)', async () => {
    const idDeB = await insertPendingProducto(tenantBId);
    const r = await request(app)
      .post(`/api/red-b2b/productos-pending-review/${idDeB}/confirm-new`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('not_found');

    // El producto de B debe seguir intacto (no fue modificado).
    const row = await pool.query(
      `SELECT pending_cross_tenant_review FROM productos WHERE id = $1`,
      [idDeB]
    );
    expect(row.rows[0].pending_cross_tenant_review).toBe(true);
  });

  it('409 si el producto ya estaba confirmed (flag=false)', async () => {
    const id = await insertNormalProducto(tenantAId);
    const r = await request(app)
      .post(`/api/red-b2b/productos-pending-review/${id}/confirm-new`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('already_confirmed');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /:id/merge-into
// ──────────────────────────────────────────────────────────────────────────
describe('POST /:id/merge-into', () => {
  it('suma stock al target y soft-deletes el source', async () => {
    const sourceId = await insertPendingProducto(tenantAId, { cantidad: 5 });
    const targetId = await insertNormalProducto(tenantAId, { cantidad: 10 });

    const r = await request(app)
      .post(`/api/red-b2b/productos-pending-review/${sourceId}/merge-into`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_producto_id: targetId });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.stock_added).toBe(5);
    expect(r.body.target_producto.stock).toBe(15);

    // Source soft-deleted.
    const srcRow = await pool.query(
      `SELECT deleted_at FROM productos WHERE id = $1`,
      [sourceId]
    );
    expect(srcRow.rows[0].deleted_at).not.toBeNull();

    // Target stock actualizado.
    const tgtRow = await pool.query(
      `SELECT cantidad FROM productos WHERE id = $1`,
      [targetId]
    );
    expect(Number(tgtRow.rows[0].cantidad)).toBe(15);
  });

  it('migra referencias en venta_items hacia el target', async () => {
    const sourceId = await insertPendingProducto(tenantAId, { cantidad: 3 });
    const targetId = await insertNormalProducto(tenantAId, { cantidad: 7 });

    // Crear venta + venta_item referenciando al source. Schema de ventas
    // (multi-tenant): order_id NOT NULL, fecha DATE NOT NULL, total_usd.
    // venta_items: tenant_id + producto_id + descripcion + cantidad + precio_vendido.
    const client = await pool.connect();
    let ventaId;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = ${tenantAId}`);
      const ventaR = await client.query(
        `INSERT INTO ventas (tenant_id, order_id, fecha, total_usd)
         VALUES ($1, $2, CURRENT_DATE, 100) RETURNING id`,
        [tenantAId, `test-merge-${Date.now()}`]
      );
      ventaId = ventaR.rows[0].id;
      await client.query(
        `INSERT INTO venta_items (tenant_id, venta_id, producto_id, descripcion, cantidad, precio_vendido, costo)
         VALUES ($1, $2, $3, 'Test', 1, 100, 80)`,
        [tenantAId, ventaId, sourceId]
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const r = await request(app)
      .post(`/api/red-b2b/productos-pending-review/${sourceId}/merge-into`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_producto_id: targetId });
    expect(r.status).toBe(200);

    // venta_items.producto_id ahora apunta a target, no a source.
    const vi = await pool.query(
      `SELECT producto_id FROM venta_items WHERE venta_id = $1`,
      [ventaId]
    );
    expect(vi.rows.length).toBe(1);
    expect(vi.rows[0].producto_id).toBe(targetId);
  });

  it('400 si source == target', async () => {
    const id = await insertPendingProducto(tenantAId);
    const r = await request(app)
      .post(`/api/red-b2b/productos-pending-review/${id}/merge-into`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_producto_id: id });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe('source_equals_target');
  });

  it('404 si target pertenece a otro tenant (RLS leak attempt)', async () => {
    const sourceId = await insertPendingProducto(tenantAId);
    const targetIdDeB = await insertNormalProducto(tenantBId);
    const r = await request(app)
      .post(`/api/red-b2b/productos-pending-review/${sourceId}/merge-into`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_producto_id: targetIdDeB });
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('target_not_found');

    // Source NO debe estar soft-deleted (el merge falló antes).
    const srcRow = await pool.query(
      `SELECT deleted_at FROM productos WHERE id = $1`,
      [sourceId]
    );
    expect(srcRow.rows[0].deleted_at).toBeNull();
  });

  it('400 si target ya está deleted', async () => {
    const sourceId = await insertPendingProducto(tenantAId);
    const targetId = await insertNormalProducto(tenantAId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = ${tenantAId}`);
      await client.query(
        `UPDATE productos SET deleted_at = NOW() WHERE id = $1`,
        [targetId]
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const r = await request(app)
      .post(`/api/red-b2b/productos-pending-review/${sourceId}/merge-into`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_producto_id: targetId });
    // El lookup busca AND tenant_id=mio (no filtra por deleted_at) y devuelve
    // la fila — luego el código rechaza con target_deleted. Spec dice 400.
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe('target_deleted');
  });

  it('409 si source no está pending (defensive)', async () => {
    // Source es un producto normal del catálogo (sin flag) — no debería poder
    // mergearse "como pending" porque no es pending.
    const sourceId = await insertNormalProducto(tenantAId);
    const targetId = await insertNormalProducto(tenantAId, { nombre: 'Otro' });
    const r = await request(app)
      .post(`/api/red-b2b/productos-pending-review/${sourceId}/merge-into`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_producto_id: targetId });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('source_not_pending');
  });
});

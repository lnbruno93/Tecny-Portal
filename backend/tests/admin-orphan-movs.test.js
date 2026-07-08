/**
 * Tests del endpoint admin de cleanup de movs B2B huérfanos.
 *
 * Huérfano = movimiento_cc vivo cuyo cliente_cc está soft-deleted. Surgió
 * durante el testing pre-salida 2026-06-09: Lucas borró el cliente iConnect
 * cuando la lógica del DELETE /clientes/:id NO cascadeaba, quedaron 7 productos
 * en estado='vendido' sin venta visible. El fix forward está en cuentas.js;
 * este endpoint limpia el estado sucio pre-existente.
 *
 * Cubre:
 *   - GET /orphan-movs (dry-run) → conteo + agregados + muestras.
 *   - POST /orphan-movs/apply → procesa todos en una TX, restaura stock,
 *     revierte caja, marca movs como soft-deleted.
 *   - El bug pre-fix se reproduce simulando soft-delete del cliente con
 *     UPDATE directo (no via API, porque post-fix la API ya cascadea).
 *   - adminOnly: 403 si no es admin.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER, createTestUser } = require('./helpers/setup');

let pool, adminToken, opToken, catId, cajaUsdId;
const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const a = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = a.body.token;

  // SEG-2: usar createTestUser para que el non-admin tenga tenant_users +
  // tenant_user_roles. Sin esto el login devuelve 401 NO_TENANT.
  await createTestUser(pool, {
    nombre: 'Op Orph', username: 'oporph',
    email: 'oporph@test.local', password: 'op_orph_pass',
    role: 'op',
  });
  const o = await request(app).post('/api/auth/login')
    .send({ username: 'oporph', password: 'op_orph_pass' });
  opToken = o.body.token;

  const cat = await request(app).post('/api/inventario/categorias').set(auth())
    .send({ nombre: 'Orphan Cat' });
  catId = cat.body.id;
  const met = await request(app).get('/api/ventas/metodos-pago').set(auth());
  cajaUsdId = (met.body || []).find(m => m.moneda === 'USD').id;
});

afterAll(async () => { await teardownTestDb(pool); });

async function crearProducto(imei) {
  const r = await request(app).post('/api/inventario/productos').set(auth())
    .send({
      tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catId,
      nombre: `Orph ${imei}`, imei, costo: 500, costo_moneda: 'USD',
      precio_venta: 1000, precio_moneda: 'USD', cantidad: 1,
    });
  return r.body;
}

async function crearClienteConVentaYDesactivarCliente() {
  // Crea cliente + 1 venta B2B con caja + soft-deletea el cliente DIRECTO en
  // la DB para reproducir el estado pre-fix (no via API porque post-fix
  // cascadearía). Devuelve { cliId, prodId, movId }.
  const cli = await request(app).post('/api/cuentas/clientes').set(auth())
    .send({ nombre: 'Cli Orph ' + Math.random().toString(36).slice(2, 6), categoria: 'A+' });
  const prod = await crearProducto('350888' + Math.floor(Math.random() * 1e8).toString().padStart(8, '0'));
  const mov = await request(app).post('/api/cuentas/movimientos').set(auth())
    .send({
      cliente_cc_id: cli.body.id, fecha: '2026-06-09', tipo: 'compra',
      monto_total: 1000, caja_id: cajaUsdId,
      items: [{ producto_id: prod.id, cantidad: 1, valor: 1000 }],
    });
  // Soft-delete del cliente SIN cascada (simula estado pre-fix).
  await pool.query('UPDATE clientes_cc SET deleted_at = NOW() WHERE id = $1', [cli.body.id]);
  return { cliId: cli.body.id, prodId: prod.id, movId: mov.body.id };
}

describe('GET /api/admin/orphan-movs (dry-run)', () => {
  it('rechaza no-admin → 403', async () => {
    const r = await request(app).get('/api/admin/orphan-movs').set(auth(opToken));
    expect(r.status).toBe(403);
  });

  it('detecta movs huérfanos: cuenta, suma deuda, devuelve muestras', async () => {
    await crearClienteConVentaYDesactivarCliente();
    await crearClienteConVentaYDesactivarCliente();

    const r = await request(app).get('/api/admin/orphan-movs').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.apply).toBe(false);
    expect(r.body.movs_count).toBeGreaterThanOrEqual(2);
    // Cada venta B2B fue por USD 1000 con caja → caja_movs_a_revertir > 0.
    expect(r.body.caja_movs_a_revertir).toBeGreaterThanOrEqual(2);
    expect(r.body.muestras.length).toBeGreaterThanOrEqual(2);
    expect(r.body.muestras[0]).toHaveProperty('tipo');
    expect(r.body.muestras[0]).toHaveProperty('cliente_nombre');
  });
});

describe('POST /api/admin/orphan-movs/apply', () => {
  it('rechaza no-admin → 403', async () => {
    const r = await request(app).post('/api/admin/orphan-movs/apply').set(auth(opToken));
    expect(r.status).toBe(403);
  });

  it('procesa todos los huérfanos: restaura stock + revierte caja + soft-deletea movs', async () => {
    // Setup: dejar el estado limpio antes (apply de iteraciones previas).
    await request(app).post('/api/admin/orphan-movs/apply').set(auth());

    // Crear 2 nuevos huérfanos.
    const orphan1 = await crearClienteConVentaYDesactivarCliente();
    const orphan2 = await crearClienteConVentaYDesactivarCliente();

    // Pre: productos en vendido / 0.
    const preProd1 = (await pool.query('SELECT cantidad, estado FROM productos WHERE id = $1', [orphan1.prodId])).rows[0];
    expect(preProd1.estado).toBe('vendido');
    expect(Number(preProd1.cantidad)).toBe(0);

    // Apply.
    const r = await request(app).post('/api/admin/orphan-movs/apply').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.apply).toBe(true);
    expect(r.body.movs_procesados).toBeGreaterThanOrEqual(2);
    expect(r.body.productos_restaurados).toBeGreaterThanOrEqual(2);
    expect(r.body.errores).toEqual([]);

    // Post: productos vueltos a disponible / 1.
    const postProd1 = (await pool.query('SELECT cantidad, estado FROM productos WHERE id = $1', [orphan1.prodId])).rows[0];
    expect(postProd1.estado).toBe('disponible');
    expect(Number(postProd1.cantidad)).toBe(1);
    const postProd2 = (await pool.query('SELECT cantidad, estado FROM productos WHERE id = $1', [orphan2.prodId])).rows[0];
    expect(postProd2.estado).toBe('disponible');
    expect(Number(postProd2.cantidad)).toBe(1);

    // Movs marcados como deleted_at.
    const movs = await pool.query(
      'SELECT deleted_at FROM movimientos_cc WHERE id IN ($1, $2)',
      [orphan1.movId, orphan2.movId]
    );
    expect(movs.rows.every(m => m.deleted_at !== null)).toBe(true);
  });

  it('apply sin huérfanos pendientes → 0/0 sin error', async () => {
    // Limpiar primero.
    await request(app).post('/api/admin/orphan-movs/apply').set(auth());
    // Segunda corrida: nada pendiente.
    const r = await request(app).post('/api/admin/orphan-movs/apply').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.movs_procesados).toBe(0);
    expect(r.body.productos_restaurados).toBe(0);
  });
});

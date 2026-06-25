/**
 * Tests de endpoints admin para diagnóstico/restauración de stock.
 *
 * Nacieron durante el testing pre-salida del 2026-06-09: Lucas reportó que 7
 * productos quedaron en estado='vendido' después de borrar la venta B2B que
 * los había descontado. La reproducción local del flujo (POST → DELETE)
 * funcionaba bien, pero los datos en prod mostraban lo contrario, sin manera
 * read-only de inspeccionar sin abrir SQL directo. Estos endpoints existen
 * para diagnosticar (sin tocar la DB) y para limpiar puntualmente cuando ya
 * sabemos qué pasó.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER, createTestUser } = require('./helpers/setup');

let pool, adminToken, opToken, catId, cliId, cajaUsdId;
const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const a = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = a.body.token;

  // Usuario operador para los tests de 403. SEG-2: createTestUser seedea
  // tenant_users + tenant_user_roles para que el login no rebote NO_TENANT.
  await createTestUser(pool, {
    nombre: 'Op Diag', username: 'opdiag',
    email: 'opdiag@test.local', password: 'op_diag_pass',
    role: 'op',
  });
  const o = await request(app).post('/api/auth/login')
    .send({ username: 'opdiag', password: 'op_diag_pass' });
  opToken = o.body.token;

  // Setup: cliente + categoría + caja USD.
  const cli = await request(app).post('/api/cuentas/clientes').set(auth())
    .send({ nombre: 'Cliente Diag', categoria: 'A+' });
  cliId = cli.body.id;
  const cat = await request(app).post('/api/inventario/categorias').set(auth())
    .send({ nombre: 'Diag Cat' });
  catId = cat.body.id;
  const metRes = await request(app).get('/api/ventas/metodos-pago').set(auth());
  cajaUsdId = (metRes.body || []).find(m => m.moneda === 'USD').id;
});

afterAll(async () => { await teardownTestDb(pool); });

async function crearProducto(imei) {
  const r = await request(app).post('/api/inventario/productos').set(auth())
    .send({
      tipo_carga: 'unitario', clase: 'celular', categoria_id: catId,
      nombre: `Diag ${imei}`, imei,
      costo: 500, costo_moneda: 'USD',
      precio_venta: 1000, precio_moneda: 'USD',
      cantidad: 1,
    });
  return r.body;
}

describe('GET /api/admin/diagnose-producto', () => {
  it('rechaza sin auth → 401', async () => {
    const r = await request(app).get('/api/admin/diagnose-producto?imei=123');
    expect(r.status).toBe(401);
  });

  it('rechaza no-admin → 403', async () => {
    const r = await request(app).get('/api/admin/diagnose-producto?imei=123').set(auth(opToken));
    expect(r.status).toBe(403);
  });

  it('sin imei ni producto_id → 400', async () => {
    const r = await request(app).get('/api/admin/diagnose-producto').set(auth());
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/imei|producto_id/i);
  });

  it('IMEI sin match → devuelve listas vacías', async () => {
    const r = await request(app).get('/api/admin/diagnose-producto?imei=NO_EXISTE_999').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.productos).toEqual([]);
    expect(r.body.movimientos_cc).toEqual([]);
  });

  it('producto vivo + venta B2B + DELETE → trail muestra ambos movs (vivo y borrado)', async () => {
    const prod = await crearProducto('350900000000901');
    // Venta B2B
    const venta = await request(app).post('/api/cuentas/movimientos').set(auth())
      .send({
        cliente_cc_id: cliId, fecha: '2026-06-09', tipo: 'compra',
        monto_total: 1000, caja_id: cajaUsdId,
        items: [{ producto_id: prod.id, cantidad: 1, valor: 1000 }],
      });
    expect(venta.status).toBe(201);
    // Borrar venta
    const del = await request(app).delete(`/api/cuentas/movimientos/${venta.body.id}`).set(auth());
    expect(del.status).toBe(200);

    const r = await request(app).get('/api/admin/diagnose-producto?imei=350900000000901').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.productos).toHaveLength(1);
    expect(r.body.productos[0].id).toBe(prod.id);
    // Tras el DELETE → producto debe haber vuelto a disponible.
    expect(r.body.productos[0].estado).toBe('disponible');
    expect(Number(r.body.productos[0].cantidad)).toBe(1);

    // Trail incluye el movimiento (aunque esté soft-deleted).
    expect(r.body.movimientos_cc.length).toBeGreaterThanOrEqual(1);
    const trail = r.body.movimientos_cc.find(t => t.mov_id === venta.body.id);
    expect(trail).toBeDefined();
    expect(trail.mov_tipo).toBe('compra');
    expect(trail.mov_deleted_at).not.toBeNull();
    expect(trail.cliente_nombre).toBe('Cliente Diag');
  });

  it('busca por producto_id también', async () => {
    const prod = await crearProducto('350900000000902');
    const r = await request(app).get(`/api/admin/diagnose-producto?producto_id=${prod.id}`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.productos[0].id).toBe(prod.id);
  });

  it('producto_id inválido → 400', async () => {
    const r = await request(app).get('/api/admin/diagnose-producto?producto_id=abc').set(auth());
    expect(r.status).toBe(400);
  });
});

describe('POST /api/admin/restore-producto', () => {
  it('rechaza no-admin → 403', async () => {
    const r = await request(app).post('/api/admin/restore-producto').set(auth(opToken))
      .send({ producto_id: 1, reason: 'limpieza testing' });
    expect(r.status).toBe(403);
  });

  it('sin reason → 400', async () => {
    const prod = await crearProducto('350900000000903');
    const r = await request(app).post('/api/admin/restore-producto').set(auth())
      .send({ producto_id: prod.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/reason/i);
  });

  it('reason muy corto → 400', async () => {
    const prod = await crearProducto('350900000000904');
    const r = await request(app).post('/api/admin/restore-producto').set(auth())
      .send({ producto_id: prod.id, reason: 'ok' });
    expect(r.status).toBe(400);
  });

  it('producto inexistente → 404', async () => {
    const r = await request(app).post('/api/admin/restore-producto').set(auth())
      .send({ producto_id: 999999, reason: 'no debería suceder' });
    expect(r.status).toBe(404);
  });

  it('producto soft-deleted → 409 (no restaura "fantasmas")', async () => {
    const prod = await crearProducto('350900000000905');
    await request(app).delete(`/api/inventario/productos/${prod.id}`).set(auth());
    const r = await request(app).post('/api/admin/restore-producto').set(auth())
      .send({ producto_id: prod.id, reason: 'intento sobre borrado' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/soft-deleted/i);
  });

  it('restaura producto vendido a disponible + audit log', async () => {
    const prod = await crearProducto('350900000000906');
    // Vender → vendido / 0
    await request(app).post('/api/cuentas/movimientos').set(auth())
      .send({
        cliente_cc_id: cliId, fecha: '2026-06-09', tipo: 'compra',
        monto_total: 1000,
        items: [{ producto_id: prod.id, cantidad: 1, valor: 1000 }],
      });
    // Sanity: confirmar que quedó vendido.
    const pre = (await pool.query('SELECT estado, cantidad FROM productos WHERE id = $1', [prod.id])).rows[0];
    expect(pre.estado).toBe('vendido');
    expect(Number(pre.cantidad)).toBe(0);

    const r = await request(app).post('/api/admin/restore-producto').set(auth())
      .send({ producto_id: prod.id, cantidad: 1, reason: 'limpieza tras bug de prod 2026-06-09' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.producto.estado).toBe('disponible');
    expect(Number(r.body.producto.cantidad)).toBe(1);

    // Audit log estampado: accion=UPDATE con _origen='admin_restore' en el JSONB.
    const al = await pool.query(
      `SELECT datos_despues FROM audit_logs
        WHERE tabla = 'productos' AND accion = 'UPDATE' AND registro_id = $1
          AND datos_despues->>'_origen' = 'admin_restore'`,
      [prod.id]
    );
    expect(al.rows.length).toBeGreaterThanOrEqual(1);
    expect(al.rows[0].datos_despues._reason).toMatch(/limpieza/);
  });
});

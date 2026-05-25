/**
 * Tests de integración — Financiera (huecos de cobertura)
 *
 * Cubre lo que financiera.test.js no toca: DELETE de pagos y comprobantes,
 * filtros buscar/vendedor, y el endpoint de archivo adjunto.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

/* ═══════════ PAGOS ═══════════ */
describe('Pagos — DELETE y filtros', () => {
  it('borra un pago (soft-delete), y devuelve 404/400 según corresponda', async () => {
    const created = await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-02-01', monto: 1000, referencia: 'REF-DELETE' });
    expect(created.status).toBe(201);

    const del = await request(app).delete(`/api/pagos/${created.body.id}`).set(auth());
    expect(del.status).toBe(200);

    const del2 = await request(app).delete(`/api/pagos/${created.body.id}`).set(auth());
    expect(del2.status).toBe(404);

    const badId = await request(app).delete('/api/pagos/abc').set(auth());
    expect(badId.status).toBe(400);
  });

  it('filtra pagos por referencia (buscar)', async () => {
    await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-02-02', monto: 500, referencia: 'TransferenciaXYZ' });
    const res = await request(app).get('/api/pagos?buscar=TransferenciaXYZ').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every(p => /TransferenciaXYZ/i.test(p.referencia))).toBe(true);
  });
});

/* ═══════════ COMPROBANTES ═══════════ */
describe('Comprobantes — DELETE, filtros y archivo', () => {
  let vendedorId;

  beforeAll(async () => {
    const v = await request(app).post('/api/vendedores').set(auth()).send({ nombre: 'Vendedor Test' });
    vendedorId = v.body.id;
  });

  it('borra un comprobante (soft-delete), y devuelve 404/400 según corresponda', async () => {
    const created = await request(app).post('/api/comprobantes').set(auth())
      .send({ fecha: '2026-02-01', cliente: 'Cliente Del', monto: 1000, monto_financiera: 30, monto_neto: 970 });
    const del = await request(app).delete(`/api/comprobantes/${created.body.id}`).set(auth());
    expect(del.status).toBe(200);
    const del2 = await request(app).delete(`/api/comprobantes/${created.body.id}`).set(auth());
    expect(del2.status).toBe(404);
    const badId = await request(app).delete('/api/comprobantes/abc').set(auth());
    expect(badId.status).toBe(400);
  });

  it('filtra por vendedor y por buscar (cliente/referencia)', async () => {
    await request(app).post('/api/comprobantes').set(auth())
      .send({ fecha: '2026-02-03', cliente: 'ClienteVend', vendedor_id: vendedorId, monto: 5000, monto_financiera: 150, monto_neto: 4850, referencia: 'FACT-001' });

    const porVendedor = await request(app).get('/api/comprobantes?vendedor=Vendedor Test').set(auth());
    expect(porVendedor.status).toBe(200);
    expect(porVendedor.body.data.length).toBeGreaterThan(0);

    const porBuscar = await request(app).get('/api/comprobantes?buscar=FACT-001').set(auth());
    expect(porBuscar.status).toBe(200);
    expect(porBuscar.body.data.length).toBeGreaterThan(0);

    // totales con buscar también ejercita esa rama
    const totales = await request(app).get('/api/comprobantes/totales?buscar=FACT-001').set(auth());
    expect(totales.status).toBe(200);
    expect(totales.body.count).toBeGreaterThan(0);
  });

  it('sirve el archivo adjunto (200) y devuelve 404 si no tiene', async () => {
    const conArchivo = await request(app).post('/api/comprobantes').set(auth())
      .send({ fecha: '2026-02-04', cliente: 'Con Archivo', monto: 1000, monto_financiera: 30, monto_neto: 970, archivo_data: 'iVBORw0KGgo=', archivo_nombre: 'c.png', archivo_tipo: 'image/png' });
    const ok = await request(app).get(`/api/comprobantes/${conArchivo.body.id}/archivo`).set(auth());
    expect(ok.status).toBe(200);
    expect(ok.body.data).toBe('iVBORw0KGgo=');

    const sinArchivo = await request(app).post('/api/comprobantes').set(auth())
      .send({ fecha: '2026-02-05', cliente: 'Sin Archivo', monto: 1000, monto_financiera: 30, monto_neto: 970 });
    const notFound = await request(app).get(`/api/comprobantes/${sinArchivo.body.id}/archivo`).set(auth());
    expect(notFound.status).toBe(404);

    const badId = await request(app).get('/api/comprobantes/abc/archivo').set(auth());
    expect(badId.status).toBe(400);
  });
});

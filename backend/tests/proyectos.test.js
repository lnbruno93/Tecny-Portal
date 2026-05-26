/**
 * Tests de integración — módulo Proyectos.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, contactoId;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const c = await request(app).post('/api/contactos').set(auth()).send({ nombre: 'Inversor', apellido: 'Uno', tipo: 'inversor' });
  contactoId = c.body.id;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Proyectos', () => {
  let proyectoId;

  it('crea un proyecto con participantes (desde contactos)', async () => {
    const res = await request(app).post('/api/proyectos').set(auth())
      .send({ nombre: 'App iPro', objetivo: 'Lanzar v2', fecha_creacion: '2026-01-15', participantes: [contactoId] });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('App iPro');
    proyectoId = res.body.id;

    const det = await request(app).get(`/api/proyectos/${proyectoId}`).set(auth());
    expect(det.status).toBe(200);
    expect(det.body.participantes).toHaveLength(1);
    expect(det.body.participantes[0].id).toBe(contactoId);
  });

  it('rechaza proyecto sin nombre → 400', async () => {
    const res = await request(app).post('/api/proyectos').set(auth()).send({ objetivo: 'x' });
    expect(res.status).toBe(400);
  });

  it('carga un movimiento: $ + TC → USD calculado', async () => {
    const res = await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({ proyecto_id: proyectoId, fecha: '2026-02-01', detalle: 'Servidor', categoria: 'Infra', monto: 142500, tc: 1425, inversor_contacto_id: contactoId, comentarios: 'mensual' });
    expect(res.status).toBe(201);
    expect(Number(res.body.monto)).toBe(142500);
    expect(Number(res.body.monto_usd)).toBe(100); // 142500 / 1425

    // un segundo movimiento solo en USD directo
    await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({ proyecto_id: proyectoId, fecha: '2026-03-01', detalle: 'Dominio', monto_usd: 50 });

    // movimientos paginados
    const movs = await request(app).get(`/api/proyectos/${proyectoId}/movimientos`).set(auth());
    expect(Array.isArray(movs.body.data)).toBe(true);
    expect(movs.body.data).toHaveLength(2);
    expect(movs.body.pagination).toHaveProperty('total');
    expect(movs.body.data.some(m => m.inversor_nombre === 'Inversor Uno')).toBe(true);
  });

  it('el resumen del proyecto totaliza $ y USD + rango de fechas', async () => {
    const det = await request(app).get(`/api/proyectos/${proyectoId}`).set(auth());
    expect(Number(det.body.resumen.total_ars)).toBe(142500);
    expect(Number(det.body.resumen.total_usd)).toBe(150); // 100 + 50
    expect(Number(det.body.resumen.cant_movimientos)).toBe(2);
    expect(det.body.resumen.desde).toBeTruthy();
    expect(det.body.resumen.hasta).toBeTruthy();
  });

  it('la lista muestra el proyecto con totales', async () => {
    const res = await request(app).get('/api/proyectos').set(auth());
    expect(res.status).toBe(200);
    const p = res.body.find(x => x.id === proyectoId);
    expect(p).toBeTruthy();
    expect(Number(p.total_usd)).toBe(150);
    expect(Number(p.cant_movimientos)).toBe(2);
  });

  it('borra un movimiento y el total baja', async () => {
    const movs = await request(app).get(`/api/proyectos/${proyectoId}/movimientos`).set(auth());
    const usdMov = movs.body.data.find(m => Number(m.monto_usd) === 50);
    await request(app).delete(`/api/proyectos/movimientos/${usdMov.id}`).set(auth());
    const det = await request(app).get(`/api/proyectos/${proyectoId}`).set(auth());
    expect(Number(det.body.resumen.total_usd)).toBe(100);
  });
});

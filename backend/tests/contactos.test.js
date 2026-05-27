/**
 * Tests de integración — agenda de Contactos.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Contactos — agenda', () => {
  let id;

  it('crea un contacto con ficha completa (default origen manual)', async () => {
    const res = await request(app).post('/api/contactos').set(auth())
      .send({ nombre: 'Ana', apellido: 'García', telefono: '11-5555', dni: '30111222', email: 'ana@mail.com' });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Ana');
    expect(res.body.telefono).toBe('11-5555');
    expect(res.body.dni).toBe('30111222');
    expect(res.body.email).toBe('ana@mail.com');
    expect(res.body.origen).toBe('manual');   // default
    expect(res.body.tipo).toBe('cliente');     // default
    id = res.body.id;
  });

  it('rechaza email inválido → 400', async () => {
    const res = await request(app).post('/api/contactos').set(auth())
      .send({ nombre: 'Mal', email: 'no-es-mail' });
    expect(res.status).toBe(400);
  });

  it('guarda el origen elegido', async () => {
    const res = await request(app).post('/api/contactos').set(auth())
      .send({ nombre: 'Prov', origen: 'proveedores' });
    expect(res.status).toBe(201);
    expect(res.body.origen).toBe('proveedores');
  });

  it('rechaza origen inválido → 400', async () => {
    const res = await request(app).post('/api/contactos').set(auth())
      .send({ nombre: 'X', origen: 'marciano' });
    expect(res.status).toBe(400);
  });

  it('busca por email/teléfono/dni', async () => {
    const byMail = await request(app).get('/api/contactos?buscar=ana@mail').set(auth());
    expect(byMail.body.some(c => c.id === id)).toBe(true);
    const byDni = await request(app).get('/api/contactos?buscar=30111').set(auth());
    expect(byDni.body.some(c => c.id === id)).toBe(true);
  });

  it('filtra por origen', async () => {
    const res = await request(app).get('/api/contactos?origen=proveedores').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.every(c => c.origen === 'proveedores')).toBe(true);
  });

  it('edita la ficha del contacto', async () => {
    const res = await request(app).put(`/api/contactos/${id}`).set(auth())
      .send({ telefono: '11-9999', dni: '40999888' });
    expect(res.status).toBe(200);
    expect(res.body.telefono).toBe('11-9999');
    expect(res.body.dni).toBe('40999888');
    expect(res.body.nombre).toBe('Ana'); // sin tocar
  });

  it('elimina (soft) el contacto', async () => {
    const del = await request(app).delete(`/api/contactos/${id}`).set(auth());
    expect(del.status).toBe(200);
    const list = await request(app).get('/api/contactos?buscar=ana@mail').set(auth());
    expect(list.body.some(c => c.id === id)).toBe(false);
  });
});

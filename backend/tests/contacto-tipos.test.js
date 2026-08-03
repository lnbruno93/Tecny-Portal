/**
 * Tests de integración — CRUD contacto_tipos + validación en /api/contactos
 * (task #290).
 *
 * Coverage:
 *   1. GET /api/contacto-tipos devuelve los 5 defaults seedeados
 *   2. POST crea nuevo con slug auto-generado
 *   3. POST rechaza duplicado (409)
 *   4. PATCH edita nombre + orden + activo
 *   5. DELETE soft-deletea si no está en uso
 *   6. DELETE rechaza is_system=true (403)
 *   7. DELETE rechaza si hay contactos usándolo (409 con count)
 *   8. Validación en POST /api/contactos: rechaza tipo inválido (400)
 *   9. Validación en POST /api/contactos: rechaza tipo desactivado (400)
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });
// Sufijo único por test-run para evitar colisiones de nombre entre re-runs
// (los tests corren en shared DB local; sin cleanup after each test, un run
// previo puede haber creado 'Distribuidor Mayorista' y el POST daría 409).
const uniq = (base) => `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('CRUD /api/contacto-tipos', () => {
  it('GET / lista los 4 tipos universales seedeados por la migration', async () => {
    const res = await request(app).get('/api/contacto-tipos').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Los 4 tipos universales para todos los tenants (post fix 2026-08-03:
    // 'ipro team' NO se seedea por default; solo se agrega a tenants con
    // contactos históricos usando ese slug — ver migration).
    const slugs = res.body.map(t => t.slug);
    expect(slugs).toEqual(expect.arrayContaining(['cliente', 'amigo', 'familiar', 'inversor']));
    const cliente = res.body.find(t => t.slug === 'cliente');
    expect(cliente.nombre).toBe('Cliente');
    expect(cliente.is_system).toBe(true);
  });

  it('POST / crea un tipo nuevo con slug auto-generado (lowercase)', async () => {
    const nombre = uniq('Distribuidor Mayorista');
    const res = await request(app).post('/api/contacto-tipos').set(auth())
      .send({ nombre });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe(nombre.toLowerCase());
    expect(res.body.nombre).toBe(nombre);
    expect(res.body.is_system).toBe(false);
    expect(res.body.activo).toBe(true);
  });

  it('POST / rechaza duplicado (409) — mismo nombre normalized', async () => {
    // Ya existe 'cliente' del seed.
    const res = await request(app).post('/api/contacto-tipos').set(auth())
      .send({ nombre: 'Cliente' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ya existe/i);
  });

  it('POST / rechaza nombre vacío (400 via Zod)', async () => {
    const res = await request(app).post('/api/contacto-tipos').set(auth())
      .send({ nombre: '   ' });
    expect(res.status).toBe(400);
  });

  it('PATCH /:id edita nombre + orden + activo', async () => {
    const nombreOrig = uniq('Test Patch Tipo');
    const created = await request(app).post('/api/contacto-tipos').set(auth())
      .send({ nombre: nombreOrig });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const slugOrig = created.body.slug;

    const nombreNuevo = uniq('Test Patch Editado');
    const res = await request(app).patch(`/api/contacto-tipos/${id}`).set(auth())
      .send({ nombre: nombreNuevo, orden: 99, activo: false });
    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe(nombreNuevo);
    expect(res.body.orden).toBe(99);
    expect(res.body.activo).toBe(false);
    // Slug NO cambia (safety para no romper contactos existentes).
    expect(res.body.slug).toBe(slugOrig);
  });

  it('PATCH /:id rechaza UUID inválido (400)', async () => {
    const res = await request(app).patch('/api/contacto-tipos/not-a-uuid').set(auth())
      .send({ nombre: 'X' });
    expect(res.status).toBe(400);
  });

  it('DELETE /:id soft-deletea un tipo no-system y sin contactos', async () => {
    const created = await request(app).post('/api/contacto-tipos').set(auth())
      .send({ nombre: uniq('Tipo Efímero') });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const res = await request(app).delete(`/api/contacto-tipos/${id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Ya no aparece en el listado.
    const list = await request(app).get('/api/contacto-tipos').set(auth());
    expect(list.body.find(t => t.id === id)).toBeUndefined();
  });

  it('DELETE /:id rechaza is_system=true (403)', async () => {
    const list = await request(app).get('/api/contacto-tipos').set(auth());
    const cliente = list.body.find(t => t.slug === 'cliente');
    expect(cliente.is_system).toBe(true);

    const res = await request(app).delete(`/api/contacto-tipos/${cliente.id}`).set(auth());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/sistema/i);
  });

  it('DELETE /:id rechaza si hay contactos usándolo (409 con count)', async () => {
    // Crear un tipo custom + un contacto usándolo.
    const tipoRes = await request(app).post('/api/contacto-tipos').set(auth())
      .send({ nombre: uniq('Tipo En Uso') });
    expect(tipoRes.status).toBe(201);
    const tipoId = tipoRes.body.id;
    const slug = tipoRes.body.slug;

    const contactoRes = await request(app).post('/api/contactos').set(auth())
      .send({ nombre: 'Test Contacto Con Tipo Custom', tipo: slug });
    expect(contactoRes.status).toBe(201);

    const res = await request(app).delete(`/api/contacto-tipos/${tipoId}`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.contactos_en_uso).toBeGreaterThan(0);
  });
});

describe('Validación tipo en /api/contactos', () => {
  it('POST /api/contactos rechaza tipo inválido (no existe en contacto_tipos)', async () => {
    const res = await request(app).post('/api/contactos').set(auth())
      .send({ nombre: 'Fake Tipo Contacto', tipo: 'no-existe-como-slug' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tipo.*inválido|desactivado/i);
  });

  it('POST /api/contactos acepta tipo activo (cliente default)', async () => {
    const res = await request(app).post('/api/contactos').set(auth())
      .send({ nombre: 'Contacto Cliente OK', tipo: 'cliente' });
    expect(res.status).toBe(201);
    expect(res.body.tipo).toBe('cliente');
  });

  it('POST /api/contactos rechaza tipo desactivado (activo=false)', async () => {
    // Crear tipo custom + desactivarlo.
    const created = await request(app).post('/api/contacto-tipos').set(auth())
      .send({ nombre: uniq('Tipo Para Desactivar') });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const slug = created.body.slug;
    const patched = await request(app).patch(`/api/contacto-tipos/${id}`).set(auth())
      .send({ activo: false });
    expect(patched.status).toBe(200);
    expect(patched.body.activo).toBe(false);

    // Ahora intentar crear un contacto con ese tipo desactivado.
    const res = await request(app).post('/api/contactos').set(auth())
      .send({ nombre: 'Contacto Con Tipo Desactivado', tipo: slug });
    expect(res.status).toBe(400);
  });
});

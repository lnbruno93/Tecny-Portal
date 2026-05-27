/**
 * Tests de integración — recolección automática de contactos (Fase 2).
 * Al crear/editar un proveedor o un cliente B2B, el contacto debe aparecer
 * (y mantenerse sincronizado, sin duplicar) en la agenda central.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });
const buscar = (q) => request(app).get(`/api/contactos?buscar=${encodeURIComponent(q)}`).set(auth());

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Recolección automática en la agenda', () => {
  it('crear un proveedor lo registra en contactos (origen proveedores)', async () => {
    const prov = await request(app).post('/api/proveedores').set(auth())
      .send({ nombre: 'Importadora Sur', contacto_nombre: 'Carlos', contacto_apellido: 'Méndez', whatsapp: '11-7777' });
    expect(prov.status).toBe(201);

    const list = (await buscar('Carlos')).body;
    const c = list.find(x => x.origen === 'proveedores' && x.origen_ref_id === prov.body.id);
    expect(c).toBeTruthy();
    expect(c.nombre).toBe('Carlos');
    expect(c.apellido).toBe('Méndez');
    expect(c.telefono).toBe('11-7777');
  });

  it('crear un cliente B2B lo registra en contactos (origen b2b)', async () => {
    const cli = await request(app).post('/api/cuentas/clientes').set(auth())
      .send({ nombre: 'Mayorista', apellido: 'Norte', contacto: '11-8888', categoria: 'A+' });
    expect(cli.status).toBe(201);

    const c = (await buscar('Mayorista')).body.find(x => x.origen === 'b2b' && x.origen_ref_id === cli.body.id);
    expect(c).toBeTruthy();
    expect(c.telefono).toBe('11-8888');
  });

  it('editar el proveedor sincroniza la ficha sin duplicar', async () => {
    const prov = await request(app).post('/api/proveedores').set(auth())
      .send({ nombre: 'Distribuidora X', contacto_nombre: 'Lucía', whatsapp: '11-1000' });
    await request(app).put(`/api/proveedores/${prov.body.id}`).set(auth())
      .send({ contacto_nombre: 'Lucía', whatsapp: '11-2000' });

    const matches = (await buscar('Lucía')).body.filter(x => x.origen_ref_tabla === 'proveedores' && x.origen_ref_id === prov.body.id);
    expect(matches).toHaveLength(1);              // no se duplicó
    expect(matches[0].telefono).toBe('11-2000');  // se actualizó
  });

  it('no rompe el alta si el contacto de origen no tiene nombre', async () => {
    // proveedor sin contacto_nombre → usa el nombre del proveedor como contacto
    const prov = await request(app).post('/api/proveedores').set(auth())
      .send({ nombre: 'Proveedor Sin Persona' });
    expect(prov.status).toBe(201);
    const c = (await buscar('Proveedor Sin Persona')).body.find(x => x.origen_ref_id === prov.body.id);
    expect(c).toBeTruthy();
    expect(c.nombre).toBe('Proveedor Sin Persona');
  });
});

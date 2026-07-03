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
    expect(byMail.body.data.some(c => c.id === id)).toBe(true);
    const byDni = await request(app).get('/api/contactos?buscar=30111').set(auth());
    expect(byDni.body.data.some(c => c.id === id)).toBe(true);
  });

  it('filtra por origen', async () => {
    const res = await request(app).get('/api/contactos?origen=proveedores').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.every(c => c.origen === 'proveedores')).toBe(true);
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
    expect(list.body.data.some(c => c.id === id)).toBe(false);
  });

  // fecha_nacimiento: agregada para alimentar Data Science (cumpleaños, perfilado).
  it('acepta fecha_nacimiento al crear y al actualizar', async () => {
    const res = await request(app).post('/api/contactos').set(auth())
      .send({ nombre: 'Beto', fecha_nacimiento: '1993-08-04' });
    expect(res.status).toBe(201);
    expect(String(res.body.fecha_nacimiento)).toMatch(/1993-08-04/);
    const upd = await request(app).put(`/api/contactos/${res.body.id}`).set(auth())
      .send({ fecha_nacimiento: '1995-12-20' });
    expect(upd.status).toBe(200);
    expect(String(upd.body.fecha_nacimiento)).toMatch(/1995-12-20/);
  });

  it('rechaza fecha_nacimiento con formato inválido → 400', async () => {
    const res = await request(app).post('/api/contactos').set(auth())
      .send({ nombre: 'Mal Fecha', fecha_nacimiento: '04-08-1993' });
    expect(res.status).toBe(400);
  });

  // 2026-07-04 (#508): endpoint /emails para copiar la lista al portapapeles
  // desde el frontend y hacer mailing masivo. Sin paginación (dedup + orden).
  describe('GET /api/contactos/emails — lista para mailing masivo', () => {
    it('devuelve solo emails no-null, dedup case-insensitive y ordenados', async () => {
      // Creamos contactos con: email, sin email, email duplicado en mayúsculas,
      // email con espacios. El endpoint debe devolver 1 solo por variante.
      await request(app).post('/api/contactos').set(auth()).send({ nombre: 'Con Mail', email: 'juan@mail.com' });
      await request(app).post('/api/contactos').set(auth()).send({ nombre: 'Sin Mail' /* no email */ });
      await request(app).post('/api/contactos').set(auth()).send({ nombre: 'Dup Mayus', email: 'JUAN@MAIL.COM' });
      await request(app).post('/api/contactos').set(auth()).send({ nombre: 'Con Espacios', email: '  otro@mail.com  ' });

      const res = await request(app).get('/api/contactos/emails').set(auth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.emails)).toBe(true);
      expect(typeof res.body.count).toBe('number');
      // 'juan@mail.com' debería aparecer 1 sola vez (case-insensitive dedup).
      const juanCount = res.body.emails.filter(e => e === 'juan@mail.com').length;
      expect(juanCount).toBe(1);
      // 'otro@mail.com' con TRIM aplicado.
      expect(res.body.emails).toContain('otro@mail.com');
      // No debería aparecer 'Sin Mail' (email null).
      expect(res.body.emails).not.toContain(null);
      expect(res.body.emails).not.toContain('');
      // count debe coincidir con emails.length.
      expect(res.body.count).toBe(res.body.emails.length);
      // Orden alfabético.
      const sorted = [...res.body.emails].sort();
      expect(res.body.emails).toEqual(sorted);
    });

    it('exige auth → 401 sin token', async () => {
      const res = await request(app).get('/api/contactos/emails');
      expect(res.status).toBe(401);
    });
  });
});

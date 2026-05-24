/**
 * Tests de integración — Cajas (deudas, inversiones, resumen)
 *
 * Cubre:
 *   POST /api/contactos              — crear contacto
 *   GET  /api/cajas/resumen          — estructura y datos correctos
 *   POST /api/cajas/deudas           — crear movimiento de deuda
 *   GET  /api/cajas/deudas           — filtro por contacto_id
 *   POST /api/cajas/inversiones      — crear inversión
 *   DELETE /api/cajas/deudas/:id     — eliminar movimiento
 *   Resumen refleja los datos reales
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;
let contactoId;
let deudaId;
let inversionId;

beforeAll(async () => {
  pool = await setupTestDb();

  // Autenticar
  const authRes = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = authRes.body.token;

  // Crear contacto de prueba vía API
  const cRes = await request(app)
    .post('/api/contactos')
    .set('Authorization', `Bearer ${token}`)
    .send({ nombre: 'Ana', apellido: 'García', tipo: 'inversor' });
  contactoId = cRes.body.id;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── Resumen inicial (vacío) ──────────────────────────────────
describe('GET /api/cajas/resumen — estado inicial', () => {
  it('devuelve estructura correcta con arrays vacíos', async () => {
    const res = await request(app)
      .get('/api/cajas/resumen')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('deudas');
    expect(res.body).toHaveProperty('inversiones');
    expect(Array.isArray(res.body.deudas)).toBe(true);
    expect(Array.isArray(res.body.inversiones)).toBe(true);
  });
});

// ─── Deudas ───────────────────────────────────────────────────
describe('POST /api/cajas/deudas', () => {
  it('crea un movimiento tipo "debe"', async () => {
    const res = await request(app)
      .post('/api/cajas/deudas')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-01-15',
        contacto_id: contactoId,
        tipo:        'debe',
        monto_ars:   50000,
        monto_usd:   0,
        concepto:    'Préstamo enero',
      });

    expect(res.status).toBe(201);
    expect(res.body.contacto_id).toBe(contactoId);
    expect(parseFloat(res.body.monto_ars)).toBe(50000);
    deudaId = res.body.id;
  });

  it('crea un movimiento tipo "pago"', async () => {
    const res = await request(app)
      .post('/api/cajas/deudas')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-02-01',
        contacto_id: contactoId,
        tipo:        'pago',
        monto_ars:   10000,
        monto_usd:   0,
      });

    expect(res.status).toBe(201);
    expect(res.body.tipo).toBe('pago');
  });

  it('rechaza tipo inválido → 400', async () => {
    const res = await request(app)
      .post('/api/cajas/deudas')
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: '2026-01-15', contacto_id: contactoId, tipo: 'credito', monto_ars: 100 });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/cajas/deudas', () => {
  it('devuelve solo los movimientos del contacto filtrado', async () => {
    const res = await request(app)
      .get(`/api/cajas/deudas?contacto_id=${contactoId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(2); // debe + pago
    res.body.data.forEach(m => expect(m.contacto_id).toBe(contactoId));
  });

  it('devuelve todos los movimientos sin filtro (paginado)', async () => {
    const res = await request(app)
      .get('/api/cajas/deudas')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.pagination).toBeDefined();
  });
});

// ─── Inversiones ──────────────────────────────────────────────
describe('POST /api/cajas/inversiones', () => {
  it('crea una inversión con tasa', async () => {
    const res = await request(app)
      .post('/api/cajas/inversiones')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-01-10',
        contacto_id: contactoId,
        monto:       2000,
        tasa:        '3% mensual',
      });

    expect(res.status).toBe(201);
    expect(parseFloat(res.body.monto)).toBe(2000);
    expect(res.body.tasa).toBe('3% mensual');
    inversionId = res.body.id;
  });

  it('crea una inversión sin tasa', async () => {
    const res = await request(app)
      .post('/api/cajas/inversiones')
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: '2026-02-10', contacto_id: contactoId, monto: 500 });

    expect(res.status).toBe(201);
    expect(res.body.tasa).toBeNull();
  });
});

// ─── Resumen refleja los datos ─────────────────────────────────
describe('GET /api/cajas/resumen — con datos', () => {
  it('incluye al contacto en deudas con saldo correcto (50000 - 10000 = 40000 ARS)', async () => {
    const res = await request(app)
      .get('/api/cajas/resumen')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const d = res.body.deudas.find(r => r.contacto_id === contactoId);
    expect(d).toBeDefined();
    expect(parseFloat(d.saldo_ars)).toBe(40000);
    expect(parseInt(d.movimientos)).toBe(2);
  });

  it('incluye al contacto en inversiones con total y última tasa', async () => {
    const res = await request(app)
      .get('/api/cajas/resumen')
      .set('Authorization', `Bearer ${token}`);

    const inv = res.body.inversiones.find(r => r.contacto_id === contactoId);
    expect(inv).toBeDefined();
    expect(parseFloat(inv.total_invertido)).toBe(2500); // 2000 + 500
    // ultima_tasa: la más reciente con tasa no nula (fecha 2026-01-10 con "3% mensual")
    expect(inv.ultima_tasa).toBe('3% mensual');
  });
});

// ─── DELETE deuda ─────────────────────────────────────────────
describe('DELETE /api/cajas/deudas/:id', () => {
  it('elimina el movimiento de deuda', async () => {
    const res = await request(app)
      .delete(`/api/cajas/deudas/${deudaId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('el movimiento eliminado ya no aparece en GET', async () => {
    const res = await request(app)
      .get(`/api/cajas/deudas?contacto_id=${contactoId}`)
      .set('Authorization', `Bearer ${token}`);

    const ids = res.body.data.map(m => m.id);
    expect(ids).not.toContain(deudaId);
  });

  it('el resumen actualiza el saldo tras eliminar la deuda', async () => {
    const res = await request(app)
      .get('/api/cajas/resumen')
      .set('Authorization', `Bearer ${token}`);

    const d = res.body.deudas.find(r => r.contacto_id === contactoId);
    // Queda solo el pago de 10000 → saldo -10000 (solo hay el pago)
    expect(parseFloat(d.saldo_ars)).toBe(-10000);
  });
});

// ─── GET inversiones ──────────────────────────────────────────
describe('GET /api/cajas/inversiones', () => {
  it('devuelve lista paginada de inversiones', async () => {
    const res = await request(app)
      .get('/api/cajas/inversiones')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.pagination).toBeDefined();
  });

  it('filtra por contacto_id', async () => {
    const res = await request(app)
      .get(`/api/cajas/inversiones?contacto_id=${contactoId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    res.body.data.forEach(inv => expect(inv.contacto_id).toBe(contactoId));
  });
});

// ─── DELETE inversión ─────────────────────────────────────────
describe('DELETE /api/cajas/inversiones/:id', () => {
  it('elimina la inversión → 200', async () => {
    const res = await request(app)
      .delete(`/api/cajas/inversiones/${inversionId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('la inversión eliminada ya no aparece en GET', async () => {
    const res = await request(app)
      .get(`/api/cajas/inversiones?contacto_id=${contactoId}`)
      .set('Authorization', `Bearer ${token}`);

    const ids = res.body.data.map(m => m.id);
    expect(ids).not.toContain(inversionId);
  });

  it('eliminar de nuevo → 404', async () => {
    const res = await request(app)
      .delete(`/api/cajas/inversiones/${inversionId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

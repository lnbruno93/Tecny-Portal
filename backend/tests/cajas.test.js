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

  // Regresión: el frontend Cajas.jsx pide ?limit=500 para traer el ledger completo
  // y agruparlo en memoria. Antes el schema tenía max(200) → 400 "Datos inválidos"
  // y la pantalla "Deudas a cobrar" mostraba todo en 0 sin mensaje claro al user.
  it('acepta limit=500 (el frontend lo usa para traer todo el ledger)', async () => {
    const res = await request(app)
      .get('/api/cajas/deudas?limit=500')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('rechaza limit > 500 → 400 (techo para evitar payloads enormes)', async () => {
    const res = await request(app)
      .get('/api/cajas/deudas?limit=501')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
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

// Mega-form transaccional (post-auditoría TANDA 0): POST /deudas y /inversiones
// aceptan `contacto_nuevo` en lugar de `contacto_id`. El backend crea contacto +
// movimiento en una sola tx — antes el frontend hacía 2 requests separados y
// un fallo en el 2do dejaba contactos huérfanos.
describe('Cajas — mega-form transaccional (contacto_nuevo)', () => {
  it('POST /deudas con contacto_nuevo crea contacto Y movimiento atómicamente', async () => {
    const res = await request(app)
      .post('/api/cajas/deudas')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha: '2026-06-03',
        contacto_nuevo: { nombre: 'Juan', apellido: 'MegaForm', tipo: 'amigo' },
        tipo: 'debe',
        monto_ars: 50000,
        concepto: 'Test mega-form',
      });
    expect(res.status).toBe(201);
    expect(Number(res.body.monto_ars)).toBe(50000);
    expect(res.body.contacto_id).toBeGreaterThan(0);
    // El contacto debe existir como entity propia.
    const c = await request(app)
      .get(`/api/contactos?buscar=MegaForm`)
      .set('Authorization', `Bearer ${token}`);
    const creado = c.body.data.find(x => x.nombre === 'Juan' && x.apellido === 'MegaForm');
    expect(creado).toBeTruthy();
    expect(creado.id).toBe(res.body.contacto_id);
    expect(creado.origen).toBe('manual');
  });

  it('POST /inversiones con contacto_nuevo también es atómico', async () => {
    const res = await request(app)
      .post('/api/cajas/inversiones')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha: '2026-06-03',
        contacto_nuevo: { nombre: 'Carla', tipo: 'inversor' },
        monto: 5000,
      });
    expect(res.status).toBe(201);
    expect(Number(res.body.monto)).toBe(5000);
    expect(res.body.contacto_id).toBeGreaterThan(0);
  });

  it('rechaza si manda contacto_id Y contacto_nuevo (xor)', async () => {
    const res = await request(app)
      .post('/api/cajas/deudas')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha: '2026-06-03',
        contacto_id: contactoId,
        contacto_nuevo: { nombre: 'No debería' },
        tipo: 'debe',
        monto_ars: 100,
      });
    expect(res.status).toBe(400);
  });

  it('rechaza si no manda ni contacto_id ni contacto_nuevo', async () => {
    const res = await request(app)
      .post('/api/cajas/deudas')
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: '2026-06-03', tipo: 'debe', monto_ars: 100 });
    expect(res.status).toBe(400);
  });

  it('si falla el movimiento (validación), el contacto NO queda creado (rollback)', async () => {
    // Forzar fallo en la 2da query: monto_ars=0 + monto_usd=0 → refine
    // rechaza ANTES de empezar la tx (validate middleware). Pero para probar
    // rollback real, generamos un caso donde el schema pase y el INSERT falle.
    // Caso: tipo='inválido' es rechazado por z.enum en el schema → 400 sin tx.
    //
    // Caso útil: contacto_nuevo con nombre demasiado largo (>100 chars) →
    // 400 por validación, no llega al INSERT del movimiento. El contacto
    // tampoco se crea (porque la validación es ANTES de la tx).
    //
    // Para validar rollback real necesitaríamos un fallo durante la tx, lo
    // que requeriría inyectar un error post-validación — fuera del alcance
    // de un test e2e normal. Pero confirmamos el invariante visible:
    // un request con monto inválido NO deja contacto huérfano.
    const antes = await request(app).get('/api/contactos?buscar=NoCreado').set('Authorization', `Bearer ${token}`);
    const idsAntes = antes.body.data.map(c => c.id);

    const res = await request(app)
      .post('/api/cajas/deudas')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha: '2026-06-03',
        contacto_nuevo: { nombre: 'NoCreado', tipo: 'amigo' },
        tipo: 'debe',
        monto_ars: 0, monto_usd: 0, // refine rechaza
      });
    expect(res.status).toBe(400);

    const despues = await request(app).get('/api/contactos?buscar=NoCreado').set('Authorization', `Bearer ${token}`);
    expect(despues.body.data.map(c => c.id)).toEqual(idsAntes); // nadie nuevo
  });
});

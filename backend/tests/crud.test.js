/**
 * Tests de integración — CRUD: Usuarios, Config, Contactos, Vendedores
 *
 * Cubre:
 *   Usuarios   POST / GET / PUT / DELETE  (admin only)
 *   Config     GET / PUT                  (GET: cualquier financiera; PUT: admin)
 *   Contactos  POST / GET / PUT / DELETE  (requiere 'cajas')
 *   Vendedores POST / GET / DELETE        (requiere 'financiera')
 *   Permisos   403 cuando falta permiso
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const bcrypt  = require('bcrypt');

let pool;
let adminToken;
let opToken;    // usuario sin permisos
let opId;

let contactoId;
let vendedorId;
let nuevoUserId;

beforeAll(async () => {
  pool = await setupTestDb();

  // Autenticar como admin
  const r1 = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = r1.body.token;

  // Crear usuario 'op' sin permisos para testear 403
  const hash = await bcrypt.hash('op_pass_123', 10);
  const { rows } = await pool.query(
    'INSERT INTO users (nombre, username, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
    ['Op User', 'opuser', hash, 'op']
  );
  opId = rows[0].id;
  // Sin filas en user_permissions → cualquier permiso dará 403

  const r2 = await request(app)
    .post('/api/auth/login')
    .send({ username: 'opuser', password: 'op_pass_123' });
  opToken = r2.body.token;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ═══════════════════════════════════════════════════════════════
// USUARIOS — admin only
// ═══════════════════════════════════════════════════════════════
describe('GET /api/usuarios', () => {
  it('admin puede listar usuarios', async () => {
    const res = await request(app)
      .get('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('sin token → 401', async () => {
    const res = await request(app).get('/api/usuarios');
    expect(res.status).toBe(401);
  });

  it('usuario op → 403', async () => {
    const res = await request(app)
      .get('/api/usuarios')
      .set('Authorization', `Bearer ${opToken}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/usuarios', () => {
  it('admin crea usuario con permisos → 201', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        nombre:   'Nuevo Vendedor',
        username: 'vendedor01',
        password: 'pass12345',
        role:     'op',
        perms:    { cotizador: false, financiera: true, cajas: false, envios: false, usuarios: false },
      });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('vendedor01');
    nuevoUserId = res.body.id;
  });

  it('rechaza username duplicado → 409', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        nombre: 'Otro', username: 'vendedor01', password: 'pass12345', role: 'op',
        perms: { cotizador: false, financiera: false, cajas: false, envios: false, usuarios: false },
      });
    expect(res.status).toBe(409);
  });

  it('rechaza nombre vacío → 400', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: '', username: 'x_user', password: 'pass12345', role: 'op', perms: {} });
    expect(res.status).toBe(400);
  });

  it('rechaza password corto → 400', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Alguien', username: 'a_user', password: '123', role: 'op', perms: {} });
    expect(res.status).toBe(400);
  });

  it('rechaza username con mayúsculas → 400', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Alguien', username: 'UserBad', password: 'pass12345', role: 'op', perms: {} });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/usuarios/:id', () => {
  it('admin actualiza nombre del usuario', async () => {
    const res = await request(app)
      .put(`/api/usuarios/${nuevoUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Vendedor Actualizado' });
    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe('Vendedor Actualizado');
  });

  it('admin puede actualizar permisos', async () => {
    const res = await request(app)
      .put(`/api/usuarios/${nuevoUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        perms: { cotizador: false, financiera: false, cajas: true, envios: false, usuarios: false },
      });
    expect(res.status).toBe(200);
  });

  it('ID inexistente → 404', async () => {
    const res = await request(app)
      .put('/api/usuarios/999999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('sin campos → 400', async () => {
    const res = await request(app)
      .put(`/api/usuarios/${nuevoUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/usuarios/:id', () => {
  it('admin elimina usuario → 200', async () => {
    const res = await request(app)
      .delete(`/api/usuarios/${nuevoUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('usuario ya eliminado → 404', async () => {
    const res = await request(app)
      .delete(`/api/usuarios/${nuevoUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('no puede eliminar su propia cuenta → 400', async () => {
    // el token del admin es el TEST_USER — buscar su ID
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);
    const myId = meRes.body.id;

    const res = await request(app)
      .delete(`/api/usuarios/${myId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
describe('GET /api/config', () => {
  it('admin puede leer config', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe('PUT /api/config', () => {
  it('admin actualiza pct_financiera → 200', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pct_financiera: 3.5 });
    expect(res.status).toBe(200);
    expect(Number(res.body.pct_financiera)).toBe(3.5);
  });

  it('rechaza pct_financiera negativo → 400', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pct_financiera: -1 });
    expect(res.status).toBe(400);
  });

  it('rechaza pct_financiera > 100 → 400', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pct_financiera: 101 });
    expect(res.status).toBe(400);
  });

  it('usuario op (sin permiso financiera) → 403', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${opToken}`)
      .send({ pct_financiera: 5 });
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════
// CONTACTOS (requiere permiso 'cajas')
// ═══════════════════════════════════════════════════════════════
describe('POST /api/contactos', () => {
  it('admin crea contacto → 201', async () => {
    const res = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Juan', apellido: 'Pérez', tipo: 'cliente' });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Juan');
    contactoId = res.body.id;
  });

  it('rechaza tipo inválido → 400', async () => {
    const res = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'X', tipo: 'desconocido' });
    expect(res.status).toBe(400);
  });

  it('rechaza nombre vacío → 400', async () => {
    const res = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: '', tipo: 'cliente' });
    expect(res.status).toBe(400);
  });

  it('usuario sin permiso cajas → 403', async () => {
    const res = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${opToken}`)
      .send({ nombre: 'Test', tipo: 'cliente' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/contactos', () => {
  it('devuelve lista de contactos', async () => {
    const res = await request(app)
      .get('/api/contactos')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map(c => c.id);
    expect(ids).toContain(contactoId);
  });
});

describe('PUT /api/contactos/:id', () => {
  it('actualiza apellido del contacto', async () => {
    const res = await request(app)
      .put(`/api/contactos/${contactoId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ apellido: 'García' });
    expect(res.status).toBe(200);
    expect(res.body.apellido).toBe('García');
  });

  it('actualiza tipo del contacto', async () => {
    const res = await request(app)
      .put(`/api/contactos/${contactoId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'inversor' });
    expect(res.status).toBe(200);
    expect(res.body.tipo).toBe('inversor');
  });

  it('ID inexistente → 404', async () => {
    const res = await request(app)
      .put('/api/contactos/999999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/contactos/:id', () => {
  it('elimina (soft-delete) el contacto', async () => {
    const res = await request(app)
      .delete(`/api/contactos/${contactoId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('contacto eliminado ya no aparece en GET', async () => {
    const res = await request(app)
      .get('/api/contactos')
      .set('Authorization', `Bearer ${adminToken}`);
    const ids = res.body.map(c => c.id);
    expect(ids).not.toContain(contactoId);
  });

  it('eliminar de nuevo → 404', async () => {
    const res = await request(app)
      .delete(`/api/contactos/${contactoId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// VENDEDORES (requiere permiso 'financiera')
// ═══════════════════════════════════════════════════════════════
describe('POST /api/vendedores', () => {
  it('admin crea vendedor → 201', async () => {
    const res = await request(app)
      .post('/api/vendedores')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Vendedor Test' });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Vendedor Test');
    vendedorId = res.body.id;
  });

  it('rechaza nombre vacío → 400', async () => {
    const res = await request(app)
      .post('/api/vendedores')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: '' });
    expect(res.status).toBe(400);
  });

  it('usuario sin permiso financiera → 403', async () => {
    const res = await request(app)
      .post('/api/vendedores')
      .set('Authorization', `Bearer ${opToken}`)
      .send({ nombre: 'Intento' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/vendedores', () => {
  it('devuelve lista de vendedores ordenada por nombre', async () => {
    const res = await request(app)
      .get('/api/vendedores')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map(v => v.id);
    expect(ids).toContain(vendedorId);
  });
});

describe('DELETE /api/vendedores/:id', () => {
  it('elimina el vendedor → 200', async () => {
    const res = await request(app)
      .delete(`/api/vendedores/${vendedorId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('vendedor eliminado ya no aparece en GET', async () => {
    const res = await request(app)
      .get('/api/vendedores')
      .set('Authorization', `Bearer ${adminToken}`);
    const ids = res.body.map(v => v.id);
    expect(ids).not.toContain(vendedorId);
  });
});

/**
 * Tests de integración — Búsqueda global cross-módulo (U-23 TANDA 6).
 *
 * Cubre el contrato del endpoint `GET /api/search`:
 *   · 4 entidades (clientes, productos, ventas, envíos) matcheando ILIKE
 *   · counts vs items (LIMIT)
 *   · permisos por categoría sin tirar 403
 *   · validación: min/max chars, .strict() rechaza keys extra
 *   · resistencia a SQL injection
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, adminToken;
const hoy = new Date().toISOString().split('T')[0];
const auth = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const r = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = r.body.token;

  // Seed minimal directo a la BD para no tener que armar 4 flujos de alta
  // completos (producto requiere categoria, venta requiere items, etc.).
  // Apuntamos a que cada entidad tenga al menos 1 match sobre "iphone".

  // Clientes: 2 contactos, uno con "iphone" en el nombre (raro pero válido
  // para test), otro que NO debe matchear.
  await pool.query(`
    INSERT INTO contactos (nombre, apellido, tipo) VALUES
      ('Juan',  'iPhone-test',  'cliente'),
      ('Pedro', 'García',       'cliente'),
      ('Maria', 'López',        'cliente')
  `);

  // Productos: 1 categoría dummy + 3 productos. El borrado/vendido no debe aparecer.
  const { rows: catRows } = await pool.query(
    "INSERT INTO categorias (nombre) VALUES ('Test Cat') RETURNING id"
  );
  const catId = catRows[0].id;
  await pool.query(`
    INSERT INTO productos (nombre, imei, precio_venta, precio_moneda, estado, cantidad, categoria_id)
    VALUES
      ('iPhone 13 Pro',  '350000000000001', 900, 'USD', 'disponible', 1, $1),
      ('iPhone 14',      '350000000000002', 1000, 'USD', 'disponible', 1, $1),
      ('Samsung S23',    '350000000000003', 700, 'USD', 'disponible', 1, $1),
      ('iPhone 12 viejo','350000000000099', 500, 'USD', 'vendido',    0, $1)
  `, [catId]);

  // Ventas: 2 ventas. Una con cliente_nombre "iPhone Fan" (matchea por
  // cliente_nombre), otra con item cuya descripcion contiene "iphone".
  const { rows: v1 } = await pool.query(`
    INSERT INTO ventas (order_id, fecha, cliente_nombre, total_usd, estado)
    VALUES ('V-001', $1, 'iPhone Fan', 900, 'acreditado')
    RETURNING id
  `, [hoy]);
  const { rows: v2 } = await pool.query(`
    INSERT INTO ventas (order_id, fecha, cliente_nombre, total_usd, estado)
    VALUES ('V-002', $1, 'Anonimo', 1000, 'pendiente')
    RETURNING id
  `, [hoy]);
  await pool.query(`
    INSERT INTO venta_items (venta_id, descripcion, imei, cantidad, precio_vendido, moneda)
    VALUES ($1, 'Cargador genérico', NULL, 1, 100, 'USD'),
           ($2, 'iPhone 14 unidad',  '350000000000002', 1, 1000, 'USD')
  `, [v1[0].id, v2[0].id]);

  // Envíos: 3 envíos, uno con "iPhone" en cliente, dos sin match.
  await pool.query(`
    INSERT INTO envios (fecha, cliente, telefono, direccion, costo_envio, total_cobrado, estado)
    VALUES
      ($1, 'iPhone Buyer',    '11-1111', 'Av Corrientes 123', 0, 1000, 'Pendiente'),
      ($1, 'Pedro Gomez',     '11-2222', 'Calle Falsa 456',   0, 500,  'Entregado'),
      ($1, 'Maria Sosa',      '11-3333', 'Belgrano 789',      0, 800,  'Pendiente')
  `, [hoy]);
});

afterAll(async () => { await teardownTestDb(pool); });

describe('GET /api/search — búsqueda global', () => {
  it('devuelve matches en las 4 categorías para query "iphone"', async () => {
    const r = await request(app).get('/api/search?q=iphone').set(auth(adminToken));
    expect(r.status).toBe(200);
    expect(r.body.query).toBe('iphone');
    expect(r.body.results).toBeDefined();
    expect(r.body.counts).toBeDefined();

    // Clientes: matchea "Juan iPhone-test" (1)
    expect(r.body.results.clientes.length).toBe(1);
    expect(r.body.counts.clientes).toBe(1);
    expect(r.body.results.clientes[0].apellido).toMatch(/iPhone/i);

    // Productos: 2 iPhone disponibles (el vendido se excluye)
    expect(r.body.results.productos.length).toBe(2);
    expect(r.body.counts.productos).toBe(2);
    expect(r.body.results.productos.every(p => /iphone/i.test(p.nombre))).toBe(true);

    // Ventas: 2 — una por cliente_nombre, otra por item.descripcion
    expect(r.body.results.ventas.length).toBe(2);
    expect(r.body.counts.ventas).toBe(2);

    // Envíos: 1
    expect(r.body.results.envios.length).toBe(1);
    expect(r.body.counts.envios).toBe(1);
    expect(r.body.results.envios[0].cliente).toMatch(/iPhone/i);
  });

  it('matchea productos también por IMEI', async () => {
    const r = await request(app).get('/api/search?q=350000000000001').set(auth(adminToken));
    expect(r.status).toBe(200);
    expect(r.body.results.productos.length).toBe(1);
    expect(r.body.results.productos[0].imei).toBe('350000000000001');
  });

  it('matchea ventas por IMEI dentro de un item', async () => {
    const r = await request(app).get('/api/search?q=350000000000002').set(auth(adminToken));
    expect(r.status).toBe(200);
    // El producto disponible también matchea por su IMEI
    expect(r.body.results.productos.length).toBe(1);
    // La venta V-002 lo tiene en su item
    expect(r.body.results.ventas.length).toBe(1);
    expect(r.body.results.ventas[0].cliente_nombre).toBe('Anonimo');
  });

  it('matchea envíos por dirección', async () => {
    const r = await request(app).get('/api/search?q=corrientes').set(auth(adminToken));
    expect(r.status).toBe(200);
    expect(r.body.results.envios.length).toBe(1);
    expect(r.body.results.envios[0].direccion).toMatch(/Corrientes/i);
  });

  it('devuelve arrays vacíos cuando la query no matchea nada', async () => {
    const r = await request(app).get('/api/search?q=xyzzyx').set(auth(adminToken));
    expect(r.status).toBe(200);
    expect(r.body.results.clientes).toEqual([]);
    expect(r.body.results.productos).toEqual([]);
    expect(r.body.results.ventas).toEqual([]);
    expect(r.body.results.envios).toEqual([]);
    expect(r.body.counts).toEqual({ clientes: 0, productos: 0, ventas: 0, envios: 0 });
  });

  it('respeta el limit: items ≤ limit, counts puede ser mayor', async () => {
    // Insertamos 7 clientes que matchean "buscable" para forzar truncado
    for (let i = 0; i < 7; i++) {
      await pool.query(
        "INSERT INTO contactos (nombre, apellido, tipo) VALUES ($1, 'Sosa', 'cliente')",
        [`Buscable${i}`]
      );
    }
    const r = await request(app).get('/api/search?q=buscable&limit=3').set(auth(adminToken));
    expect(r.status).toBe(200);
    expect(r.body.results.clientes.length).toBe(3);
    expect(r.body.counts.clientes).toBe(7);
  });

  it('limit=20 es aceptado, limit=21 → 400', async () => {
    const ok = await request(app).get('/api/search?q=iphone&limit=20').set(auth(adminToken));
    expect(ok.status).toBe(200);
    const bad = await request(app).get('/api/search?q=iphone&limit=21').set(auth(adminToken));
    expect(bad.status).toBe(400);
  });

  it('rechaza q con menos de 2 chars (400)', async () => {
    const r = await request(app).get('/api/search?q=a').set(auth(adminToken));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
  });

  it('trim de q: "  ab  " es válido pero "  a  " no (después de trim queda 1 char)', async () => {
    const ok = await request(app).get('/api/search').query({ q: '  ip  ' }).set(auth(adminToken));
    expect(ok.status).toBe(200);
    expect(ok.body.query).toBe('ip'); // trimmed
    const bad = await request(app).get('/api/search').query({ q: '  a  ' }).set(auth(adminToken));
    expect(bad.status).toBe(400);
  });

  it('rechaza params extra (.strict)', async () => {
    const r = await request(app).get('/api/search?q=iphone&extra=foo').set(auth(adminToken));
    expect(r.status).toBe(400);
  });

  it('rechaza q vacío (400)', async () => {
    const r = await request(app).get('/api/search?q=').set(auth(adminToken));
    expect(r.status).toBe(400);
  });

  it('no rompe ni filtra resultados con caracteres SQL injection / wildcards', async () => {
    // Probamos un payload típico de inyección — el endpoint debe devolver
    // 200 con results vacíos (la cadena no aparece literal en la BD).
    const inj = "'; DROP TABLE contactos; --";
    const r = await request(app).get('/api/search').query({ q: inj }).set(auth(adminToken));
    expect(r.status).toBe(200);
    expect(r.body.results.clientes).toEqual([]);
    // Comprobamos que la tabla SIGUE existiendo y con datos (el INSERT del
    // beforeAll dejó al menos los 3 contactos originales + los buscables del
    // test de limit).
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM contactos WHERE deleted_at IS NULL');
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('requiere autenticación (401 sin token)', async () => {
    const r = await request(app).get('/api/search?q=iphone');
    expect(r.status).toBe(401);
  });
});

describe('GET /api/search — permisos por categoría', () => {
  let opTokenSinInv;

  beforeAll(async () => {
    // Operador con permisos para todo MENOS inventario
    await request(app).post('/api/usuarios').set(auth(adminToken)).send({
      nombre: 'Op Sin Inv', username: 'opnoinv', password: 'opnoinv123', role: 'op',
      perms: {
        contactos: true, cuentas: true, inventario: false,
        ventas: true, envios: true,
      },
    });
    const r = await request(app).post('/api/auth/login')
      .send({ username: 'opnoinv', password: 'opnoinv123' });
    opTokenSinInv = r.body.token;
  });

  it('user sin permiso inventario → productos: [] pero las otras categorías funcionan', async () => {
    const r = await request(app).get('/api/search?q=iphone').set(auth(opTokenSinInv));
    expect(r.status).toBe(200);
    // Productos bloqueado
    expect(r.body.results.productos).toEqual([]);
    expect(r.body.counts.productos).toBe(0);
    // El resto debe seguir devolviendo matches
    expect(r.body.results.clientes.length).toBeGreaterThan(0);
    expect(r.body.results.ventas.length).toBeGreaterThan(0);
    expect(r.body.results.envios.length).toBeGreaterThan(0);
  });

  it('user sin ningún permiso de las 4 categorías → todo vacío sin 403', async () => {
    // Op solo con 'cajas' por ejemplo — ninguno de los 4 toggles de search aplica
    await request(app).post('/api/usuarios').set(auth(adminToken)).send({
      nombre: 'Op Cajas', username: 'opcajas', password: 'opcajas123', role: 'op',
      perms: { cajas: true },
    });
    const log = await request(app).post('/api/auth/login')
      .send({ username: 'opcajas', password: 'opcajas123' });
    const r = await request(app).get('/api/search?q=iphone').set(auth(log.body.token));
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual({ clientes: [], productos: [], ventas: [], envios: [] });
    expect(r.body.counts).toEqual({ clientes: 0, productos: 0, ventas: 0, envios: 0 });
  });
});

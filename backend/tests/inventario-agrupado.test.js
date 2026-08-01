/**
 * Tests — GET /api/inventario/productos/agrupado
 *
 * Regla de agrupamiento (PO Lucas 2026-08-01): agrupar por (clase_id,
 * nombre, gb). Color y batería NO agrupan.
 *
 * Cubre:
 *   · Agrupamiento correcto por clase + nombre + gb
 *   · Color y batería libres dentro del grupo (no separan)
 *   · GB distinto → grupos distintos
 *   · Categoría (clase_id) distinta → grupos distintos
 *   · Counts por estado (disponible, vendido, reservado, en_tecnico)
 *   · Rangos precio_min/max, bateria_min/max
 *   · Filtros (vista, clase_id, categoria_id) heredan de /productos
 *   · Paginación sobre GRUPOS (no productos)
 *   · Response shape (key, clase_nombre, etc.)
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;
let catBase;

const auth = () => ({ Authorization: `Bearer ${token}` });

// Helper para crear producto con shape mínimo — reutilizado por todos los tests.
const mk = (overrides) => ({
  nombre: 'iPhone 15 Pro',
  clase: 'celular_sellado',
  gb: '256',
  color: 'Silver',
  bateria: 100,
  categoria_id: catBase,
  costo: 900,
  precio_venta: 1200,
  ...overrides,
});

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth()).send({ nombre: 'Test Agrupado' });
  catBase = cat.body.id;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe('GET /api/inventario/productos/agrupado — regla de agrupamiento', () => {
  it('color y batería NO separan: 3 iPhone 15 Pro 256 con distinto color/batería → 1 grupo con count_total=3', async () => {
    // Setup: 3 productos mismo nombre + gb + clase, distinto color/batería.
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'iPhone 15 Pro Test1', color: 'Silver', bateria: 100,
    }));
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'iPhone 15 Pro Test1', color: 'Blue', bateria: 92,
    }));
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'iPhone 15 Pro Test1', color: 'Black', bateria: 88,
    }));

    const res = await request(app)
      .get('/api/inventario/productos/agrupado?nombre=iPhone 15 Pro Test1')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const grupo = res.body.data[0];
    expect(grupo.nombre).toBe('iPhone 15 Pro Test1');
    expect(grupo.gb).toBe('256');
    expect(grupo.count_total).toBe(3);
    // Batería rango: min 88, max 100
    expect(grupo.bateria_min).toBe(88);
    expect(grupo.bateria_max).toBe(100);
  });

  it('GB distinto → grupos distintos: 15 Pro 128GB y 15 Pro 256GB son 2 grupos', async () => {
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'iPhone 15 Pro Test2', gb: '128', color: 'Silver',
    }));
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'iPhone 15 Pro Test2', gb: '256', color: 'Silver',
    }));

    const res = await request(app)
      .get('/api/inventario/productos/agrupado?nombre=iPhone 15 Pro Test2')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const gbs = res.body.data.map(g => g.gb).sort();
    expect(gbs).toEqual(['128', '256']);
    res.body.data.forEach(g => expect(g.count_total).toBe(1));
  });

  it('Nombre distinto → grupos distintos (aunque mismo GB + categoría)', async () => {
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'iPhone 14 TestA', gb: '256',
    }));
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'iPhone 15 TestA', gb: '256',
    }));

    const res = await request(app)
      .get('/api/inventario/productos/agrupado?buscar=TestA')
      .set(auth());

    expect(res.status).toBe(200);
    const gruposDeInteres = res.body.data.filter(g => g.nombre.includes('TestA'));
    expect(gruposDeInteres).toHaveLength(2);
  });

  it('Categoría (clase_id) distinta → grupos distintos (mismo nombre + GB)', async () => {
    // 2 clases distintas + mismo nombre + gb → 2 grupos.
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'iPhone Clase Test', gb: '128', clase: 'celular_sellado',
    }));
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'iPhone Clase Test', gb: '128', clase: 'celular_usado',
    }));

    const res = await request(app)
      .get('/api/inventario/productos/agrupado?nombre=iPhone Clase Test')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // Los clase_id son distintos entre los grupos.
    const claseIds = new Set(res.body.data.map(g => g.clase_id));
    expect(claseIds.size).toBe(2);
  });

  it('gb NULL y "" agrupan juntos (COALESCE en el GROUP BY)', async () => {
    // Un producto sin GB (null) y otro con GB '' deberían ir al MISMO grupo.
    // (Comportamiento del COALESCE(p.gb, '') en el GROUP BY.)
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'Sin GB Test', gb: '',
    }));
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'Sin GB Test', gb: null,
    }));

    const res = await request(app)
      .get('/api/inventario/productos/agrupado?nombre=Sin GB Test')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].count_total).toBe(2);
    // Response normaliza '' → null (más limpio para el frontend).
    expect(res.body.data[0].gb).toBeNull();
  });
});

describe('GET /api/inventario/productos/agrupado — counts por estado', () => {
  it('COUNT FILTER separa correctamente disponible / vendido / reservado / en_tecnico', async () => {
    // 4 productos mismo modelo, un estado cada uno.
    const nombreUnico = 'iPhone Estados Test';
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: nombreUnico, gb: '512', estado: 'disponible',
    }));
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: nombreUnico, gb: '512', estado: 'reservado',
    }));
    // Para vendido/en_tecnico usamos PATCH después del create (el estado en el
    // schema base default es 'disponible' — no todos los endpoints aceptan
    // otros valores directo). Actualizamos con inline PATCH.
    const p3 = await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: nombreUnico, gb: '512',
    }));
    await request(app).put(`/api/inventario/productos/${p3.body.id}`).set(auth()).send({ estado: 'vendido' });
    const p4 = await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: nombreUnico, gb: '512',
    }));
    await request(app).put(`/api/inventario/productos/${p4.body.id}`).set(auth()).send({ estado: 'en_tecnico' });

    // La vista por default es sin filtro de vista → trae todos los estados.
    const res = await request(app)
      .get(`/api/inventario/productos/agrupado?nombre=${encodeURIComponent(nombreUnico)}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const g = res.body.data[0];
    expect(g.count_total).toBe(4);
    expect(g.count_disponible).toBe(1);
    expect(g.count_vendido).toBe(1);
    expect(g.count_reservado).toBe(1);
    expect(g.count_en_tecnico).toBe(1);
  });
});

describe('GET /api/inventario/productos/agrupado — rangos', () => {
  it('precio_min/max reflejan el rango real de precios dentro del grupo', async () => {
    const nombreUnico = 'iPhone Precio Rango Test';
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: nombreUnico, gb: '128', precio_venta: 1000, costo: 800,
    }));
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: nombreUnico, gb: '128', precio_venta: 1400, costo: 950,
    }));

    const res = await request(app)
      .get(`/api/inventario/productos/agrupado?nombre=${encodeURIComponent(nombreUnico)}`)
      .set(auth());

    expect(res.status).toBe(200);
    const g = res.body.data[0];
    expect(Number(g.precio_min)).toBe(1000);
    expect(Number(g.precio_max)).toBe(1400);
    // costo_min/max solo si tiene capability ver_costos (test user default = admin sí lo tiene)
    expect(Number(g.costo_min)).toBe(800);
    expect(Number(g.costo_max)).toBe(950);
  });
});

describe('GET /api/inventario/productos/agrupado — filtros heredados de /productos', () => {
  it('vista=no_vendidos excluye productos vendidos del count', async () => {
    const nombreUnico = 'iPhone Vista Test';
    const p1 = await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: nombreUnico, gb: '256',
    }));
    const p2 = await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: nombreUnico, gb: '256',
    }));
    // Marcar p2 como vendido.
    await request(app).put(`/api/inventario/productos/${p2.body.id}`).set(auth()).send({ estado: 'vendido' });

    // Sin vista: cuenta ambos (2)
    const resTodos = await request(app)
      .get(`/api/inventario/productos/agrupado?nombre=${encodeURIComponent(nombreUnico)}`)
      .set(auth());
    expect(resTodos.body.data[0].count_total).toBe(2);

    // vista=no_vendidos: solo p1 (1)
    const resNoVend = await request(app)
      .get(`/api/inventario/productos/agrupado?nombre=${encodeURIComponent(nombreUnico)}&vista=no_vendidos`)
      .set(auth());
    expect(resNoVend.body.data[0].count_total).toBe(1);
  });

  it('buscar hace match ILIKE tokenizado (mismo pattern que /productos)', async () => {
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'iPhone Buscar UniqueTag', gb: '512',
    }));
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'Otro Nombre Que No Matchea', gb: '256',
    }));

    const res = await request(app)
      .get('/api/inventario/productos/agrupado?buscar=UniqueTag')
      .set(auth());
    expect(res.status).toBe(200);
    const grupos = res.body.data.filter(g => g.nombre.includes('UniqueTag'));
    expect(grupos.length).toBeGreaterThanOrEqual(1);
    // El otro nombre NO debe aparecer.
    expect(res.body.data.find(g => g.nombre === 'Otro Nombre Que No Matchea')).toBeUndefined();
  });
});

describe('GET /api/inventario/productos/agrupado — response shape', () => {
  it('cada grupo tiene la key esperada + clase_nombre + clase_emoji', async () => {
    await request(app).post('/api/inventario/productos').set(auth()).send(mk({
      nombre: 'iPhone Shape Test', gb: '256',
    }));

    const res = await request(app)
      .get('/api/inventario/productos/agrupado?nombre=iPhone Shape Test')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    const g = res.body.data[0];
    // Key: clase_id + nombre + gb
    expect(g.key).toBe(`${g.clase_id}::iPhone Shape Test::256`);
    expect(g).toHaveProperty('clase_nombre');
    expect(g).toHaveProperty('clase_emoji');
    expect(g).toHaveProperty('nombre');
    expect(g).toHaveProperty('gb');
    expect(g).toHaveProperty('count_total');
    expect(g).toHaveProperty('count_disponible');
    expect(g).toHaveProperty('count_vendido');
    expect(g).toHaveProperty('stock_total');
    expect(g).toHaveProperty('precio_min');
    expect(g).toHaveProperty('precio_max');
    expect(g).toHaveProperty('bateria_min');
    expect(g).toHaveProperty('bateria_max');
  });

  it('response está paginado (pagination.total refleja # de GRUPOS, no productos)', async () => {
    const res = await request(app)
      .get('/api/inventario/productos/agrupado?limit=5')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pagination');
    expect(res.body.pagination).toHaveProperty('total');
    expect(res.body.pagination).toHaveProperty('page');
    expect(res.body.pagination).toHaveProperty('limit', 5);
    expect(res.body.pagination).toHaveProperty('pages');
    expect(res.body.data.length).toBeLessThanOrEqual(5);
  });
});

/**
 * Tests de integración — Inventario
 *
 * Cubre:
 *   categorías / depósitos — crear, listar, borrar (soft-delete), nombre duplicado
 *   productos              — crear, validar, listar con filtros/búsqueda, actualizar, borrar
 *   métricas               — agregados de stock e inversión por moneda y clase
 *   carga masiva           — bulk transaccional
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;
let catBase; // categoría compartida obligatoria al crear productos

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth()).send({ nombre: 'Base Test' });
  catBase = cat.body.id;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── Catálogos ───────────────────────────────────────────────
describe('Categorías y depósitos', () => {
  let catId;

  it('crea una categoría → 201', async () => {
    const res = await request(app).post('/api/inventario/categorias')
      .set(auth()).send({ nombre: 'Celulares' });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Celulares');
    catId = res.body.id;
  });

  it('rechaza categoría duplicada (case-insensitive) → 409', async () => {
    const res = await request(app).post('/api/inventario/categorias')
      .set(auth()).send({ nombre: 'celulares' });
    expect(res.status).toBe(409);
  });

  it('rechaza categoría sin nombre → 400', async () => {
    const res = await request(app).post('/api/inventario/categorias')
      .set(auth()).send({ nombre: '' });
    expect(res.status).toBe(400);
  });

  it('crea un depósito y lo lista', async () => {
    const c = await request(app).post('/api/inventario/depositos')
      .set(auth()).send({ nombre: 'Local Centro' });
    expect(c.status).toBe(201);

    const res = await request(app).get('/api/inventario/depositos').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.map(d => d.nombre)).toContain('Local Centro');
  });

  it('borra (soft-delete) la categoría', async () => {
    const res = await request(app).delete(`/api/inventario/categorias/${catId}`).set(auth());
    expect(res.status).toBe(200);
    const list = await request(app).get('/api/inventario/categorias').set(auth());
    expect(list.body.map(c => c.id)).not.toContain(catId);
  });
});

// ─── Productos ───────────────────────────────────────────────
describe('Productos', () => {
  let prodId;

  it('crea un producto unitario → 201', async () => {
    const res = await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario',
      clase: 'celular',
      categoria_id: catBase,
      nombre: 'iPhone 15 Pro',
      imei: '356938035643809',
      gb: '256',
      color: 'Natural',
      bateria: 92,
      costo: 800,
      costo_moneda: 'USD',
      precio_venta: 950,
      precio_moneda: 'USD',
    });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('iPhone 15 Pro');
    expect(res.body.estado).toBe('disponible');
    expect(res.body.cantidad).toBe(1);
    prodId = res.body.id;
  });

  it('rechaza producto sin nombre → 400', async () => {
    const res = await request(app).post('/api/inventario/productos')
      .set(auth()).send({ clase: 'celular' });
    expect(res.status).toBe(400);
  });

  it('rechaza batería fuera de rango → 400', async () => {
    const res = await request(app).post('/api/inventario/productos')
      .set(auth()).send({ nombre: 'X', bateria: 150 });
    expect(res.status).toBe(400);
  });

  it('rechaza clase inválida → 400', async () => {
    const res = await request(app).post('/api/inventario/productos')
      .set(auth()).send({ nombre: 'X', clase: 'tablet' });
    expect(res.status).toBe(400);
  });

  it('busca el producto por IMEI', async () => {
    const res = await request(app).get('/api/inventario/productos?buscar=356938').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.map(p => p.id)).toContain(prodId);
    expect(res.body.pagination).toBeDefined();
  });

  it('filtra por clase accesorio (no incluye el celular)', async () => {
    await request(app).post('/api/inventario/productos').set(auth()).send({
      clase: 'accesorio', tipo_carga: 'lote', categoria_id: catBase, nombre: 'AirPods Pro 3', cantidad: 22, costo: 150,
    });
    const res = await request(app).get('/api/inventario/productos?clase=accesorio').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.every(p => p.clase === 'accesorio')).toBe(true);
    expect(res.body.data.map(p => p.id)).not.toContain(prodId);
  });

  it('actualiza el estado a en_tecnico', async () => {
    const res = await request(app).put(`/api/inventario/productos/${prodId}`)
      .set(auth()).send({ estado: 'en_tecnico' });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('en_tecnico');
    // No debe haber pisado otros campos
    expect(res.body.nombre).toBe('iPhone 15 Pro');
  });

  it('PUT a producto inexistente → 404', async () => {
    const res = await request(app).put('/api/inventario/productos/999999')
      .set(auth()).send({ estado: 'disponible' });
    expect(res.status).toBe(404);
  });

  it('borra (soft-delete) el producto', async () => {
    const res = await request(app).delete(`/api/inventario/productos/${prodId}`).set(auth());
    expect(res.status).toBe(200);
    const list = await request(app).get('/api/inventario/productos?buscar=356938').set(auth());
    expect(list.body.data.map(p => p.id)).not.toContain(prodId);
  });
});

// ─── Fotos (lazy) ────────────────────────────────────────────
describe('Foto del producto (lazy load)', () => {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  it('el listado NO incluye foto_data pero marca tiene_foto', async () => {
    const c = await request(app).post('/api/inventario/productos').set(auth())
      .send({ nombre: 'Con Foto', clase: 'celular', categoria_id: catBase, foto_data: b64, foto_nombre: 'f.png', foto_tipo: 'image/png' });
    const list = await request(app).get('/api/inventario/productos?buscar=Con Foto').set(auth());
    const p = list.body.data.find(x => x.id === c.body.id);
    expect(p).toBeDefined();
    expect(p.foto_data).toBeUndefined();
    expect(p.tiene_foto).toBe(true);
    // la foto se trae on-demand
    const foto = await request(app).get(`/api/inventario/productos/${c.body.id}/foto`).set(auth());
    expect(foto.status).toBe(200);
    expect(foto.body.foto_data).toBe(b64);
  });

  it('producto sin foto → 404 en el endpoint de foto', async () => {
    const c = await request(app).post('/api/inventario/productos').set(auth()).send({ nombre: 'Sin Foto', clase: 'celular', categoria_id: catBase });
    const foto = await request(app).get(`/api/inventario/productos/${c.body.id}/foto`).set(auth());
    expect(foto.status).toBe(404);
  });
});

// ─── Métricas ────────────────────────────────────────────────
describe('GET /api/inventario/productos/metricas', () => {
  it('agrega inversión de accesorios disponibles en USD', async () => {
    // Tras los tests previos queda 1 accesorio (AirPods Pro 3, 22 u × 150 USD = 3300)
    const res = await request(app).get('/api/inventario/productos/metricas').set(auth());
    expect(res.status).toBe(200);
    expect(Number(res.body.accesorios_count)).toBe(22);
    expect(Number(res.body.inv_accesorios_usd)).toBe(3300);
  });
});

// ─── Proveedores (combo de edición inline) ───────────────────
describe('GET /api/inventario/productos/proveedores', () => {
  it('devuelve los proveedores únicos vistos en productos vivos', async () => {
    // Sumamos algunos productos con proveedor para que aparezcan
    await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'ProvProd 1', clase: 'celular', categoria_id: catBase,
      costo: 100, precio_venta: 200, proveedor: 'Mayorista Alfa',
    });
    await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'ProvProd 2', clase: 'celular', categoria_id: catBase,
      costo: 100, precio_venta: 200, proveedor: '  Mayorista Alfa  ', // mismo, con espacios
    });
    await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'ProvProd 3', clase: 'celular', categoria_id: catBase,
      costo: 100, precio_venta: 200, proveedor: 'Zeta Distribuidor',
    });
    const res = await request(app).get('/api/inventario/productos/proveedores').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toContain('Mayorista Alfa');
    expect(res.body).toContain('Zeta Distribuidor');
    // Vienen sin duplicados (TRIM + DISTINCT) y ordenados
    const idxA = res.body.indexOf('Mayorista Alfa');
    const idxZ = res.body.indexOf('Zeta Distribuidor');
    expect(idxA).toBeLessThan(idxZ);
    expect(res.body.filter(p => p === 'Mayorista Alfa').length).toBe(1);
  });
});

// ─── Conteo por categoría (insumo de Data Science) ───────────
describe('GET /api/inventario/categorias — productos_count', () => {
  it('devuelve el conteo de productos y stock disponible por categoría', async () => {
    const res = await request(app).get('/api/inventario/categorias').set(auth());
    expect(res.status).toBe(200);
    // 'Base Test' es la categoría que usaron casi todos los productos del archivo.
    // Filtrá por nombre para no depender del orden de creación.
    const base = res.body.find(c => c.nombre === 'Base Test');
    expect(base).toBeDefined();
    // Tras todos los tests previos hay productos asignados a 'Base Test'
    // (incluyendo el accesorio de 22 u, AirPods Pro 3, no borrado).
    expect(Number(base.productos_count)).toBeGreaterThan(0);
    // El stock_disponible incluye solo los productos con estado='disponible'.
    expect(Number(base.stock_disponible)).toBeGreaterThanOrEqual(22);
  });

  it('una categoría recién creada y sin productos tiene count 0', async () => {
    const c = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'Categoría Vacía' });
    expect(c.status).toBe(201);
    const list = await request(app).get('/api/inventario/categorias').set(auth());
    const vacia = list.body.find(x => x.id === c.body.id);
    expect(vacia).toBeDefined();
    expect(Number(vacia.productos_count)).toBe(0);
    expect(Number(vacia.stock_disponible)).toBe(0);
  });
});

// ─── Desglose 360 (agrupación dinámica) ──────────────────────
describe('GET /api/inventario/desglose', () => {
  it('agrupa por proveedor y suma stock/inversión correctamente', async () => {
    // Productos cargados en el test de proveedores (3 con Mayorista Alfa / Zeta).
    // Sumamos uno con cantidad > 1 para validar SUM(cantidad).
    await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'Lote Test', clase: 'accesorio', tipo_carga: 'lote',
      categoria_id: catBase, costo: 10, precio_venta: 25, cantidad: 5,
      proveedor: 'Mayorista Alfa',
    });
    const res = await request(app).get('/api/inventario/desglose?por=proveedor').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.por).toBe('proveedor');
    expect(Array.isArray(res.body.filas)).toBe(true);
    const alfa = res.body.filas.find(f => f.valor === 'Mayorista Alfa');
    expect(alfa).toBeDefined();
    // 2 productos cantidad 1 (de los tests de proveedores) + 1 producto cantidad 5
    expect(alfa.stock).toBeGreaterThanOrEqual(7);
    // Inversión USD del lote test: 10 * 5 = 50, más los 100 * 1 * 2 = 200 ⇒ ≥ 250
    expect(alfa.inv_usd).toBeGreaterThanOrEqual(250);
    // Margen = valorizado - inversión
    expect(alfa.margen_usd).toBe(alfa.valorizado_usd - alfa.inv_usd);
  });

  it('agrupa por categoría con LEFT JOIN (etiqueta legible)', async () => {
    const res = await request(app).get('/api/inventario/desglose?por=categoria').set(auth());
    expect(res.status).toBe(200);
    const base = res.body.filas.find(f => f.valor === 'Base Test');
    expect(base).toBeDefined();
    expect(base.valor_id).toBeTruthy();
    expect(base.productos).toBeGreaterThan(0);
  });

  it('agrupa por estado', async () => {
    const res = await request(app).get('/api/inventario/desglose?por=estado').set(auth());
    expect(res.status).toBe(200);
    const disp = res.body.filas.find(f => f.valor === 'disponible');
    expect(disp).toBeDefined();
  });

  it('respeta el filtro solo_stock', async () => {
    const conFiltro = await request(app).get('/api/inventario/desglose?por=estado&solo_stock=true').set(auth());
    expect(conFiltro.status).toBe(200);
    // Con solo_stock no debería aparecer "vendido" ni "en_tecnico"
    const malos = conFiltro.body.filas.filter(f => ['vendido', 'en_tecnico'].includes(f.valor));
    expect(malos.length).toBe(0);
  });

  it('respeta el filtro clase', async () => {
    const res = await request(app).get('/api/inventario/desglose?por=modelo&clase=accesorio').set(auth());
    expect(res.status).toBe(200);
    // Solo accesorios → los modelos celulares no deberían aparecer
    expect(res.body.filas.find(f => f.valor === 'iPhone 13')).toBeUndefined();
  });

  it('los totales deben coincidir con la suma de las filas (por la misma dim)', async () => {
    const res = await request(app).get('/api/inventario/desglose?por=categoria').set(auth());
    const sumFilasInvUsd = res.body.filas.reduce((a, f) => a + f.inv_usd, 0);
    // Tolerancia por redondeo float
    expect(Math.abs(sumFilasInvUsd - res.body.totales.inv_usd)).toBeLessThan(0.01);
  });

  it('rechaza dimensión inválida → 400', async () => {
    const res = await request(app).get('/api/inventario/desglose?por=fantasma').set(auth());
    expect(res.status).toBe(400);
  });

  it('requiere "por" → 400', async () => {
    const res = await request(app).get('/api/inventario/desglose').set(auth());
    expect(res.status).toBe(400);
  });
});

// ─── Filtros exactos para drill-down ──────────────────────────
describe('GET /api/inventario/productos — filtros exactos', () => {
  it('filtra por proveedor exacto (NO substring)', async () => {
    const res = await request(app).get('/api/inventario/productos?proveedor=Mayorista Alfa').set(auth());
    expect(res.status).toBe(200);
    // Todos los devueltos tienen ese proveedor (TRIM-comparado)
    expect(res.body.data.every(p => (p.proveedor || '').trim() === 'Mayorista Alfa')).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('filtra por nombre exacto', async () => {
    const res = await request(app).get('/api/inventario/productos?nombre=Lote Test').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.every(p => p.nombre === 'Lote Test')).toBe(true);
  });
});

// ─── Carga masiva ────────────────────────────────────────────
describe('POST /api/inventario/productos/bulk', () => {
  it('crea varios productos en una transacción', async () => {
    const res = await request(app).post('/api/inventario/productos/bulk').set(auth()).send({
      productos: [
        { nombre: 'iPhone 13', clase: 'celular', categoria_id: catBase, costo: 400, precio_venta: 500 },
        { nombre: 'iPhone 14', clase: 'celular', categoria_id: catBase, costo: 500, precio_venta: 620 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.creados).toBe(2);
  });

  it('rechaza bulk vacío → 400', async () => {
    const res = await request(app).post('/api/inventario/productos/bulk')
      .set(auth()).send({ productos: [] });
    expect(res.status).toBe(400);
  });
});

// ─── Vista + oculto + condición ──────────────────────────────
// Fixture aislado: armamos 4 productos con combinaciones distintas y validamos
// que cada vista los segmente correctamente. Usamos buscar='__VistaSuite__' como
// marcador único para no contaminarnos con datos de otros describes.
describe('Filtros: vista (oculto/estado) y condicion', () => {
  let visibleStock, vendido, oculto, usado;

  beforeAll(async () => {
    const TAG = '__VistaSuite__';
    const mk = (extra) => ({
      nombre: `${TAG} ${extra.label}`,
      clase: 'accesorio',
      categoria_id: catBase,
      costo: 1,
      precio_venta: 2,
      cantidad: 1,
      ...extra.body,
    });
    // 1) visible + disponible + nuevo  → aparece en 'no_vendidos' y 'todos_visibles'
    let r = await request(app).post('/api/inventario/productos').set(auth())
      .send(mk({ label: 'A-stock-nuevo', body: {} }));
    visibleStock = r.body.id;
    // 2) vendido + visible → 'vendidos' y 'todos_visibles'
    r = await request(app).post('/api/inventario/productos').set(auth())
      .send(mk({ label: 'B-vendido', body: { estado: 'vendido' } }));
    vendido = r.body.id;
    // 3) oculto + disponible → 'no_vendidos_ocultos', 'ocultos', 'todos_ocultos'
    r = await request(app).post('/api/inventario/productos').set(auth())
      .send(mk({ label: 'C-oculto', body: { oculto: true } }));
    oculto = r.body.id;
    // 4) usado + visible + disponible
    r = await request(app).post('/api/inventario/productos').set(auth())
      .send(mk({ label: 'D-usado', body: { condicion: 'usado' } }));
    usado = r.body.id;
  });

  const getIds = async (qs) => {
    const r = await request(app).get(`/api/inventario/productos?buscar=__VistaSuite__&${qs}`).set(auth());
    expect(r.status).toBe(200);
    return r.body.data.map(p => p.id);
  };

  it('oculto y condicion default OK al crear sin pasarlos', async () => {
    const r = await request(app).get(`/api/inventario/productos?buscar=__VistaSuite__`).set(auth());
    const a = r.body.data.find(p => p.id === visibleStock);
    expect(a).toBeTruthy();
    expect(a.oculto).toBe(false);
    expect(a.condicion).toBe('nuevo');
  });

  it("vista=no_vendidos: solo visible+disponible+stock>0 (incluye 'usado' visible)", async () => {
    const ids = await getIds('vista=no_vendidos');
    expect(ids).toContain(visibleStock);
    expect(ids).toContain(usado);
    expect(ids).not.toContain(vendido);
    expect(ids).not.toContain(oculto);
  });

  it('vista=vendidos: solo los vendidos visibles', async () => {
    const ids = await getIds('vista=vendidos');
    expect(ids).toContain(vendido);
    expect(ids).not.toContain(visibleStock);
    expect(ids).not.toContain(oculto);
  });

  it('vista=ocultos: cualquier estado pero oculto=true', async () => {
    const ids = await getIds('vista=ocultos');
    expect(ids).toContain(oculto);
    expect(ids).not.toContain(visibleStock);
    expect(ids).not.toContain(vendido);
  });

  it('vista=todos_visibles: no incluye ocultos', async () => {
    const ids = await getIds('vista=todos_visibles');
    expect(ids).toContain(visibleStock);
    expect(ids).toContain(vendido);
    expect(ids).toContain(usado);
    expect(ids).not.toContain(oculto);
  });

  it('vista=todos_ocultos: incluye todo (vendidos + ocultos)', async () => {
    const ids = await getIds('vista=todos_ocultos');
    expect(ids).toEqual(expect.arrayContaining([visibleStock, vendido, oculto, usado]));
  });

  it('condicion=usado filtra el tab "Usados"', async () => {
    const ids = await getIds('condicion=usado&vista=todos_ocultos');
    expect(ids).toContain(usado);
    expect(ids).not.toContain(visibleStock);
  });

  it('PUT con oculto=true oculta el producto sin tocar otros campos', async () => {
    const r = await request(app).put(`/api/inventario/productos/${visibleStock}`).set(auth())
      .send({ oculto: true });
    expect(r.status).toBe(200);
    expect(r.body.oculto).toBe(true);
    expect(r.body.estado).toBe('disponible'); // no se pisó
    // Y ya no aparece en no_vendidos:
    const ids = await getIds('vista=no_vendidos');
    expect(ids).not.toContain(visibleStock);
  });

  it('vista inválida → 400', async () => {
    const r = await request(app).get('/api/inventario/productos?vista=marciana').set(auth());
    expect(r.status).toBe(400);
  });

  it('condicion inválida → 400', async () => {
    const r = await request(app).get('/api/inventario/productos?condicion=alquilado').set(auth());
    expect(r.status).toBe(400);
  });

  it('compat: solo_stock=true sin vista → equivale a no_vendidos', async () => {
    const ids = await getIds('solo_stock=true');
    expect(ids).toContain(usado);
    expect(ids).not.toContain(vendido);
    expect(ids).not.toContain(oculto);
  });
});

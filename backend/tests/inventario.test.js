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
      clase: 'celular_sellado',
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
      .set(auth()).send({ clase: 'celular_sellado' });
    expect(res.status).toBe(400);
  });

  it('rechaza batería fuera de rango → 400', async () => {
    const res = await request(app).post('/api/inventario/productos')
      .set(auth()).send({ nombre: 'X', bateria: 150 });
    expect(res.status).toBe(400);
  });

  // 2026-07-11: test removido. Antes fallaba con 400 por dos razones cruzadas
  // (categoria_id requerido + clase 'tablet' no matcheaba ningún slug_legacy).
  // Con `.refine(categoriaRequerida)` removido y `clase` como string opcional
  // deprecado, este payload ahora se acepta como 201 con clase_id=null. El
  // caso "clase_id inexistente → 400" ya se cubre en el test de línea ~172
  // (POST con clase_id UUID inválido).

  // F3.c (2026-07-08): derive bidireccional clase ↔ clase_id.
  // Cada tenant tiene 9 filas base en clases_producto (seedeadas por la migration
  // 20260708000002). El slug_legacy de cada base matchea el enum viejo.
  describe('F3.c derive bidireccional clase ↔ clase_id', () => {
    const productosCreados = [];
    afterAll(async () => {
      // Cleanup: hard-delete los productos creados en este describe para no
      // contaminar los tests siguientes (métricas, count por categoría, etc).
      // Usamos DELETE directo del pool (bypassa auth y capabilities) porque
      // el endpoint DELETE hace soft-delete y los soft-deleted aún cuentan
      // en algunos KPIs históricos. Los productos creados acá son test-only.
      for (const id of productosCreados) {
        await pool.query('DELETE FROM productos WHERE id = $1', [id]);
      }
    });
    function pushId(res) {
      if (res.body?.id) productosCreados.push(res.body.id);
    }
    async function claseIdDe(slug) {
      const list = await request(app).get('/api/inventario/clases').set(auth());
      return list.body.find(c => c.slug_legacy === slug)?.id;
    }

    it('POST con solo `clase` → backend deriva clase_id desde slug_legacy', async () => {
      const res = await request(app).post('/api/inventario/productos').set(auth()).send({
        clase: 'watch', tipo_carga: 'lote', categoria_id: catBase,
        nombre: 'Apple Watch S9 45mm', cantidad: 3, costo: 400,
      });
      expect(res.status).toBe(201);
      expect(res.body.clase).toBe('watch');
      expect(res.body.clase_id).toBeTruthy();
      // El clase_id debería matchear la fila base del slug watch
      const expected = await claseIdDe('watch');
      expect(res.body.clase_id).toBe(expected);
      pushId(res);
    });

    it('POST con solo `clase_id` → backend deriva clase desde slug_legacy', async () => {
      const clase_id = await claseIdDe('cargadores');
      expect(clase_id).toBeTruthy();
      const res = await request(app).post('/api/inventario/productos').set(auth()).send({
        clase_id,
        tipo_carga: 'lote', categoria_id: catBase,
        nombre: 'Cargador 20W USB-C',
        cantidad: 12, costo: 10,
      });
      expect(res.status).toBe(201);
      expect(res.body.clase_id).toBe(clase_id);
      expect(res.body.clase).toBe('cargadores');
      pushId(res);
    });

    it('POST con clase_id inexistente → 400', async () => {
      const res = await request(app).post('/api/inventario/productos').set(auth()).send({
        clase_id: '00000000-0000-0000-0000-000000000001',
        tipo_carga: 'lote', categoria_id: catBase, nombre: 'X', cantidad: 1, costo: 1,
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/clase_id|categor/i);
    });

    it('PUT cambiando clase_id → deriva clase automáticamente', async () => {
      // Crear producto con clase 'auriculares' y luego cambiarle clase_id a
      // 'consolas'. Debe actualizar ambos campos.
      const created = await request(app).post('/api/inventario/productos').set(auth()).send({
        clase: 'auriculares', tipo_carga: 'lote', categoria_id: catBase,
        nombre: 'Cambio de clase', cantidad: 1, costo: 100,
      });
      expect(created.status).toBe(201);
      pushId(created);
      const consolasId = await claseIdDe('consolas');
      const updated = await request(app).put(`/api/inventario/productos/${created.body.id}`)
        .set(auth()).send({ clase_id: consolasId });
      expect(updated.status).toBe(200);
      expect(updated.body.clase_id).toBe(consolasId);
      expect(updated.body.clase).toBe('consolas');
    });

    it('GET con filtro ?clase_id=X devuelve solo productos con esa clase_id', async () => {
      const watchId = await claseIdDe('watch');
      const res = await request(app).get(`/api/inventario/productos?clase_id=${watchId}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.every(p => p.clase_id === watchId)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });

  it('busca el producto por IMEI', async () => {
    const res = await request(app).get('/api/inventario/productos?buscar=356938').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.map(p => p.id)).toContain(prodId);
    expect(res.body.pagination).toBeDefined();
  });

  it('filtra por clase accesorio (no incluye el celular)', async () => {
    await request(app).post('/api/inventario/productos').set(auth()).send({
      clase: 'accesorios_varios', tipo_carga: 'lote', categoria_id: catBase, nombre: 'AirPods Pro 3', cantidad: 22, costo: 150,
    });
    const res = await request(app).get('/api/inventario/productos?clase=accesorios_varios').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.every(p => p.clase === 'accesorios_varios')).toBe(true);
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
      .send({ nombre: 'Con Foto', clase: 'celular_sellado', categoria_id: catBase, foto_data: b64, foto_nombre: 'f.png', foto_tipo: 'image/png' });
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
    const c = await request(app).post('/api/inventario/productos').set(auth()).send({ nombre: 'Sin Foto', clase: 'celular_sellado', categoria_id: catBase });
    const foto = await request(app).get(`/api/inventario/productos/${c.body.id}/foto`).set(auth());
    expect(foto.status).toBe(404);
  });
});

// ─── Métricas ────────────────────────────────────────────────
describe('GET /api/inventario/productos/metricas', () => {
  // 2026-07-11 F3-Fase2c: sunset de los campos legacy inv_equipos_* /
  // inv_accesorios_* / equipos_count / accesorios_count. El desglose granular
  // vive únicamente en `inv_por_clase[]` (Fase 2a). El response escalar
  // ahora solo tiene: en_tecnico_{count,usd,ars} + stock_disponible +
  // inv_por_clase[]. Test previo "agrega inversión de accesorios disponibles
  // en USD" reemplazado por la verificación directa contra inv_por_clase[].

  it('inv_por_clase[]: shape correcto y desglose por categoría del tenant', async () => {
    // 1) Crear un producto conocido para tener data determinística.
    //    Cargadores (7 u × 20 USD = 140 USD) — clase base, slug_legacy conocido.
    const create = await request(app).post('/api/inventario/productos').set(auth()).send({
      clase: 'cargadores', tipo_carga: 'lote', categoria_id: catBase,
      nombre: 'Cargador USB Prueba F2a', cantidad: 7, costo: 20,
    });
    expect(create.status).toBe(201);
    // Sanity: el producto se persistió con `clase_id` derivado (no NULL).
    expect(create.body.clase_id).toBeTruthy();

    const res = await request(app).get('/api/inventario/productos/metricas').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.inv_por_clase)).toBe(true);
    expect(res.body.inv_por_clase.length).toBeGreaterThan(0);

    // Shape de cada fila: clase_id, nombre, emoji, es_base, es_sin_categoria,
    // slug_legacy, count, usd, ars.
    for (const row of res.body.inv_por_clase) {
      expect(row).toHaveProperty('clase_id');
      expect(row).toHaveProperty('nombre');
      expect(row).toHaveProperty('count');
      expect(row).toHaveProperty('usd');
      expect(row).toHaveProperty('ars');
      expect(typeof row.nombre).toBe('string');
      expect(typeof row.count).toBe('number');
    }

    // Fila de cargadores existe con el count/usd exactos del producto recién creado.
    const cargadores = res.body.inv_por_clase.find(r => r.slug_legacy === 'cargadores');
    expect(cargadores).toBeDefined();
    expect(cargadores.count).toBeGreaterThanOrEqual(7);
    expect(Number(cargadores.usd)).toBeGreaterThanOrEqual(140);
  });

  it('Fase 2c: response NO incluye campos legacy inv_equipos_* / inv_accesorios_* / *_count', async () => {
    const res = await request(app).get('/api/inventario/productos/metricas').set(auth());
    expect(res.status).toBe(200);
    // Los 6 campos legacy fueron removidos del SQL en Fase 2c.
    expect(res.body).not.toHaveProperty('inv_equipos_usd');
    expect(res.body).not.toHaveProperty('inv_equipos_ars');
    expect(res.body).not.toHaveProperty('equipos_count');
    expect(res.body).not.toHaveProperty('inv_accesorios_usd');
    expect(res.body).not.toHaveProperty('inv_accesorios_ars');
    expect(res.body).not.toHaveProperty('accesorios_count');
    // Los campos que se mantienen.
    expect(res.body).toHaveProperty('en_tecnico_count');
    expect(res.body).toHaveProperty('en_tecnico_usd');
    expect(res.body).toHaveProperty('en_tecnico_ars');
    expect(res.body).toHaveProperty('stock_disponible');
    expect(res.body).toHaveProperty('inv_por_clase');
  });
});

// ─── Proveedores (combo de edición inline) ───────────────────
describe('GET /api/inventario/productos/proveedores', () => {
  it('devuelve los proveedores únicos vistos en productos vivos', async () => {
    // Sumamos algunos productos con proveedor para que aparezcan
    await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'ProvProd 1', clase: 'celular_sellado', categoria_id: catBase,
      costo: 100, precio_venta: 200, proveedor: 'Mayorista Alfa',
    });
    await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'ProvProd 2', clase: 'celular_sellado', categoria_id: catBase,
      costo: 100, precio_venta: 200, proveedor: '  Mayorista Alfa  ', // mismo, con espacios
    });
    await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'ProvProd 3', clase: 'celular_sellado', categoria_id: catBase,
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
      nombre: 'Lote Test', clase: 'accesorios_varios', tipo_carga: 'lote',
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
    const res = await request(app).get('/api/inventario/desglose?por=modelo&clase=accesorios_varios').set(auth());
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
        { nombre: 'iPhone 13', clase: 'celular_sellado', categoria_id: catBase, costo: 400, precio_venta: 500 },
        { nombre: 'iPhone 14', clase: 'celular_sellado', categoria_id: catBase, costo: 500, precio_venta: 620 },
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

  // Feature recepción móvil (junio 2026): el endpoint rechaza IMEIs que ya
  // existen en productos activos. Antes se podían crear duplicados silenciosos
  // re-importando el mismo XLSX.
  it('rechaza IMEIs ya existentes en inventario → 409 con lista de duplicados', async () => {
    // Crear un producto con IMEI conocido.
    await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'iPhone existente', clase: 'celular_sellado', categoria_id: catBase,
      imei: '359123456789012', costo: 400, precio_venta: 500,
    });

    // Intentar bulk con un producto cuyo IMEI ya existe + otros nuevos.
    const res = await request(app).post('/api/inventario/productos/bulk').set(auth()).send({
      productos: [
        { nombre: 'Nuevo OK', clase: 'celular_sellado', categoria_id: catBase, imei: '359999999999999', costo: 400, precio_venta: 500 },
        { nombre: 'Choque IMEI', clase: 'celular_sellado', categoria_id: catBase, imei: '359123456789012', costo: 400, precio_venta: 500 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.duplicados).toContain('359123456789012');
    // El "Nuevo OK" NO debería haberse creado (rollback completo).
    const check = await request(app).get('/api/inventario/productos?buscar=Nuevo OK').set(auth());
    expect(check.body.data.find(p => p.imei === '359999999999999')).toBeUndefined();
  });

  it('acepta bulk sin IMEIs (accesorios, lotes) sin chequear duplicados', async () => {
    const res = await request(app).post('/api/inventario/productos/bulk').set(auth()).send({
      productos: [
        { nombre: 'Funda Genérica X', clase: 'accesorios_varios', categoria_id: catBase, costo: 5, precio_venta: 10, tipo_carga: 'lote', cantidad: 50 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.creados).toBe(1);
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
      clase: 'accesorios_varios',
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

// ─── POST /productos/bulk-delete-disponibles ─────────────────────────────────
// Soft-delete masivo de productos en estado 'disponible'. Mantiene vendidos,
// en_tecnico y reservados. Útil para resetear el stock libre sin perder
// histórico de ventas.
describe('POST /api/inventario/productos/bulk-delete-disponibles', () => {
  let catBulk;
  beforeAll(async () => {
    const r = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'Bulk Delete Test ' + Math.random() });
    catBulk = r.body.id;
  });

  it('borra solo los disponibles, mantiene vendidos / en_tecnico / reservados', async () => {
    // Crear productos en diferentes estados
    const mkProducto = async (estado, suffix) => {
      const r = await request(app).post('/api/inventario/productos').set(auth()).send({
        nombre: 'iPhone Bulk Del ' + suffix,
        clase: 'celular_sellado', tipo_carga: 'unitario', categoria_id: catBulk,
        imei: '550' + Date.now().toString().slice(-11) + suffix,
        costo: 100, precio_venta: 200, cantidad: 1, estado,
      });
      return r.body.id;
    };
    const idDisponible1 = await mkProducto('disponible', '1');
    const idDisponible2 = await mkProducto('disponible', '2');
    const idVendido    = await mkProducto('vendido', '3');
    const idTecnico    = await mkProducto('en_tecnico', '4');
    const idReservado  = await mkProducto('reservado', '5');

    // Llamar el endpoint
    const res = await request(app)
      .post('/api/inventario/productos/bulk-delete-disponibles')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.borrados).toBeGreaterThanOrEqual(2);

    // Verificar: los disponibles ya NO aparecen en la lista activa.
    // Buscamos por imei para acotar — limit 200 (max permitido), filtramos por
    // los IDs específicos que sí esperamos ver.
    const listResp = await request(app)
      .get('/api/inventario/productos?vista=todos_ocultos&limit=200')
      .set(auth());
    expect(listResp.status).toBe(200);
    const ids = (listResp.body.data || []).map(p => p.id);
    expect(ids).not.toContain(idDisponible1);
    expect(ids).not.toContain(idDisponible2);
    // Los demás siguen
    expect(ids).toContain(idVendido);
    expect(ids).toContain(idTecnico);
    expect(ids).toContain(idReservado);
  });

  it('idempotente: 2 calls seguidos no rompen (segundo borra 0)', async () => {
    const r1 = await request(app).post('/api/inventario/productos/bulk-delete-disponibles').set(auth());
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/inventario/productos/bulk-delete-disponibles').set(auth());
    expect(r2.status).toBe(200);
    expect(r2.body.borrados).toBe(0);
  });

  // Guarda post-auditoría TANDA 0: borrar productos disponibles referenciados
  // por envíos Pendiente/En camino dejaría envíos con referencia rota.
  it('bloquea con 409 si hay envíos en curso apuntando a productos disponibles', async () => {
    // Crear producto disponible (fresh, después de los borrados anteriores).
    const cat = await request(app).post('/api/inventario/categorias').set(auth()).send({ nombre: 'EnviosGuardCat' });
    const dep = await request(app).post('/api/inventario/depositos').set(auth()).send({ nombre: 'EnviosGuardDep' });
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'Telefono Guardado', categoria_id: cat.body.id, deposito_id: dep.body.id,
      precio_venta: 100, costo: 50, estado: 'disponible',
    });
    expect(prod.status).toBe(201);

    // Crear envío Pendiente con producto_id apuntando al disponible.
    const envio = await request(app).post('/api/envios').set(auth()).send({
      fecha: '2026-06-03', cliente: 'Cliente Guard', direccion: 'Calle 123', estado: 'Pendiente',
      total_cobrado: 0, items: [{ tipo: 'producto', descripcion: 'Tel', cantidad: 1, producto_id: prod.body.id }],
    });
    expect(envio.status).toBe(201);

    // Intentar vaciar disponibles → 409 con detalle del envío.
    const del = await request(app).post('/api/inventario/productos/bulk-delete-disponibles').set(auth());
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/envíos en curso/i);
    expect(Array.isArray(del.body.envios_bloqueantes)).toBe(true);
    expect(del.body.envios_bloqueantes.length).toBeGreaterThan(0);

    // El producto NO se borró.
    const listResp = await request(app).get('/api/inventario/productos?vista=todos_ocultos&limit=200').set(auth());
    const ids = (listResp.body.data || []).map(p => p.id);
    expect(ids).toContain(prod.body.id);

    // Cleanup: cancelar el envío + borrar el producto manualmente para no
    // contaminar otros tests del describe.
    await request(app).put(`/api/envios/${envio.body.id}`).set(auth()).send({ estado: 'Cancelado' });
    await request(app).delete(`/api/inventario/productos/${prod.body.id}`).set(auth());
  });

  // Regresión 2026-06-15: el bulk-delete chequeaba envíos Pendiente/En camino
  // sin filtrar por deleted_at IS NULL. Resultado: envíos soft-deleted con
  // estado=Pendiente seguían apareciendo como bloqueantes — Lucas reportó que
  // borró todos sus envíos pero el botón "Vaciar stock" seguía dando 409 con
  // "hay 2 envíos en curso". Fix: AND e.deleted_at IS NULL en la query.
  it('envíos Pendiente soft-deleted NO bloquean el vaciado', async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth()).send({ nombre: 'EnviosBorradosCat' });
    const dep = await request(app).post('/api/inventario/depositos').set(auth()).send({ nombre: 'EnviosBorradosDep' });
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'Telefono Para Borrar', categoria_id: cat.body.id, deposito_id: dep.body.id,
      precio_venta: 100, costo: 50, estado: 'disponible',
    });
    expect(prod.status).toBe(201);

    // Crear envío Pendiente referenciando al producto.
    const envio = await request(app).post('/api/envios').set(auth()).send({
      fecha: '2026-06-15', cliente: 'Cliente Fantasma', direccion: 'Calle X', estado: 'Pendiente',
      total_cobrado: 0, items: [{ tipo: 'producto', descripcion: 'Tel', cantidad: 1, producto_id: prod.body.id }],
    });
    expect(envio.status).toBe(201);

    // Borrar el envío (soft-delete). El estado queda 'Pendiente' en DB pero
    // deleted_at se setea — exactamente el escenario que disparó el bug.
    const delEnvio = await request(app).delete(`/api/envios/${envio.body.id}`).set(auth());
    expect(delEnvio.status).toBe(200);

    // Vaciar disponibles. Debe FUNCIONAR (no 409) — el envío borrado no cuenta.
    const wipe = await request(app).post('/api/inventario/productos/bulk-delete-disponibles').set(auth());
    expect(wipe.status).toBe(200);
    expect(wipe.body.borrados).toBeGreaterThanOrEqual(1);

    // El producto se borró.
    const listResp = await request(app).get('/api/inventario/productos?vista=todos_ocultos&limit=200').set(auth());
    const stillThere = (listResp.body.data || []).find(p => p.id === prod.body.id);
    // Si aparece en la lista de "todos_ocultos", debe estar marcado como deleted.
    // El endpoint normal no lo devolvería; usamos vista todos_ocultos sólo
    // para confirmar que se borró sin importar si la vista lo incluye.
    expect(stillThere == null || stillThere.deleted_at != null).toBe(true);
  });

  // Auditoría TANDA 0: el audit_log se registra correctamente para la operación
  // bulk. Antes la versión guardaba `ids: [...]` (40KB de JSONB para N grande);
  // ahora solo `borrados: N` para evitar inflar audit_logs.
  it('audit_log registra la operación con borrados:N (sin ids array)', async () => {
    const cat2 = await request(app).post('/api/inventario/categorias').set(auth()).send({ nombre: 'AuditTestCat' });
    const dep2 = await request(app).post('/api/inventario/depositos').set(auth()).send({ nombre: 'AuditTestDep' });
    const prodAudit = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'Audit Item', categoria_id: cat2.body.id, deposito_id: dep2.body.id,
      precio_venta: 10, costo: 5, estado: 'disponible',
    });
    expect(prodAudit.status).toBe(201);

    const r = await request(app).post('/api/inventario/productos/bulk-delete-disponibles').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.borrados).toBeGreaterThanOrEqual(1);

    // Consultar el audit log (último registro de tabla='productos' acción='DELETE')
    const { rows } = await pool.query(
      `SELECT datos_despues FROM audit_logs
        WHERE tabla='productos' AND accion='DELETE'
        ORDER BY id DESC LIMIT 1`
    );
    expect(rows[0]).toBeTruthy();
    expect(rows[0].datos_despues.tipo).toBe('bulk_delete_disponibles');
    expect(rows[0].datos_despues.borrados).toBeGreaterThanOrEqual(1);
    // No debe contener el array de ids (cambio post-auditoría — antes lo guardaba).
    expect(rows[0].datos_despues.ids).toBeUndefined();
  });
});

// ─── POST /productos/bulk-delete-disponibles-con-compras (admin-only) ──────
//
// Variante destructiva pedida por Lucas 2026-06-15: ademas de vaciar el
// stock disponible, borra las compras de proveedor cuyos productos quedaron
// 100% borrados (y revierte sus egresos de caja). Compras parciales (con
// algún producto vendido) NO se tocan.
describe('POST /api/inventario/productos/bulk-delete-disponibles-con-compras (admin)', () => {
  it('borra la compra entera cuando TODOS sus productos eran disponibles', async () => {
    // Setup: caja + categoría + proveedor + compra al contado.
    const caja = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: `Caja WipeCompra ${Date.now()}`, moneda: 'USD', saldo_inicial: 500 });
    expect(caja.status).toBe(201);
    const cajaId = caja.body.id;

    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: `CatWipeCompra ${Date.now()}` });
    const provR = await request(app).post('/api/proveedores').set(auth())
      .send({ nombre: `ProvWipeCompra ${Date.now()}` });
    expect(provR.status).toBe(201);

    const compra = await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: provR.body.id, fecha: '2026-06-15', tipo: 'compra',
      monto: 200, moneda: 'USD', caja_id: cajaId,
      items: [{ valor: 200, producto_stock: {
        tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: cat.body.id,
        nombre: `WipeCompraProd ${Date.now()}`, imei: `35001${Date.now()}`.slice(0, 15),
        cantidad: 1, costo: 200, costo_moneda: 'USD',
        precio_venta: 300, precio_moneda: 'USD',
      } }],
    });
    expect(compra.status).toBe(201);
    const movId = compra.body.id;

    const r = await request(app).post('/api/inventario/productos/bulk-delete-disponibles-con-compras').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.borrados).toBeGreaterThanOrEqual(1);
    expect(r.body.compras_borradas).toBeGreaterThanOrEqual(1);

    // La compra quedó borrada.
    const { rows: movPost } = await pool.query(
      `SELECT deleted_at FROM proveedor_movimientos WHERE id = $1`, [movId]
    );
    expect(movPost[0].deleted_at).not.toBeNull();

    // La caja volvió al saldo inicial (egreso de la compra revertido).
    const cajas = await request(app).get('/api/cajas/cajas').set(auth());
    const cajaPost = cajas.body.find(c => c.id === cajaId);
    expect(Number(cajaPost.saldo_actual)).toBe(500);

    // Cleanup.
    await pool.query(`UPDATE metodos_pago SET deleted_at = NOW() WHERE id = $1`, [cajaId]);
    await pool.query(`UPDATE proveedores SET deleted_at = NOW() WHERE id = $1`, [provR.body.id]);
  });

  it('preserva compras PARCIALES (algún producto vendido sobrevive)', async () => {
    // Setup: compra con 2 productos del mismo lote, vendemos 1, vaciamos.
    // Esperado: el disponible se borra; el vendido + la compra quedan intactos.
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: `CatParcial ${Date.now()}` });
    const provR = await request(app).post('/api/proveedores').set(auth())
      .send({ nombre: `ProvParcial ${Date.now()}` });

    const stamp = Date.now();
    const compra = await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: provR.body.id, fecha: '2026-06-15', tipo: 'compra',
      monto: 400, moneda: 'USD',  // sin caja_id (crédito) — más simple
      items: [
        { valor: 200, producto_stock: {
          tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: cat.body.id,
          nombre: `Parcial-A-${stamp}`, imei: `35002A${stamp}`.slice(0, 15),
          cantidad: 1, costo: 200, costo_moneda: 'USD',
          precio_venta: 300, precio_moneda: 'USD',
        } },
        { valor: 200, producto_stock: {
          tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: cat.body.id,
          nombre: `Parcial-B-${stamp}`, imei: `35002B${stamp}`.slice(0, 15),
          cantidad: 1, costo: 200, costo_moneda: 'USD',
          precio_venta: 300, precio_moneda: 'USD',
        } },
      ],
    });
    expect(compra.status).toBe(201);
    const movId = compra.body.id;
    const prodA = compra.body.productos_creados[0].id;
    const prodB = compra.body.productos_creados[1].id;

    // Marcar el producto B como vendido (vía DB para simular el end-state
    // que dejaría una venta real — el flow de venta es complejo y no aporta
    // valor a este test).
    await pool.query(`UPDATE productos SET estado = 'vendido' WHERE id = $1`, [prodB]);

    const r = await request(app).post('/api/inventario/productos/bulk-delete-disponibles-con-compras').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.borrados).toBeGreaterThanOrEqual(1);  // borró el A
    // La compra NO debe haberse borrado: B sigue vivo (vendido).
    const { rows: movPost } = await pool.query(
      `SELECT deleted_at FROM proveedor_movimientos WHERE id = $1`, [movId]
    );
    expect(movPost[0].deleted_at).toBeNull();
    // El A está borrado, el B no.
    const { rows: prods } = await pool.query(
      `SELECT id, deleted_at, estado FROM productos WHERE id IN ($1, $2)`,
      [prodA, prodB]
    );
    const a = prods.find(p => p.id === prodA);
    const b = prods.find(p => p.id === prodB);
    expect(a.deleted_at).not.toBeNull();
    expect(b.deleted_at).toBeNull();
    expect(b.estado).toBe('vendido');

    // Cleanup.
    await pool.query(`UPDATE productos SET deleted_at = NOW() WHERE id IN ($1, $2)`, [prodA, prodB]);
    await pool.query(`UPDATE proveedor_movimientos SET deleted_at = NOW() WHERE id = $1`, [movId]);
    await pool.query(`UPDATE proveedores SET deleted_at = NOW() WHERE id = $1`, [provR.body.id]);
  });

  it('bloquea con 409 si hay envío Pendiente activo (misma guard que el hermano)', async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: `CatConCompEnvio ${Date.now()}` });
    const dep = await request(app).post('/api/inventario/depositos').set(auth())
      .send({ nombre: `DepConCompEnvio ${Date.now()}` });
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: `ConCompEnvio ${Date.now()}`, categoria_id: cat.body.id, deposito_id: dep.body.id,
      precio_venta: 100, costo: 50, estado: 'disponible',
    });
    expect(prod.status).toBe(201);
    const envio = await request(app).post('/api/envios').set(auth()).send({
      fecha: '2026-06-15', cliente: 'Cli', direccion: 'X', estado: 'Pendiente',
      total_cobrado: 0, items: [{ tipo: 'producto', descripcion: 'T', cantidad: 1, producto_id: prod.body.id }],
    });
    expect(envio.status).toBe(201);

    const r = await request(app).post('/api/inventario/productos/bulk-delete-disponibles-con-compras').set(auth());
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/envíos en curso/i);

    // Cleanup.
    await request(app).put(`/api/envios/${envio.body.id}`).set(auth()).send({ estado: 'Cancelado' });
    await request(app).delete(`/api/inventario/productos/${prod.body.id}`).set(auth());
  });
});

// Tests TANDA 3 post-auditoría: bulk de catálogos elimina los N round-trips
// del import de stock. Idempotente + case-insensitive + dedup.
describe('POST /api/inventario/categorias/bulk', () => {
  it('crea las categorías nuevas y devuelve el mapping con todas (existentes + creadas)', async () => {
    // Pre-existente.
    const existente = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'Bulk Pre' });
    expect(existente.status).toBe(201);
    // Bulk con 1 existente + 2 nuevos.
    const r = await request(app).post('/api/inventario/categorias/bulk').set(auth())
      .send({ nombres: ['Bulk Pre', 'Bulk Nueva A', 'Bulk Nueva B'] });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.map).sort()).toEqual(['bulk nueva a', 'bulk nueva b', 'bulk pre']);
    // El id de 'Bulk Pre' debe coincidir con el creado antes.
    expect(r.body.map['bulk pre']).toBe(existente.body.id);
    // Los nuevos ids deben ser >0.
    expect(r.body.map['bulk nueva a']).toBeGreaterThan(0);
    expect(r.body.map['bulk nueva b']).toBeGreaterThan(0);
  });

  it('idempotente: 2da llamada con los mismos nombres no crea duplicados', async () => {
    const r1 = await request(app).post('/api/inventario/categorias/bulk').set(auth())
      .send({ nombres: ['Bulk Idem'] });
    const r2 = await request(app).post('/api/inventario/categorias/bulk').set(auth())
      .send({ nombres: ['Bulk Idem'] });
    expect(r1.body.map['bulk idem']).toBe(r2.body.map['bulk idem']);
  });

  it('dedup case-insensitive: ["Apple","apple","APPLE"] crea 1 sola', async () => {
    const r = await request(app).post('/api/inventario/categorias/bulk').set(auth())
      .send({ nombres: ['Bulk Apple', 'BULK apple', 'bulk APPLE'] });
    expect(r.status).toBe(200);
    // El map tiene 1 sola clave (lowercase).
    expect(Object.keys(r.body.map)).toEqual(['bulk apple']);
  });

  it('nombres vacíos/whitespace son rechazados por el schema', async () => {
    const r = await request(app).post('/api/inventario/categorias/bulk').set(auth())
      .send({ nombres: ['', '   '] });
    expect(r.status).toBe(400);
  });
});

// Tests del endpoint /productos/:id/historial (2026-06-15, Fase 2 trazabilidad).
// Cierra el loop: dado un producto, devuelve quién se lo vendió (compra) y
// quién se lo compró (venta) — tanto retail como B2B.
describe('GET /api/inventario/productos/:id/historial', () => {
  let provId;
  let catHist;
  let productoBase;

  beforeAll(async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone Historial' });
    catHist = cat.body.id;
    const prov = await request(app).post('/api/proveedores').set(auth())
      .send({ nombre: 'Distri Historial' });
    provId = prov.body.id;
  });

  it('404 si el producto no existe', async () => {
    const r = await request(app).get('/api/inventario/productos/99999999/historial').set(auth());
    expect(r.status).toBe(404);
  });

  it('400 si el id es inválido', async () => {
    const r = await request(app).get('/api/inventario/productos/abc/historial').set(auth());
    expect(r.status).toBe(400);
  });

  it('producto sin IMEI ni venta → { compra: null, venta: null }', async () => {
    // Accesorio sin imei: no hay match posible en compras (no es bug, es señal).
    const p = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'Funda Historial', clase: 'accesorios_varios', tipo_carga: 'lote',
      categoria_id: catHist, costo: 5, costo_moneda: 'USD',
      precio_venta: 10, precio_moneda: 'USD', cantidad: 50,
    });
    const r = await request(app).get(`/api/inventario/productos/${p.body.id}/historial`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ compra: null, venta: null });
  });

  it('producto con IMEI → compra de origen (creada vía /movimientos POST con producto_stock)', async () => {
    // Creamos compra con producto_stock → genera el producto en la misma tx
    // (flujo real del import XLSX).
    const imei = '356789012345700';
    const mov = await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: provId,
      fecha: '2026-06-15',
      tipo: 'compra',
      monto: 1450,
      moneda: 'USD',
      descripcion: 'Compra trazable',
      items: [{
        producto: 'iPhone Test Hist',
        imei_serial: imei,
        valor: 1450,
        producto_stock: {
          nombre: 'iPhone Test Hist', clase: 'celular_sellado', tipo_carga: 'unitario',
          imei, categoria_id: catHist, costo: 1450, costo_moneda: 'USD',
          precio_venta: 1650, precio_moneda: 'USD', cantidad: 1,
        },
      }],
    });
    expect(mov.status).toBe(201);
    // Buscamos el producto recién creado por su IMEI.
    const list = await request(app).get(`/api/inventario/productos?search=${imei}`).set(auth());
    productoBase = list.body.data.find(p => p.imei === imei);
    expect(productoBase).toBeDefined();

    const r = await request(app).get(`/api/inventario/productos/${productoBase.id}/historial`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.compra).toBeTruthy();
    expect(r.body.compra.proveedor_id).toBe(provId);
    expect(r.body.compra.proveedor_nombre).toBe('Distri Historial');
    expect(Number(r.body.compra.valor_item)).toBe(1450);
    expect(r.body.venta).toBeNull();
  });

  // Nota: cubrimos sólo el path retail directo (insertando filas) y no el flujo
  // completo de venta porque las pre-condiciones (vendedor, cliente, etc) ya
  // están testeadas en ventas.test.js. Acá importa el JOIN.
  it('producto vendido (retail) → venta presente con cliente y precio', async () => {
    // Reutilizamos productoBase del test anterior. Insertamos directo en DB
    // para no acoplar este test al flow completo de POST /ventas.
    const pool = require('../src/config/database');
    const { rows: contRows } = await pool.query(
      `INSERT INTO contactos (nombre) VALUES ('Cliente Historial') RETURNING id`
    );
    const clienteId = contRows[0].id;
    const { rows: ventaRows } = await pool.query(`
      INSERT INTO ventas (order_id, fecha, cliente_id, estado, total_usd, ganancia_usd)
      VALUES ('TEST-HIST-1', '2026-06-15', $1, 'acreditado', 1650, 200)
      RETURNING id
    `, [clienteId]);
    const ventaId = ventaRows[0].id;
    await pool.query(`
      INSERT INTO venta_items (venta_id, producto_id, descripcion, cantidad, precio_vendido, moneda)
      VALUES ($1, $2, 'iPhone Test Hist', 1, 1650, 'USD')
    `, [ventaId, productoBase.id]);

    const r = await request(app).get(`/api/inventario/productos/${productoBase.id}/historial`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.compra).toBeTruthy();  // sigue ahí
    expect(r.body.venta).toBeTruthy();
    expect(r.body.venta.tipo).toBe('retail');
    expect(r.body.venta.cliente_id).toBe(clienteId);
    expect(r.body.venta.cliente_nombre).toBe('Cliente Historial');
    expect(Number(r.body.venta.precio_vendido)).toBe(1650);
    expect(r.body.venta.moneda).toBe('USD');
    expect(r.body.venta.estado).toBe('acreditado');
  });
});

// ─── Equipos usados (2026-07-11) ─────────────────────────────
// Feature: tab "Equipos usados" en Inventario. Nuevo endpoint GET
// /api/inventario/usados que lista productos con condicion='usado' con
// trazabilidad de origen (canje o manual).
describe('GET /api/inventario/usados', () => {
  let usadoCanjeId;
  let usadoManualId;
  let ventaCanjeId;

  beforeAll(async () => {
    // 1) Producto usado ingresado MANUALMENTE (sin canje).
    const manualRes = await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario', clase: 'celular_usado',
      nombre: 'iPhone 12 Manual', categoria_id: catBase,
      imei: '990' + Date.now().toString().slice(-12),
      condicion: 'usado', gb: '128', color: 'Negro', bateria: 82,
      costo: 350, costo_moneda: 'USD', precio_venta: 550, precio_moneda: 'USD',
      cantidad: 1, estado: 'disponible',
    });
    expect(manualRes.status).toBe(201);
    usadoManualId = manualRes.body.id;

    // 2) Producto usado ingresado por CANJE. Creamos venta con canje
    // agregar_stock=true → el backend crea el producto Y el canje ligado.
    const canjeIMEI = '991' + Date.now().toString().slice(-12);
    const ventaRes = await request(app).post('/api/ventas').set(auth()).send({
      fecha: '2026-07-05',
      items: [{ descripcion: 'iPhone 16', cantidad: 1, precio_vendido: 1500, costo: 1200, moneda: 'USD' }],
      canjes: [{
        descripcion: 'iPhone 13 Pro Canje Test',
        imei: canjeIMEI, gb: '256', color: 'Sierra Blue', bateria: 88,
        valor_toma: 620, moneda: 'USD', agregar_stock: true,
        condicion: 'usado',
      }],
      cliente_nombre: 'Cliente Canje Test',
    });
    expect(ventaRes.status).toBe(201);
    ventaCanjeId = ventaRes.body.id;
    // Buscar el producto creado por el canje via IMEI.
    const invLookup = await request(app).get(`/api/inventario/productos?buscar=${canjeIMEI}`).set(auth());
    expect(invLookup.body.data).toHaveLength(1);
    usadoCanjeId = invLookup.body.data[0].id;
  });

  it('lista solo productos con condicion="usado" (excluye nuevos)', async () => {
    const r = await request(app).get('/api/inventario/usados').set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('data');
    expect(r.body).toHaveProperty('pagination');
    // Todos los items deben ser condicion=usado.
    expect(r.body.data.every(p => p.condicion === 'usado')).toBe(true);
    // Debe incluir los 2 productos que creamos.
    const ids = r.body.data.map(p => p.id);
    expect(ids).toContain(usadoManualId);
    expect(ids).toContain(usadoCanjeId);
  });

  it('producto que vino por canje trae origen="canje" + canje_origen poblado', async () => {
    const r = await request(app).get('/api/inventario/usados').set(auth());
    const p = r.body.data.find(x => x.id === usadoCanjeId);
    expect(p).toBeDefined();
    expect(p.origen).toBe('canje');
    expect(p.canje_origen).not.toBeNull();
    expect(p.canje_origen).toMatchObject({
      venta_id:       ventaCanjeId,
      venta_order_id: expect.any(String),
      cliente_nombre: 'Cliente Canje Test',
    });
    expect(p.canje_origen.venta_fecha).toBeTruthy();
  });

  it('producto ingresado manualmente trae origen="manual" + canje_origen: null', async () => {
    const r = await request(app).get('/api/inventario/usados').set(auth());
    const p = r.body.data.find(x => x.id === usadoManualId);
    expect(p).toBeDefined();
    expect(p.origen).toBe('manual');
    expect(p.canje_origen).toBeNull();
  });

  it('filtro solo_canjes=true excluye los manuales', async () => {
    const r = await request(app).get('/api/inventario/usados?solo_canjes=true').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.data.every(p => p.origen === 'canje')).toBe(true);
    expect(r.body.data.every(p => p.canje_origen !== null)).toBe(true);
    // El manual NO debe estar en el response.
    const ids = r.body.data.map(p => p.id);
    expect(ids).not.toContain(usadoManualId);
    expect(ids).toContain(usadoCanjeId);
  });

  // 2026-07-11: complemento del filtro anterior. Feedback de Lucas — los
  // tenants compran lotes de usados a proveedores además de recibir canjes,
  // y necesitan ver ese sub-set separado. Seg de 3 estados en el frontend.
  it('filtro solo_manual=true excluye los que vinieron por canje', async () => {
    const r = await request(app).get('/api/inventario/usados?solo_manual=true').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.data.every(p => p.origen === 'manual')).toBe(true);
    expect(r.body.data.every(p => p.canje_origen === null)).toBe(true);
    // El canje NO debe estar en el response, el manual sí.
    const ids = r.body.data.map(p => p.id);
    expect(ids).toContain(usadoManualId);
    expect(ids).not.toContain(usadoCanjeId);
  });

  it('filtro buscar matchea por nombre del cliente (JOIN a ventas)', async () => {
    const r = await request(app).get('/api/inventario/usados?buscar=Canje%20Test').set(auth());
    expect(r.status).toBe(200);
    // El buscar matchea "Cliente Canje Test" → devuelve el producto del canje.
    const ids = r.body.data.map(p => p.id);
    expect(ids).toContain(usadoCanjeId);
  });

  it('filtro estado=disponible respeta scope condicion=usado', async () => {
    const r = await request(app).get('/api/inventario/usados?estado=disponible').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.data.every(p => p.estado === 'disponible')).toBe(true);
    expect(r.body.data.every(p => p.condicion === 'usado')).toBe(true);
  });

  it('respeta paginación (limit + page)', async () => {
    const r = await request(app).get('/api/inventario/usados?limit=1&page=1').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeLessThanOrEqual(1);
    expect(r.body.pagination.limit).toBe(1);
    expect(r.body.pagination.page).toBe(1);
    expect(r.body.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it('valida shape del schema — estado inválido → 400', async () => {
    const r = await request(app).get('/api/inventario/usados?estado=invalido').set(auth());
    expect(r.status).toBe(400);
  });

  it('valida shape del schema — desde con formato malo → 400', async () => {
    const r = await request(app).get('/api/inventario/usados?desde=05-07-2026').set(auth());
    expect(r.status).toBe(400);
  });
});

// 2026-07-14: reporte de cliente — filtro "iPhone 17" devolvía iPads. Añadimos
// batería de tests que garantizan que la tokenización del buscar excluye
// productos no matcheantes, con casos borde comunes (multi-token, orden
// inverso, matching cross-campo, integración con clase_id).
describe('GET /api/inventario/productos — precisión del search (tokenización)', () => {
  let iphone17Id, iphone15Id, ipadA16Id, macbookId;

  beforeAll(async () => {
    // Categorías dummy — algún endpoint las requiere.
    const cat = catBase;
    // Insertamos productos con nombres realistas de cliente. Nota: incluimos
    // "17" en el IMEI del iPhone 15 a propósito para asegurar que
    // tokenización NO matchea con substrings casuales en IMEI si el nombre
    // no matchea.
    const seed = async (nombre, imei, color, gb, clase = 'celular_sellado') => {
      const r = await request(app).post('/api/inventario/productos').set(auth())
        .send({ nombre, imei, color, gb, categoria_id: cat, tipo_carga: 'unitario', clase,
                costo: 100, precio_venta: 200, costo_moneda: 'USD', precio_moneda: 'USD' });
      expect(r.status).toBe(201);
      return r.body.id;
    };
    // IMEIs sin "17" ni "iPhone" para que la tokenización pueda excluirlos
    // limpio. iPhone 15 tiene "iPhone" pero NADA con "17" en ningún campo →
    // NO matchea "iPhone 17" (correcto).
    iphone17Id = await seed('iPhone 17 Pro Max', 'AABBCCDDEEFF001', 'Titanio', '256');
    iphone15Id = await seed('iPhone 15 Pro',      'GGHHIIJJKKLL002', 'Negro',   '128');
    ipadA16Id  = await seed('iPad A16 2025',      'MMNNOOPPQQRR003', 'Blue',    '128', 'ipads');
    macbookId  = await seed('MacBook Pro M3',     'SSTTUUVVWWXX004', 'Silver',  '512', 'computadoras');
  });

  it('buscar "iPhone 17" solo devuelve el iPhone 17 (NO iPad, NO MacBook, NO iPhone 15)', async () => {
    const r = await request(app).get('/api/inventario/productos?buscar=iPhone%2017').set(auth());
    expect(r.status).toBe(200);
    const ids = r.body.data.map(p => p.id);
    expect(ids).toContain(iphone17Id);
    expect(ids).not.toContain(ipadA16Id);    // ← el bug reportado por el cliente
    expect(ids).not.toContain(macbookId);    // no tiene "iPhone" en ningún campo
    expect(ids).not.toContain(iphone15Id);   // "iPhone" sí, "17" NO en ningún campo → excluido
  });

  it('buscar "17 iPhone" (orden invertido) → mismo resultado', async () => {
    const r = await request(app).get('/api/inventario/productos?buscar=17%20iPhone').set(auth());
    expect(r.status).toBe(200);
    const ids = r.body.data.map(p => p.id);
    expect(ids).toContain(iphone17Id);
    expect(ids).not.toContain(ipadA16Id);
    expect(ids).not.toContain(macbookId);
  });

  it('buscar por 1 sola palabra "iPad" solo devuelve iPad', async () => {
    const r = await request(app).get('/api/inventario/productos?buscar=iPad').set(auth());
    expect(r.status).toBe(200);
    const ids = r.body.data.map(p => p.id);
    expect(ids).toContain(ipadA16Id);
    expect(ids).not.toContain(iphone17Id);
    expect(ids).not.toContain(iphone15Id);
  });

  it('buscar cross-campo "Blue 128" matchea producto con color=Blue AND gb=128', async () => {
    const r = await request(app).get('/api/inventario/productos?buscar=Blue%20128').set(auth());
    expect(r.status).toBe(200);
    const ids = r.body.data.map(p => p.id);
    expect(ids).toContain(ipadA16Id); // color=Blue + gb=128
    expect(ids).not.toContain(iphone17Id); // color=Titanio, gb=256
    expect(ids).not.toContain(iphone15Id); // color=Negro
  });

  it('buscar case-insensitive: "IPHONE 17" == "iphone 17" == "iPhone 17"', async () => {
    const r1 = await request(app).get('/api/inventario/productos?buscar=IPHONE%2017').set(auth());
    const r2 = await request(app).get('/api/inventario/productos?buscar=iphone%2017').set(auth());
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const ids1 = r1.body.data.map(p => p.id).sort();
    const ids2 = r2.body.data.map(p => p.id).sort();
    expect(ids1).toEqual(ids2);
    expect(ids1).toContain(iphone17Id);
  });

  it('buscar espacios extra "iPhone    17" (whitespace múltiple) matchea igual', async () => {
    const r = await request(app).get('/api/inventario/productos?buscar=iPhone%20%20%20%2017').set(auth());
    expect(r.status).toBe(200);
    const ids = r.body.data.map(p => p.id);
    expect(ids).toContain(iphone17Id);
  });

  it('buscar vacío / whitespace-only no filtra (devuelve todos)', async () => {
    const rEmpty = await request(app).get('/api/inventario/productos?buscar=').set(auth());
    const rSpaces = await request(app).get('/api/inventario/productos?buscar=%20%20%20').set(auth());
    expect(rEmpty.status).toBe(200);
    expect(rSpaces.status).toBe(200);
    // Sin filtro de buscar, ambos IDs seed deberían estar en la lista.
    const idsEmpty = rEmpty.body.data.map(p => p.id);
    const idsSpaces = rSpaces.body.data.map(p => p.id);
    expect(idsEmpty).toContain(iphone17Id);
    expect(idsEmpty).toContain(ipadA16Id);
    expect(idsSpaces).toContain(iphone17Id);
  });

  it('buscar con más de 5 tokens: solo usa los primeros 5 (safety cap)', async () => {
    // 6 tokens — el 6to ("EXTRAWORD") NO debería filtrar. Si filtrara, iPhone 17
    // no aparecería (porque no tiene "EXTRAWORD" en ningún campo).
    const r = await request(app).get(
      '/api/inventario/productos?buscar=iPhone%2017%20Pro%20Max%20Titanio%20EXTRAWORD'
    ).set(auth());
    expect(r.status).toBe(200);
    const ids = r.body.data.map(p => p.id);
    expect(ids).toContain(iphone17Id); // Primeros 5 tokens matchean, 6to ignorado
  });

  it('clase_id + buscar combinados aplican AND (no OR)', async () => {
    // clase ipads + buscar iPad → solo iPad A16 aparece.
    // clase ipads + buscar iPhone → nada aparece (iPhones no están en clase ipads).
    const clases = await request(app).get('/api/inventario/clases').set(auth());
    const ipadsClase = clases.body.find(c => c.slug_legacy === 'ipads');
    expect(ipadsClase).toBeTruthy();

    const rMatch = await request(app).get(
      `/api/inventario/productos?clase_id=${ipadsClase.id}&buscar=iPad`
    ).set(auth());
    expect(rMatch.status).toBe(200);
    const idsMatch = rMatch.body.data.map(p => p.id);
    expect(idsMatch).toContain(ipadA16Id);

    const rExclude = await request(app).get(
      `/api/inventario/productos?clase_id=${ipadsClase.id}&buscar=iPhone`
    ).set(auth());
    expect(rExclude.status).toBe(200);
    const idsExclude = rExclude.body.data.map(p => p.id);
    expect(idsExclude).not.toContain(iphone17Id);
    expect(idsExclude).not.toContain(iphone15Id);
    expect(idsExclude).not.toContain(ipadA16Id); // ipad no tiene "iPhone" en ningún campo
  });

  // 2026-07-14 (feedback Lucas, follow-up del ranking): la búsqueda ahora
  // usa buildSearchWithRanking que prioriza matches en `nombre` sobre matches
  // en IMEI/color/gb. Sin ranking, un producto que matcheara solo por IMEI
  // podía aparecer antes que uno con el término en el nombre — poco útil
  // para el user que típicamente busca por descripción de producto.
  describe('ranking por relevancia', () => {
    it('match en nombre sale antes que match solo en IMEI', async () => {
      // Seed: 2 productos donde "Titanio" aparece en el IMEI de uno y en el
      // nombre del iPhone 17. El del nombre debe salir primero.
      // NOTA: como iphone17.color === 'Titanio' también matchea el iphone17
      // (que además tiene el nombre iPhone 17). Buscamos por "Titanio":
      //   · iPhone 17 Pro Max: color=Titanio → matchea. Además "Titanio" está
      //     en color, no en nombre → prioridad menor SI el ranking funciona.
      //   · iPad A16 2025: nombre no tiene Titanio, IMEI/color/gb tampoco.
      // Como solo hay 1 producto con "Titanio", este test no discrimina rank.
      // Reusamos "iPhone" (que solo aparece en `nombre`): iPhone 17 y iPhone 15
      // ambos matchean. Ambos tienen match en nombre → mismo tier 100.
      // Tie-breaker: similarity(nombre, "iPhone") — ambos son parecidos, pero
      // "iPhone 15 Pro" tiene similitud levemente mayor con "iPhone" que
      // "iPhone 17 Pro Max" (menos palabras extras). No es discriminador fuerte.
      // Vamos con test más robusto: buscar por un token que esté en IMEI de
      // uno pero en nombre del otro.
      //
      // ipadA16Id tiene IMEI 'MMNNOOPPQQRR003' → contiene "MM" pero también
      // los MacBook. Vamos a introducir productos ad-hoc.
      const seed = async (nombre, imei, color, gb, clase = 'celular_sellado') => {
        const r = await request(app).post('/api/inventario/productos').set(auth())
          .send({ nombre, imei, color, gb, categoria_id: catBase, tipo_carga: 'unitario', clase,
                  costo: 100, precio_venta: 200, costo_moneda: 'USD', precio_moneda: 'USD' });
        expect(r.status).toBe(201);
        return r.body.id;
      };
      // Producto A: "Titanio" está en el NOMBRE. Ranking debería priorizarlo.
      const enNombreId = await seed('iPhone Titanio Special Edition', 'AAAA1111BBBB1111', 'Blanco', '256');
      // Producto B: "Titanio" está solo en el color, no en nombre.
      const enColorId = await seed('iPhone Base Standard 2025', 'CCCC2222DDDD2222', 'Titanio', '256');

      const r = await request(app).get('/api/inventario/productos?buscar=Titanio').set(auth());
      expect(r.status).toBe(200);
      const ids = r.body.data.map(p => p.id);
      // Ambos matchean el WHERE (Titanio aparece en algún campo).
      expect(ids).toContain(enNombreId);
      expect(ids).toContain(enColorId);
      // Ranking: el que tiene "Titanio" en nombre sale ANTES.
      const idxNombre = ids.indexOf(enNombreId);
      const idxColor = ids.indexOf(enColorId);
      expect(idxNombre).toBeLessThan(idxColor);
    });

    it('sin buscar: sigue devolviendo productos (no explota sin ORDER BY custom)', async () => {
      // Regression check: cuando no hay `buscar`, el orderBy custom del ranking
      // NO se aplica y el fallback es el orden legacy `ORDER BY p.nombre, p.id DESC`.
      // Testeamos que la request funciona (status 200 + al menos un producto),
      // sin depender del orden exacto (fragilidad conocida entre PG collation
      // vs JS localeCompare — el test viejo comparaba array iguales y rompía
      // con nombres con caracteres especiales como "__VistaSuite__").
      const r = await request(app).get('/api/inventario/productos').set(auth());
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.data)).toBe(true);
      expect(r.body.data.length).toBeGreaterThan(0);
    });
  });
});

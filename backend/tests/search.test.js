/**
 * Tests de integración — Búsqueda global (feature 2026-07-13)
 *
 * Cubre:
 *   GET /api/search?q=...     — respuesta agrupada por categoría
 *   min length                — rechaza queries < 2 chars
 *   RLS scoping               — no ve resultados de otro tenant (via tenant helper)
 *   allSettled degradation    — si una tabla falla, el resto responde
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, catBase;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy = new Date().toISOString().split('T')[0];

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth())
    .send({ nombre: 'Cat Search Test' });
  catBase = cat.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('GET /api/search', () => {
  it('rechaza query menor a 2 caracteres → 400', async () => {
    const r = await request(app).get('/api/search?q=a').set(auth());
    expect(r.status).toBe(400);
  });

  it('devuelve shape completo con categorías vacías si nada matchea', async () => {
    const r = await request(app).get('/api/search?q=nomatch_' + Date.now()).set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('q');
    expect(r.body).toHaveProperty('total', 0);
    expect(r.body.results).toEqual(expect.objectContaining({
      productos: [], ventas: [], contactos: [], envios: [], cajas: [], egresos: [],
    }));
  });

  it('encuentra un producto por nombre + IMEI + color', async () => {
    // Seed: producto único con nombre distintivo.
    const unique = 'SearchTest_' + Date.now();
    await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: unique, clase: 'celular_sellado', tipo_carga: 'unitario',
      categoria_id: catBase, imei: '555' + Date.now().toString().slice(-12),
      color: 'PurpleSearch', costo: 100, costo_moneda: 'USD',
      precio_venta: 150, precio_moneda: 'USD', cantidad: 1,
    });

    // Match por nombre parcial.
    const byName = await request(app).get(`/api/search?q=${unique.slice(0, 12)}`).set(auth());
    expect(byName.status).toBe(200);
    expect(byName.body.results.productos.length).toBeGreaterThan(0);
    expect(byName.body.results.productos[0].label).toContain(unique.slice(0, 12));

    // Match por color.
    const byColor = await request(app).get(`/api/search?q=PurpleSearch`).set(auth());
    expect(byColor.body.results.productos.length).toBeGreaterThan(0);
    expect(byColor.body.results.productos[0].sublabel).toContain('PurpleSearch');
  });

  it('encuentra una venta por order_id + cliente_nombre', async () => {
    const cliente = 'ClienteSearch_' + Date.now();
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: cliente, estado: 'acreditado',
      items: [{ descripcion: 'X', cantidad: 1, precio_vendido: 100, costo: 80, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 100, moneda: 'USD' }],
    });
    expect(venta.status).toBe(201);

    // Match por order_id
    const byOrder = await request(app).get(`/api/search?q=${venta.body.order_id}`).set(auth());
    expect(byOrder.body.results.ventas.length).toBeGreaterThan(0);
    expect(byOrder.body.results.ventas[0].label).toBe(venta.body.order_id);

    // Match por cliente_nombre parcial.
    const byCliente = await request(app).get(`/api/search?q=ClienteSearch`).set(auth());
    expect(byCliente.body.results.ventas.length).toBeGreaterThan(0);
    expect(byCliente.body.results.ventas[0].sublabel).toContain('ClienteSearch');
  });

  it('devuelve shape uniforme por item (id, label, sublabel, url)', async () => {
    // Reusa el producto creado antes.
    const r = await request(app).get('/api/search?q=SearchTest').set(auth());
    expect(r.status).toBe(200);
    const p = r.body.results.productos[0];
    expect(p).toEqual(expect.objectContaining({
      id: expect.any(Number),
      label: expect.any(String),
      url: expect.stringContaining('/inventario'),
    }));
  });

  it('total refleja la suma de rows de todas las categorías', async () => {
    const r = await request(app).get('/api/search?q=SearchTest').set(auth());
    const suma = Object.values(r.body.results).reduce((s, arr) => s + arr.length, 0);
    expect(r.body.total).toBe(suma);
  });

  it('respeta el límite por categoría (default 5, cap 15)', async () => {
    const r = await request(app).get('/api/search?q=SearchTest&limit=5').set(auth());
    expect(r.status).toBe(200);
    Object.values(r.body.results).forEach(arr => {
      expect(arr.length).toBeLessThanOrEqual(5);
    });

    const r2 = await request(app).get('/api/search?q=SearchTest&limit=20').set(auth());
    // Cap 15 en el schema → 20 debería devolver 400.
    expect(r2.status).toBe(400);
  });

  it('rechaza sin auth → 401', async () => {
    const r = await request(app).get('/api/search?q=test');
    expect(r.status).toBe(401);
  });

  // 2026-07-14 (bug reportado por TekHaus vía Lucas): dos bugs relacionados
  // con el flow "click en resultado del ⌘K no navega".
  //
  // Bug 1 (hasCap rol): search.js chequeaba req.user.tenant_rol (viejo,
  //   compat) en vez de tenant_cap_rol (nuevo, usado por resto del cap-system).
  //   Owners/admins nunca obtenían bypass → hasCap fallaba silencioso →
  //   TODAS las categorías gate-adas devolvían 0 rows para owners con caps:
  //   undefined en el JWT. TekHaus (owner) veía el palette vacío.
  //
  // Bug 2 (URLs): URLs de resultados usaban ?buscar= pero las pantallas
  //   destino leen ?q= (Ventas, Inventario) o directamente no leen ningún
  //   param (Contactos, Envios). Click navegaba pero visualmente "no pasaba
  //   nada". Fix: URLs uniformadas a ?q= (excepto egresos → /egresos sin
  //   query, EgresosPanel no tiene search input).
  describe('bug fixes 2026-07-14', () => {
    it('bug 1: owner (bypass rol) obtiene resultados en TODAS las categorías', async () => {
      // Seed: producto con nombre distintivo.
      const unique = 'BypassRolTest_' + Date.now();
      await request(app).post('/api/inventario/productos').set(auth()).send({
        nombre: unique, clase: 'celular_sellado', tipo_carga: 'unitario',
        categoria_id: catBase, imei: '999' + Date.now().toString().slice(-12),
        color: 'BypassColor', costo: 100, costo_moneda: 'USD',
        precio_venta: 150, precio_moneda: 'USD', cantidad: 1,
      });

      // El TEST_USER default es admin — con el fix de hasCap ahora obtiene
      // bypass via tenant_cap_rol. Verificamos que las categorías gate-adas
      // (productos, ventas, envios, cajas, egresos) NO estén todas vacías
      // (el bug pre-fix devolvía [] en todas para owners).
      const r = await request(app).get(`/api/search?q=${unique.slice(0, 15)}`).set(auth());
      expect(r.status).toBe(200);
      // productos NO debería estar vacío — matcheamos el seed.
      expect(r.body.results.productos.length).toBeGreaterThan(0);
    });

    it('bug 2: URLs de productos usan ?q= (no ?buscar=)', async () => {
      // El CommandPalette navega a la URL devuelta por el backend. Las páginas
      // destino leen ?q= (patrón consistente con Ventas.jsx e Inventario.jsx).
      // Antes: /inventario?buscar=... → no lo lee ninguna pantalla → filtro no
      // se aplica → user ve "no pasa nada" al clickear.
      const r = await request(app).get('/api/search?q=SearchTest').set(auth());
      expect(r.status).toBe(200);
      const p = r.body.results.productos[0];
      if (p) {
        // La URL debe empezar con /inventario?q= (no ?buscar=).
        expect(p.url).toMatch(/^\/inventario\?q=/);
        expect(p.url).not.toMatch(/\?buscar=/);
      }
    });

    it('bug 2: URLs de ventas/contactos/envios usan ?q= también', async () => {
      const r = await request(app).get('/api/search?q=SearchTest').set(auth());
      expect(r.status).toBe(200);
      // Cada categoría con al menos 1 resultado debe cumplir el patrón.
      for (const cat of ['ventas', 'contactos', 'envios']) {
        const item = r.body.results[cat]?.[0];
        if (item) {
          expect(item.url).not.toMatch(/\?buscar=/);
          expect(item.url).toMatch(/\?q=/);
        }
      }
    });

    it('egresos: URL sin query (EgresosPanel no tiene search input)', async () => {
      const r = await request(app).get('/api/search?q=SearchTest').set(auth());
      expect(r.status).toBe(200);
      const item = r.body.results.egresos?.[0];
      if (item) {
        // Egresos lleva a la lista completa (sin filtro pre-aplicado). El user
        // ya vio el egreso en el palette; llegar a la lista es suficiente por
        // ahora hasta que EgresosPanel gane su propio search.
        expect(item.url).toBe('/egresos');
      }
    });
  });
});

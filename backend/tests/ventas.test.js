/**
 * Tests de integración — Ventas
 *
 * Cubre:
 *   POST   /api/ventas            — crea venta con items/pagos/canje, descuenta stock, calcula USD
 *   multi-moneda                  — item en ARS convertido a USD por TC
 *   GET    /api/ventas            — incluye items, pagos y canjes; filtros
 *   DELETE /api/ventas/:id        — repone stock
 *   etiquetas / egresos / ventas-rápidas / métodos de pago
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, catBase;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

async function crearProducto(over = {}) {
  const res = await request(app).post('/api/inventario/productos').set(auth()).send({
    tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBase, nombre: 'iPhone 15 Pro',
    costo: 800, precio_venta: 950, cantidad: 1, ...over,
  });
  return res.body;
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth()).send({ nombre: 'Base Test' });
  catBase = cat.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('POST /api/ventas', () => {
  it('crea una venta en USD, calcula total/ganancia y descuenta stock', async () => {
    const prod = await crearProducto();
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      cliente_nombre: 'Juan Pérez',
      estado: 'acreditado',
      items: [{ producto_id: prod.id, descripcion: 'iPhone 15 Pro', cantidad: 1, precio_vendido: 950, costo: 800, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 950, moneda: 'USD' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.order_id).toMatch(/^ORD-/);
    expect(Number(res.body.total_usd)).toBe(950);
    expect(Number(res.body.ganancia_usd)).toBe(150);

    // stock del producto unitario quedó vendido
    const inv = await request(app).get(`/api/inventario/productos?buscar=iPhone 15 Pro&estado=vendido`).set(auth());
    expect(inv.body.data.map(p => p.id)).toContain(prod.id);
  });

  it('convierte un item en ARS a USD usando el TC de la venta', async () => {
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      tc_venta: 1425,
      items: [{ descripcion: 'iPhone 17 Sage', cantidad: 1, precio_vendido: 900000, costo: 765000, moneda: 'ARS' }],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total_usd)).toBeCloseTo(631.58, 1);
  });

  it('rechaza una venta sin items → 400', async () => {
    const res = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [] });
    expect(res.status).toBe(400);
  });

  it('crea una venta con canje que ingresa al stock', async () => {
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone 16', cantidad: 1, precio_vendido: 1000, costo: 850, moneda: 'USD' }],
      canjes: [{ descripcion: 'iPhone 12 usado', imei: '111122223333444', valor_toma: 250, moneda: 'USD', agregar_stock: true }],
    });
    expect(res.status).toBe(201);
    // el usado entró al inventario
    const inv = await request(app).get('/api/inventario/productos?buscar=iPhone 12 usado').set(auth());
    expect(inv.body.data.length).toBeGreaterThan(0);
    expect(Number(inv.body.data[0].costo)).toBe(250);
  });

  // Junio 2026: canje completo con TODOS los campos del schema ampliado.
  // Verifica que el producto creado en Inventario tiene TODA la info usable
  // (antes el producto venía con categoria_id=NULL, condicion=NULL, etc).
  it('canje completo con 9 campos → producto en Inventario tiene todos los datos', async () => {
    // Crear categoría para asignarla al canje
    const catRes = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone Test Canje' });
    const catId = catRes.body.id;

    const imei = '900' + Date.now().toString().slice(-12);
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone 16 Pro', cantidad: 1, precio_vendido: 1500, costo: 1200, moneda: 'USD' }],
      canjes: [{
        descripcion: 'iPhone 13 Pro 256 Sierra Blue',
        imei, gb: '256', color: 'Sierra Blue', bateria: 87,
        valor_toma: 600, moneda: 'USD', agregar_stock: true,
        categoria_id: catId, condicion: 'usado',
        precio_venta_sugerido: 950,
        observaciones: 'Pantalla sin raspones. Caja original incluida.',
      }],
    });
    expect(res.status).toBe(201);

    // Verificar el producto creado tiene TODOS los campos correctamente seteados
    const inv = await request(app).get(`/api/inventario/productos?buscar=${imei}`).set(auth());
    expect(inv.body.data).toHaveLength(1);
    const p = inv.body.data[0];
    expect(p.nombre).toBe('iPhone 13 Pro 256 Sierra Blue');
    expect(p.imei).toBe(imei);
    expect(p.gb).toBe('256');
    expect(p.color).toBe('Sierra Blue');
    expect(Number(p.bateria)).toBe(87);
    expect(p.categoria_id).toBe(catId);
    expect(p.condicion).toBe('usado');
    expect(Number(p.costo)).toBe(600);           // = valor_toma
    expect(Number(p.precio_venta)).toBe(950);    // = precio_venta_sugerido
    expect(p.estado).toBe('disponible');
    // Observaciones: el texto del user prependido + la nota automática.
    expect(p.observaciones).toContain('Pantalla sin raspones');
    expect(p.observaciones).toContain('Ingresado por canje');
  });

  // 2026-07-11: nuevo path — canje con `clase_id` explícito (F3). El
  // frontend ahora envía la categoría real que el operador seleccionó en
  // el select "Categoría" del canje. El backend acepta el UUID + valida que
  // exista y pertenezca al tenant. Antes solo se derivaba por condición.
  it('canje con clase_id explícito → producto queda con esa clase (no la derivada)', async () => {
    // Tomamos el UUID de "Watch" (base seed) — arbitrario, cualquier clase
    // que NO sea celular_sellado/usado sirve para verificar que ganó el
    // clase_id explícito por sobre el auto-derive por condición.
    const clasesList = await request(app).get('/api/inventario/clases').set(auth());
    const watch = clasesList.body.find(c => c.slug_legacy === 'watch');
    expect(watch).toBeDefined();

    const imei = '902' + Date.now().toString().slice(-12);
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone 16', cantidad: 1, precio_vendido: 800, costo: 700, moneda: 'USD' }],
      canjes: [{
        descripcion: 'Apple Watch S9', imei,
        valor_toma: 200, moneda: 'USD', agregar_stock: true,
        clase_id: watch.id,     // ← path nuevo: el operador eligió "Watch"
        condicion: 'usado',      // ← si el backend derivase, sería celular_usado
      }],
    });
    expect(res.status).toBe(201);

    const inv = await request(app).get(`/api/inventario/productos?buscar=${imei}`).set(auth());
    expect(inv.body.data).toHaveLength(1);
    const p = inv.body.data[0];
    // Verificar que ganó el clase_id explícito, NO el derive de condicion=usado.
    expect(p.clase_id).toBe(watch.id);
    expect(p.clase).toBe('watch');
  });

  // Fallback path: sin clase_id explícito, backend deriva por condición.
  it('canje sin clase_id + condicion=usado → producto queda como celular_usado (derive)', async () => {
    const clasesList = await request(app).get('/api/inventario/clases').set(auth());
    const celUsado = clasesList.body.find(c => c.slug_legacy === 'celular_usado');
    expect(celUsado).toBeDefined();

    const imei = '903' + Date.now().toString().slice(-12);
    await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone 16', cantidad: 1, precio_vendido: 900, costo: 750, moneda: 'USD' }],
      canjes: [{
        descripcion: 'iPhone 12 usado', imei,
        valor_toma: 300, moneda: 'USD', agregar_stock: true,
        condicion: 'usado',
        // clase_id: undefined → backend deriva
      }],
    });

    const inv = await request(app).get(`/api/inventario/productos?buscar=${imei}`).set(auth());
    expect(inv.body.data).toHaveLength(1);
    expect(inv.body.data[0].clase_id).toBe(celUsado.id);
  });

  it('canje con agregar_stock=false NO crea producto en Inventario', async () => {
    const imei = '901' + Date.now().toString().slice(-12);
    await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone 16', cantidad: 1, precio_vendido: 1000, costo: 850, moneda: 'USD' }],
      canjes: [{
        descripcion: 'Algo viejo', imei,
        valor_toma: 100, moneda: 'USD',
        agregar_stock: false,            // ← clave
      }],
    });
    const inv = await request(app).get(`/api/inventario/productos?buscar=${imei}`).set(auth());
    expect(inv.body.data).toHaveLength(0);
  });

  it('canje default condicion=usado si no se manda explícito', async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone Default Test' });
    const imei = '902' + Date.now().toString().slice(-12);
    await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone 16', cantidad: 1, precio_vendido: 1000, costo: 850, moneda: 'USD' }],
      canjes: [{
        descripcion: 'iPhone usado sin condición explícita', imei,
        valor_toma: 300, moneda: 'USD', agregar_stock: true,
        categoria_id: cat.body.id,
        // condicion NO se envía
      }],
    });
    const inv = await request(app).get(`/api/inventario/productos?buscar=${imei}`).set(auth());
    expect(inv.body.data[0].condicion).toBe('usado');
  });

  it('múltiples canjes en una venta → múltiples productos creados', async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone Multi-Canje' });
    const imei1 = '903' + Date.now().toString().slice(-12);
    const imei2 = '904' + Date.now().toString().slice(-12);
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone 16', cantidad: 1, precio_vendido: 1500, costo: 1100, moneda: 'USD' }],
      canjes: [
        { descripcion: 'iPhone 12', imei: imei1, valor_toma: 200, moneda: 'USD', agregar_stock: true, categoria_id: cat.body.id },
        { descripcion: 'iPhone 11', imei: imei2, valor_toma: 150, moneda: 'USD', agregar_stock: true, categoria_id: cat.body.id },
      ],
    });
    expect(res.status).toBe(201);

    const inv1 = await request(app).get(`/api/inventario/productos?buscar=${imei1}`).set(auth());
    const inv2 = await request(app).get(`/api/inventario/productos?buscar=${imei2}`).set(auth());
    expect(inv1.body.data).toHaveLength(1);
    expect(inv2.body.data).toHaveLength(1);
    expect(Number(inv1.body.data[0].costo)).toBe(200);
    expect(Number(inv2.body.data[0].costo)).toBe(150);
  });

  // Regresión Sentry issue 7587634920 (20 events, 2 users afectados en prod).
  //
  // Antes: crear/editar una venta con canje `agregar_stock:true` y un IMEI
  // que ya existía en Inventario disponible reventaba el INSERT INTO
  // productos con violación del UNIQUE `idx_productos_imei_unique`. Como
  // el error salía crudo de PG, el user veía un 500 sin explicación y la
  // TX enterita rollbackeaba.
  //
  // Ahora: validación pre-INSERT devuelve 409 con contexto (id + nombre
  // del producto existente y sugerencia de cómo salir).
  it('canje con IMEI dup → 409 con contexto claro (regresión Sentry 7587634920)', async () => {
    // 1) Pre-existe un producto con IMEI X (venta previa que dejó stock).
    // categoria_id era obligatorio pre-2026-07-11; ahora es opcional. Lo
    // seguimos seteando en este test para cubrir el path histórico y
    // asegurar que la validación de IMEI dup se dispara aún con producto
    // categorizado.
    const catDup = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone IMEI Dup' });
    const imeiExistente = '905' + Date.now().toString().slice(-12);
    const preProd = await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario', clase: 'celular_sellado',
      nombre: 'iPhone Existente', imei: imeiExistente,
      categoria_id: catDup.body.id,
      costo: 500, costo_moneda: 'USD', precio_venta: 700, precio_moneda: 'USD',
      cantidad: 1, estado: 'disponible',
    });
    expect(preProd.status).toBe(201);

    // 2) Se intenta crear una venta con un canje que reutiliza el mismo IMEI.
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone 15 nuevo', cantidad: 1, precio_vendido: 1200, costo: 900, moneda: 'USD' }],
      canjes: [{
        descripcion: 'iPhone dup',
        imei: imeiExistente,       // ← mismo IMEI que el producto pre-existente
        valor_toma: 300, moneda: 'USD',
        agregar_stock: true,        // ← clave: intenta crear producto en Inventario
      }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ya existe en tu inventario/i);
    // Verificar que la respuesta menciona el nombre del producto existente para
    // que el user sepa cuál es y pueda decidir qué hacer.
    expect(res.body.error).toContain('iPhone Existente');
  });

  it('canje sin IMEI + agregar_stock:true NO es afectado por la validación', async () => {
    // Accesorios, baterías o repuestos sin serie: pueden repetirse.
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone 15 nuevo', cantidad: 1, precio_vendido: 1200, costo: 900, moneda: 'USD' }],
      canjes: [{
        descripcion: 'Cargador viejo',
        imei: null,                // ← sin IMEI
        valor_toma: 10, moneda: 'USD',
        agregar_stock: true,
      }],
    });
    expect(res.status).toBe(201);
  });

  it('canje con IMEI dup pero agregar_stock:false → OK (no crea producto)', async () => {
    // Si el operador NO quiere agregar al Inventario, el IMEI dup no
    // debería importar — el canje sólo queda registrado en la venta.
    const catB = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone B ' + Math.random() });
    const imei = '906' + Date.now().toString().slice(-12);
    await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario', clase: 'celular_sellado',
      nombre: 'Existente-B', imei,
      categoria_id: catB.body.id,
      costo: 300, costo_moneda: 'USD', precio_venta: 500, precio_moneda: 'USD',
      cantidad: 1, estado: 'disponible',
    });
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone nuevo', cantidad: 1, precio_vendido: 1000, costo: 700, moneda: 'USD' }],
      canjes: [{
        descripcion: 'iPhone canje sin ingresar',
        imei,
        valor_toma: 250, moneda: 'USD',
        agregar_stock: false,    // ← no toca inventario
      }],
    });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/ventas', () => {
  it('lista ventas con items, pagos y canjes embebidos', async () => {
    const res = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}`).set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const conPago = res.body.data.find(v => v.pagos.length > 0);
    expect(conPago).toBeDefined();
    expect(Array.isArray(conPago.items)).toBe(true);
  });

  // 2026-06-09: la grilla ahora incluye ventas B2B (movimientos_cc tipo='compra')
  // mapeadas al mismo shape. Lucas las quería "como una venta más".
  it('incluye ventas B2B (origen=b2b) con shape unificado + badge B2B', async () => {
    // Crear cliente CC + producto + venta B2B.
    const cli = await request(app).post('/api/cuentas/clientes').set(auth())
      .send({ nombre: 'Cliente Grilla', categoria: 'A+' });
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'Grilla Cat' });
    const prod = await request(app).post('/api/inventario/productos').set(auth())
      .send({
        tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: cat.body.id,
        nombre: 'iPhone Grilla', imei: '350888100000001',
        costo: 500, costo_moneda: 'USD',
        precio_venta: 1000, precio_moneda: 'USD', cantidad: 1,
      });
    const mov = await request(app).post('/api/cuentas/movimientos').set(auth())
      .send({
        cliente_cc_id: cli.body.id, fecha: hoy, tipo: 'compra', monto_total: 1000,
        // imei_serial: el modal B2B real lo pasa del picker. En tests
        // lo seteamos explícitamente para verificar el mapeo en el listado.
        items: [{ producto_id: prod.body.id, producto: 'iPhone Grilla', imei_serial: '350888100000001', cantidad: 1, valor: 1000 }],
      });
    expect(mov.status).toBe(201);

    const res = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}`).set(auth());
    expect(res.status).toBe(200);
    const b2bRow = res.body.data.find(v => v.origen === 'b2b' && v._b2b_mov_id === mov.body.id);
    expect(b2bRow).toBeDefined();
    expect(b2bRow.order_id).toMatch(/^B2B-/);
    expect(b2bRow.cliente_nombre).toContain('Cliente Grilla');
    // 2026-06-10: las B2B nuevas nacen como 'acreditado' por default
    // (antes era 'pendiente' hardcoded). El operador puede alternar via PATCH.
    expect(b2bRow.estado).toBe('acreditado');
    expect(b2bRow.etiqueta_nombre).toBe('B2B');
    expect(Number(b2bRow.total_usd)).toBe(1000);
    expect(b2bRow.items).toHaveLength(1);
    expect(b2bRow.items[0].imei).toBe('350888100000001');
    expect(b2bRow.pagos).toEqual([]);
  });

  // 2026-06-10: B2B ahora soporta 'acreditado' y 'pendiente'. El filtro
  // de estado los respeta. Filtros que no aplican a B2B (ej. 'cancelado')
  // sí descartan las filas B2B.
  it('filtro estado=acreditado SÍ trae B2B (las nuevas nacen acreditadas)', async () => {
    const res = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}&estado=acreditado`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.some(v => v.origen === 'b2b')).toBe(true);
  });
  it('filtro estado=cancelado descarta B2B (B2B no tiene ese estado)', async () => {
    const res = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}&estado=cancelado`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.every(v => v.origen !== 'b2b')).toBe(true);
  });

  it('búsqueda por IMEI/serial encuentra ventas B2B también', async () => {
    const res = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}&buscar=350888100000001`).set(auth());
    expect(res.status).toBe(200);
    const found = res.body.data.find(v => v.origen === 'b2b');
    expect(found).toBeDefined();
  });

  // 2026-06-09 — items B2B devueltos se restan del total_usd y ganancia_usd
  // de la fila B2B en la grilla unificada, y dejan de contar en KPIs del
  // dashboard. Una venta multi-item con 1 devolución se ve con el monto NETO.
  it('items devueltos se restan del total/ganancia de la fila B2B y del dashboard', async () => {
    // Setup: cliente + categoría + 2 productos en stock.
    const cli = await request(app).post('/api/cuentas/clientes').set(auth())
      .send({ nombre: 'Cli devo dash', categoria: 'A+' });
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'Cat devo dash' });
    const p1 = await request(app).post('/api/inventario/productos').set(auth())
      .send({
        tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: cat.body.id,
        nombre: 'iPhone devoA', imei: '359111111111111',
        costo: 500, costo_moneda: 'USD', precio_venta: 1000, precio_moneda: 'USD', cantidad: 1,
      });
    const p2 = await request(app).post('/api/inventario/productos').set(auth())
      .send({
        tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: cat.body.id,
        nombre: 'iPhone devoB', imei: '359222222222222',
        costo: 700, costo_moneda: 'USD', precio_venta: 1500, precio_moneda: 'USD', cantidad: 1,
      });
    // Venta multi-item por USD 2500
    const venta = await request(app).post('/api/cuentas/movimientos').set(auth())
      .send({
        cliente_cc_id: cli.body.id, fecha: hoy, tipo: 'compra', monto_total: 2500,
        items: [
          { producto_id: p1.body.id, producto: 'iPhone devoA', imei_serial: '359111111111111', cantidad: 1, valor: 1000 },
          { producto_id: p2.body.id, producto: 'iPhone devoB', imei_serial: '359222222222222', cantidad: 1, valor: 1500 },
        ],
      });
    expect(venta.status).toBe(201);

    // Antes de devolver: grilla muestra total=2500.
    const r1 = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}&buscar=359111111111111`).set(auth());
    const filaPre = r1.body.data.find(v => v.origen === 'b2b' && v._b2b_mov_id === venta.body.id);
    expect(Number(filaPre.total_usd)).toBe(2500);

    // Devolver el item p1 ($1000).
    const itemP1 = (await request(app).get(`/api/cuentas/clientes/${cli.body.id}/movimientos`).set(auth()))
      .body.data.find(m => m.id === venta.body.id).items.find(it => it.producto_id === p1.body.id);
    const devo = await request(app)
      .post(`/api/cuentas/movimientos/${venta.body.id}/items/${itemP1.id}/devolver`)
      .set(auth());
    expect(devo.status).toBe(200);

    // Después de devolver: la grilla muestra total=1500 (solo lo NO devuelto).
    const r2 = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}&buscar=359222222222222`).set(auth());
    const filaPost = r2.body.data.find(v => v.origen === 'b2b' && v._b2b_mov_id === venta.body.id);
    expect(Number(filaPost.total_usd)).toBe(1500);
    // El item devuelto sigue en el array (frontend lo necesita para tachar)
    // con devuelto_at != null.
    const itemDevuelto = filaPost.items.find(i => i.producto_id === p1.body.id);
    expect(itemDevuelto.devuelto_at).not.toBeNull();
  });
});

describe('DELETE /api/ventas/:id repone stock', () => {
  it('al borrar la venta, el producto unitario vuelve a disponible', async () => {
    const prod = await crearProducto({ nombre: 'iPhone 14 Repo' });
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ producto_id: prod.id, descripcion: 'iPhone 14 Repo', cantidad: 1, precio_vendido: 620, costo: 500, moneda: 'USD' }],
    });
    const del = await request(app).delete(`/api/ventas/${venta.body.id}`).set(auth());
    expect(del.status).toBe(200);

    const inv = await request(app).get('/api/inventario/productos?buscar=iPhone 14 Repo').set(auth());
    expect(inv.body.data[0].estado).toBe('disponible');
  });
});

describe('Integridad de stock', () => {
  it('rechaza vender más que el stock de un lote → 400', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorios_varios', nombre: 'Cargador X', cantidad: 3 });
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'Cargador X', cantidad: 5, precio_vendido: 20, costo: 5, moneda: 'USD' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insuficiente/i);
  });

  it('descuenta un lote hasta 0 y luego rechaza otra venta', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorios_varios', nombre: 'Cable Y', cantidad: 2 });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'Cable Y', cantidad: 2, precio_vendido: 10, costo: 4, moneda: 'USD' }] });
    expect(v.status).toBe(201);
    const inv = await request(app).get('/api/inventario/productos?buscar=Cable Y').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(0);
    const v2 = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'Cable Y', cantidad: 1, precio_vendido: 10, costo: 4, moneda: 'USD' }] });
    expect(v2.status).toBe(400);
  });

  it('rechaza vender un unitario ya vendido → 400', async () => {
    const prod = await crearProducto({ nombre: 'iPhone Único' });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'iPhone Único', cantidad: 1, precio_vendido: 900, costo: 700, moneda: 'USD' }] });
    expect(v.status).toBe(201);
    const v2 = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'iPhone Único', cantidad: 1, precio_vendido: 900, costo: 700, moneda: 'USD' }] });
    expect(v2.status).toBe(400);
    expect(v2.body.error).toMatch(/vendido/i);
  });

  it('al borrar la venta, el lote recupera su stock', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorios_varios', nombre: 'Funda Z', cantidad: 4 });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'Funda Z', cantidad: 3, precio_vendido: 12, costo: 4, moneda: 'USD' }] });
    await request(app).delete(`/api/ventas/${v.body.id}`).set(auth());
    const inv = await request(app).get('/api/inventario/productos?buscar=Funda Z').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(4);
  });
});

describe('Estado, cancelación y validación de TC', () => {
  it('crear una venta CANCELADA no descuenta stock', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorios_varios', nombre: 'Stock Cancel', cantidad: 5 });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, estado: 'cancelado', items: [{ producto_id: prod.id, descripcion: 'Stock Cancel', cantidad: 2, precio_vendido: 10, costo: 4, moneda: 'USD' }] });
    expect(v.status).toBe(201);
    const inv = await request(app).get('/api/inventario/productos?buscar=Stock Cancel').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(5);
  });

  it('cancelar repone stock y reactivar lo vuelve a descontar', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorios_varios', nombre: 'Stock Toggle', cantidad: 5 });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'Stock Toggle', cantidad: 2, precio_vendido: 10, costo: 4, moneda: 'USD' }] });
    await request(app).put(`/api/ventas/${v.body.id}`).set(auth()).send({ estado: 'cancelado' });
    let inv = await request(app).get('/api/inventario/productos?buscar=Stock Toggle').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(5);
    await request(app).put(`/api/ventas/${v.body.id}`).set(auth()).send({ estado: 'acreditado' });
    inv = await request(app).get('/api/inventario/productos?buscar=Stock Toggle').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(3);
  });

  it('borrar una venta cancelada no vuelve a tocar el stock', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorios_varios', nombre: 'Stock DelCancel', cantidad: 5 });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'Stock DelCancel', cantidad: 2, precio_vendido: 10, costo: 4, moneda: 'USD' }] });
    await request(app).put(`/api/ventas/${v.body.id}`).set(auth()).send({ estado: 'cancelado' });
    await request(app).delete(`/api/ventas/${v.body.id}`).set(auth());
    const inv = await request(app).get('/api/inventario/productos?buscar=Stock DelCancel').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(5);
  });

  it('rechaza una venta con ítem en ARS sin TC → 400', async () => {
    const res = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ descripcion: 'Equipo ARS', cantidad: 1, precio_vendido: 900000, costo: 700000, moneda: 'ARS' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cambio|TC/i);
  });
});

describe('Edición de ventas', () => {
  it('editar items repone y re-descuenta stock, recalcula total', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorios_varios', nombre: 'Auric Edit', cantidad: 5 });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'Auric Edit', cantidad: 2, precio_vendido: 50, costo: 20, moneda: 'USD' }] });
    expect(v.status).toBe(201);
    let inv = await request(app).get('/api/inventario/productos?buscar=Auric Edit').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(3);

    const e = await request(app).put(`/api/ventas/${v.body.id}`).set(auth()).send({ items: [{ producto_id: prod.id, descripcion: 'Auric Edit', cantidad: 4, precio_vendido: 50, costo: 20, moneda: 'USD' }] });
    expect(e.status).toBe(200);
    expect(Number(e.body.total_usd)).toBe(200);
    inv = await request(app).get('/api/inventario/productos?buscar=Auric Edit').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(1);
  });

  it('editar excediendo stock → 400 y el stock no se descuadra (rollback)', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorios_varios', nombre: 'Auric Edit2', cantidad: 3 });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'Auric Edit2', cantidad: 1, precio_vendido: 50, costo: 20, moneda: 'USD' }] });
    const e = await request(app).put(`/api/ventas/${v.body.id}`).set(auth()).send({ items: [{ producto_id: prod.id, descripcion: 'Auric Edit2', cantidad: 10, precio_vendido: 50, costo: 20, moneda: 'USD' }] });
    expect(e.status).toBe(400);
    const inv = await request(app).get('/api/inventario/productos?buscar=Auric Edit2').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(2);
  });

  it('edición simple (estado) sigue funcionando sin tocar items', async () => {
    const prod = await crearProducto({ nombre: 'iPhone EditMeta' });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, estado: 'pendiente', items: [{ producto_id: prod.id, descripcion: 'iPhone EditMeta', cantidad: 1, precio_vendido: 500, costo: 400, moneda: 'USD' }] });
    const e = await request(app).put(`/api/ventas/${v.body.id}`).set(auth()).send({ estado: 'acreditado' });
    expect(e.status).toBe(200);
    expect(e.body.estado).toBe('acreditado');
  });
});

describe('Cuenta corriente como medio de pago', () => {
  async function crearClienteCC(nombre) {
    const r = await request(app).post('/api/cuentas/clientes').set(auth()).send({ nombre, categoria: 'A-' });
    return r.body.id;
  }
  async function saldo(id) {
    const r = await request(app).get(`/api/cuentas/clientes/${id}`).set(auth());
    return Number(r.body.saldo);
  }
  const ccPago = (monto) => ({ metodo_nombre: 'Cuenta Corriente', monto, moneda: 'USD', es_cuenta_corriente: true });

  it('una venta pagada en CC genera deuda (compra) en USD para el cliente', async () => {
    const cid = await crearClienteCC('Mayorista CC 1');
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_cc_id: cid,
      items: [{ descripcion: 'iPhone CC', cantidad: 1, precio_vendido: 500, costo: 400, moneda: 'USD' }],
      pagos: [ccPago(500)],
    });
    expect(v.status).toBe(201);
    expect(await saldo(cid)).toBe(500);
  });

  it('rechaza pago en CC sin cliente de cuenta corriente → 400', async () => {
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone CC sin cliente', cantidad: 1, precio_vendido: 300, costo: 200, moneda: 'USD' }],
      pagos: [ccPago(300)],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cuenta corriente/i);
  });

  it('cancelar la venta revierte la deuda de CC', async () => {
    const cid = await crearClienteCC('Mayorista CC 2');
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_cc_id: cid,
      items: [{ descripcion: 'iPhone CC2', cantidad: 1, precio_vendido: 700, costo: 500, moneda: 'USD' }],
      pagos: [ccPago(700)],
    });
    expect(await saldo(cid)).toBe(700);
    await request(app).put(`/api/ventas/${v.body.id}`).set(auth()).send({ estado: 'cancelado' });
    expect(await saldo(cid)).toBe(0);
    // reactivar la vuelve a generar
    await request(app).put(`/api/ventas/${v.body.id}`).set(auth()).send({ estado: 'acreditado' });
    expect(await saldo(cid)).toBe(700);
  });

  it('borrar la venta revierte la deuda de CC', async () => {
    const cid = await crearClienteCC('Mayorista CC 3');
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_cc_id: cid,
      items: [{ descripcion: 'iPhone CC3', cantidad: 1, precio_vendido: 450, costo: 300, moneda: 'USD' }],
      pagos: [ccPago(450)],
    });
    expect(await saldo(cid)).toBe(450);
    await request(app).delete(`/api/ventas/${v.body.id}`).set(auth());
    expect(await saldo(cid)).toBe(0);
  });
});

describe('Etiquetas, métodos de pago, egresos y ventas rápidas', () => {
  it('crea una etiqueta y rechaza duplicado', async () => {
    const a = await request(app).post('/api/ventas/etiquetas').set(auth()).send({ nombre: 'Mayorista' });
    expect(a.status).toBe(201);
    const b = await request(app).post('/api/ventas/etiquetas').set(auth()).send({ nombre: 'mayorista' });
    expect(b.status).toBe(409);
  });

  it('lista los métodos de pago sembrados', async () => {
    const res = await request(app).get('/api/ventas/metodos-pago').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.map(m => m.nombre)).toContain('USD | Efectivo');
  });

  it('crea un egreso y calcula monto_usd por TC', async () => {
    const res = await request(app).post('/api/egresos').set(auth())
      .send({ fecha: hoy, concepto: 'Alquiler', monto: 142500, moneda: 'ARS', tc: 1425 });
    expect(res.status).toBe(201);
    expect(Number(res.body.monto_usd)).toBe(100);
  });

  it('crea una venta rápida y la marca como procesada', async () => {
    const c = await request(app).post('/api/ventas/ventas-rapidas').set(auth())
      .send({ fecha: hoy, detalle: 'iPhone 15 Pro 256 White — 500 efectivo + 338 transfer' });
    expect(c.status).toBe(201);
    expect(c.body.estado).toBe('pendiente');
    const u = await request(app).put(`/api/ventas/ventas-rapidas/${c.body.id}`).set(auth())
      .send({ estado: 'procesada' });
    expect(u.status).toBe(200);
    expect(u.body.estado).toBe('procesada');
  });
});

describe('Plantillas de garantía', () => {
  let g1, g2;

  it('crea una garantía por defecto', async () => {
    const res = await request(app).post('/api/ventas/garantias').set(auth())
      .send({ nombre: 'General', texto: 'Texto general de garantía', es_default: true });
    expect(res.status).toBe(201);
    expect(res.body.es_default).toBe(true);
    g1 = res.body.id;
  });

  it('crea una segunda garantía y al marcarla default desmarca la anterior', async () => {
    const c = await request(app).post('/api/ventas/garantias').set(auth())
      .send({ nombre: 'Apple discontinuado', texto: 'Texto específico' });
    g2 = c.body.id;
    const u = await request(app).put(`/api/ventas/garantias/${g2}`).set(auth()).send({ es_default: true });
    expect(u.status).toBe(200);
    expect(u.body.es_default).toBe(true);
    const list = await request(app).get('/api/ventas/garantias').set(auth());
    const prev = list.body.find(g => g.id === g1);
    expect(prev.es_default).toBe(false);
  });

  it('rechaza nombre duplicado → 409', async () => {
    const res = await request(app).post('/api/ventas/garantias').set(auth())
      .send({ nombre: 'general', texto: 'otro' });
    expect(res.status).toBe(409);
  });

  it('crea una venta con garantia_id asignada', async () => {
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      garantia_id: g2,
      items: [{ descripcion: 'iPhone con garantía', cantidad: 1, precio_vendido: 500, costo: 400, moneda: 'USD' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.garantia_id).toBe(g2);
  });
});

describe('Comprobantes de venta', () => {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let ventaId, compId;

  it('crea una venta y le sube un comprobante', async () => {
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ descripcion: 'iPhone con comprobante', cantidad: 1, precio_vendido: 700, costo: 600, moneda: 'USD' }],
    });
    ventaId = venta.body.id;
    const res = await request(app).post(`/api/ventas/${ventaId}/comprobantes`).set(auth())
      .send({ archivo_data: b64, archivo_nombre: 'recibo.png', archivo_tipo: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.archivo_nombre).toBe('recibo.png');
    compId = res.body.id;
  });

  it('lista los comprobantes (sin el binario)', async () => {
    const res = await request(app).get(`/api/ventas/${ventaId}/comprobantes`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].archivo_data).toBeUndefined();
  });

  it('descarga el comprobante con su data', async () => {
    const res = await request(app).get(`/api/ventas/comprobantes/${compId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.archivo_data).toBe(b64);
  });

  it('la venta refleja comprobantes_count en el listado', async () => {
    const res = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}`).set(auth());
    const v = res.body.data.find(x => x.id === ventaId);
    expect(Number(v.comprobantes_count)).toBe(1);
  });

  it('subir comprobante a venta inexistente → 404', async () => {
    const res = await request(app).post('/api/ventas/999999/comprobantes').set(auth())
      .send({ archivo_data: b64, archivo_nombre: 'x.png' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/ventas/dashboard', () => {
  it('devuelve la agregación completa del período', async () => {
    const res = await request(app).get(`/api/ventas/dashboard?desde=${hoy}&hasta=${hoy}`).set(auth());
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d.ventas_count).toBeGreaterThanOrEqual(1);
    expect(d.ingresos).toHaveProperty('usd');
    expect(d.ingresos).toHaveProperty('ars');
    expect(d.ingresos).toHaveProperty('total_usd_equiv');
    expect(d).toHaveProperty('ganancia_neta_usd');
    expect(d).toHaveProperty('costos_usd');
    expect(d).toHaveProperty('inversion_canjes_usd');
    expect(Array.isArray(d.metodos_pago)).toBe(true);
    expect(Array.isArray(d.por_etiqueta)).toBe(true);
    expect(d.diferencias).toHaveProperty('sobrepagos');
    expect(d.diferencias).toHaveProperty('faltantes');
  });

  // 2026-06-10: ganancia neta = ganancia bruta DE ACREDITADAS − egresos.
  // Las ventas pendientes/canceladas no impactan en el neto del período.
  //
  // 2026-06-11 T-09: este test era fake-green (chequeaba que el response
  // mantuviera coherencia consigo mismo, no que los valores fueran correctos).
  // Ahora siembra una venta acreditada con ganancia conocida + un egreso, y
  // verifica que ganancia_neta_usd = ganancia_acreditada (= 250) − egreso (= 80) = 170.
  // Si el backend deja de filtrar por estado='acreditado' o ignora egresos,
  // el test SÍ falla.
  it('ganancia neta calculada con valores sembrados (no fake-green)', async () => {
    const fecha = '2026-11-15'; // fecha aislada del resto del beforeAll
    // Caja USD propia del test (independiente de fixtures previos).
    const cajaUsd = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja T-09 USD', moneda: 'USD', saldo_inicial: 0 });
    expect(cajaUsd.status).toBe(201);
    // Producto con costo 600 USD, precio 850 USD → ganancia 250 USD.
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'Cat ganancia neta T-09' });
    const prod = await request(app).post('/api/inventario/productos').set(auth())
      .send({
        nombre: 'Prod T-09', clase: 'celular_sellado', tipo_carga: 'unitario',
        categoria_id: cat.body.id, costo: 600, costo_moneda: 'USD',
        precio_venta: 850, precio_moneda: 'USD', cantidad: 1,
      });
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha, cliente_nombre: 'Cliente T-09', estado: 'acreditado',
      items: [{ producto_id: prod.body.id, descripcion: 'Prod T-09',
                cantidad: 1, precio_vendido: 850, costo: 600, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: cajaUsd.body.id, metodo_nombre: 'Caja T-09 USD', monto: 850, moneda: 'USD' }],
    });
    expect(venta.status).toBe(201);
    // Egreso conocido = 80 USD el mismo día.
    const egr = await request(app).post('/api/egresos').set(auth())
      .send({ fecha, concepto: 'Egreso T-09', monto: 80, moneda: 'USD', estado: 'pagado', metodo_pago_id: cajaUsd.body.id });
    expect(egr.status).toBe(201);
    const d = (await request(app).get(`/api/ventas/dashboard?desde=${fecha}&hasta=${fecha}`).set(auth())).body;
    expect(Number(d.ganancia_bruta_acreditada_usd)).toBe(250);
    expect(Number(d.egresos_usd)).toBe(80);
    expect(Number(d.ganancia_neta_usd)).toBe(170);
  });

  // Tema C.3 (2026-06-13): el costo financiero (comisión de tarjeta/transf)
  // se descuenta de la ganancia neta. Antes del fix, la ganancia bruta seguía
  // contando esa retención como margen → ganancia inflada.
  //
  // Sembrado:
  //   - producto USD 100 con costo USD 60 → ganancia bruta de mercadería = 40 USD
  //   - venta acreditada cobrada con tarjeta 10% → comision = 10 USD
  //   - egreso 5 USD
  // Esperado: ganancia_neta_usd = 40 (bruta) − 10 (costo financiero) − 5 (egresos) = 25
  it('ganancia neta descuenta el costo financiero del método de pago', async () => {
    const fecha = '2026-11-16';
    const tarjeta10 = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC Dashboard 10%', moneda: 'ARS', es_tarjeta: true, comision_pct: 10 });
    expect(tarjeta10.status).toBe(201);
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'Cat C.3 ' + Date.now() });
    const prod = await request(app).post('/api/inventario/productos').set(auth())
      .send({
        nombre: 'Prod C.3', clase: 'celular_sellado', tipo_carga: 'unitario',
        categoria_id: cat.body.id, costo: 60, costo_moneda: 'USD',
        precio_venta: 100, precio_moneda: 'USD', cantidad: 1,
      });
    // 100000 ARS / TC 1000 = 100 USD; comisión 10% = 10000 ARS = 10 USD.
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha, cliente_nombre: 'C.3 Test', estado: 'acreditado', tc_venta: 1000,
      items: [{ producto_id: prod.body.id, descripcion: 'Prod C.3',
                cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: tarjeta10.body.id, metodo_nombre: 'TC Dashboard 10%', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(venta.status).toBe(201);
    expect(Number(venta.body.comision_total_metodos)).toBeCloseTo(10, 2);

    // Caja USD propia (no podemos egresar USD desde la caja-tarjeta ARS:
    // postCajaMovimiento valida grupo de moneda y rebota 400).
    const cajaEgr = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja C.3 egresos USD', moneda: 'USD', saldo_inicial: 100 });
    expect(cajaEgr.status).toBe(201);
    const egr = await request(app).post('/api/egresos').set(auth())
      .send({ fecha, concepto: 'Egreso C.3', monto: 5, moneda: 'USD', estado: 'pagado', metodo_pago_id: cajaEgr.body.id });
    expect(egr.status).toBe(201);

    const d = (await request(app).get(`/api/ventas/dashboard?desde=${fecha}&hasta=${fecha}`).set(auth())).body;
    expect(Number(d.ganancia_bruta_acreditada_usd)).toBeCloseTo(40, 2);
    expect(Number(d.costo_financiero_acreditado_usd)).toBeCloseTo(10, 2);
    expect(Number(d.costo_financiero_usd)).toBeCloseTo(10, 2);  // total (todas las ventas) = igual porque hay 1 sola
    expect(Number(d.egresos_usd)).toBe(5);
    // Cascada: 40 − 10 − 5 = 25
    expect(Number(d.ganancia_neta_usd)).toBeCloseTo(25, 2);
    // Desglose retail también expone la columna
    expect(Number(d.retail.costo_financiero_usd)).toBeCloseTo(10, 2);
  });

  // 2026-06-10: una venta B2B pendiente NO afecta ganancia neta. Cuando se
  // pasa a acreditado, sí impacta. Cubre el flujo end-to-end del fix.
  it('venta B2B pendiente NO suma en ganancia neta; al acreditar, suma', async () => {
    // Fecha aislada para que solo se cuenten ventas de este test.
    const fecha = '2026-04-20';
    const cli = await request(app).post('/api/cuentas/clientes').set(auth())
      .send({ nombre: 'Cli ganancia neta', categoria: 'A+' });
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'Cat ganancia neta' });
    const prod = await request(app).post('/api/inventario/productos').set(auth())
      .send({
        tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: cat.body.id,
        nombre: 'iPhone ganancia', imei: '350444000000001',
        costo: 700, costo_moneda: 'USD', precio_venta: 1000, precio_moneda: 'USD', cantidad: 1,
      });
    // Crear venta B2B como pendiente.
    const mov = await request(app).post('/api/cuentas/movimientos').set(auth())
      .send({
        cliente_cc_id: cli.body.id, fecha, tipo: 'compra', monto_total: 1000,
        estado: 'pendiente',
        items: [{ producto_id: prod.body.id, producto: 'iPhone ganancia', imei_serial: '350444000000001', cantidad: 1, valor: 1000 }],
      });
    expect(mov.status).toBe(201);

    let d = (await request(app).get(`/api/ventas/dashboard?desde=${fecha}&hasta=${fecha}`).set(auth())).body;
    // Ingresos y count incluyen la pendiente (es venta vendida del período),
    // pero ganancia neta y ganancia bruta acreditada NO la consideran (=0).
    expect(d.ventas_count).toBe(1);
    expect(Number(d.ganancia_bruta_acreditada_usd)).toBe(0);
    expect(Number(d.ganancia_neta_usd)).toBeCloseTo(0 - d.egresos_usd, 1);

    // Pasar la venta a acreditado → debería sumar 300 (1000 venta − 700 costo).
    await request(app)
      .patch(`/api/cuentas/movimientos/${mov.body.id}/estado`)
      .set(auth())
      .send({ estado: 'acreditado' });
    d = (await request(app).get(`/api/ventas/dashboard?desde=${fecha}&hasta=${fecha}`).set(auth())).body;
    expect(Number(d.ganancia_bruta_acreditada_usd)).toBeCloseTo(300, 1);
  });

  it('diferencias (sobrepagos/faltantes) se calculan correctamente', async () => {
    const fecha = '2026-01-15'; // fecha aislada para aislar el cálculo
    // Venta A: total 500, paga 450 → faltante 50
    await request(app).post('/api/ventas').set(auth()).send({
      fecha, items: [{ descripcion: 'A', cantidad: 1, precio_vendido: 500, costo: 400, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 450, moneda: 'USD' }],
    });
    // Venta B: total 300, paga 320 → sobrepago 20
    await request(app).post('/api/ventas').set(auth()).send({
      fecha, items: [{ descripcion: 'B', cantidad: 1, precio_vendido: 300, costo: 250, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 320, moneda: 'USD' }],
    });
    const res = await request(app).get(`/api/ventas/dashboard?desde=${fecha}&hasta=${fecha}`).set(auth());
    expect(res.body.diferencias.sobrepagos).toBe(20);
    expect(res.body.diferencias.faltantes).toBe(50);
    expect(res.body.diferencias.neto).toBe(-30);
  });

  it('indicadores: ticket promedio y top productos', async () => {
    // Reusa las 2 ventas de 2026-01-15 (totales 500 y 300) → ticket promedio 400
    const res = await request(app).get('/api/ventas/dashboard?desde=2026-01-15&hasta=2026-01-15').set(auth());
    expect(res.body.ticket_promedio_usd).toBe(400);
    expect(Array.isArray(res.body.top_productos)).toBe(true);
    expect(res.body.top_productos.map(p => p.descripcion).sort()).toEqual(['A', 'B']);
    expect(Array.isArray(res.body.top_vendedores)).toBe(true);
  });
});

// ─── A2: lote sin trackear_stock no debe vender ilimitado ─────────
// Regresión: la auditoría detectó que el chequeo de cantidad solo aplicaba
// si trackear_stock=true. Para tipo_carga='lote' la cantidad ES el stock,
// por lo que ahora se valida SIEMPRE.
describe('Ventas — stock de lote sin trackear (A2)', () => {
  it('rechaza una venta que supera la cantidad de un lote, aunque trackear_stock=false', async () => {
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'Lote NoTrackeado A2', clase: 'accesorios_varios', tipo_carga: 'lote',
      categoria_id: catBase, costo: 10, precio_venta: 25, cantidad: 3,
      trackear_stock: false,
    });
    expect(prod.status).toBe(201);
    // Pedimos 5 cuando solo hay 3
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Excede stock',
      items: [{ producto_id: prod.body.id, descripcion: 'Lote NoTrackeado A2', cantidad: 5, precio_vendido: 25, costo: 10, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 125, moneda: 'USD' }],
    });
    expect(venta.status).toBe(400);
    expect(venta.body.error).toMatch(/stock insuficiente/i);
  });

  it('vender exactamente la cantidad disponible sí funciona', async () => {
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'Lote NoTrackeado A2 OK', clase: 'accesorios_varios', tipo_carga: 'lote',
      categoria_id: catBase, costo: 10, precio_venta: 25, cantidad: 3,
      trackear_stock: false,
    });
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Justo',
      items: [{ producto_id: prod.body.id, descripcion: 'Lote NoTrackeado A2 OK', cantidad: 3, precio_vendido: 25, costo: 10, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 75, moneda: 'USD' }],
    });
    expect(venta.status).toBe(201);
  });
});

// Item "Diferencia de cambio" inyectado por el frontend al aceptar el modal
// de diferencia. Validamos que el cálculo de total_usd y ganancia_usd los toma
// como cualquier otro item — sin lógica especial en backend.
describe('Ventas — item "Diferencia de cambio"', () => {
  it('diferencia A FAVOR: precio + sin costo → suma al total y al profit', async () => {
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Diff A Favor', estado: 'acreditado',
      items: [
        { descripcion: 'Producto', cantidad: 1, precio_vendido: 1000, costo: 800, moneda: 'USD' },
        { descripcion: 'Diferencia de cambio (a favor)', cantidad: 1, precio_vendido: 2, costo: 0, moneda: 'USD' },
      ],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 1002, moneda: 'USD' }],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total_usd)).toBe(1002);
    expect(Number(res.body.ganancia_usd)).toBe(202); // 1000-800 + 2-0
  });

  it('diferencia EN CONTRA: precio 0 + costo → no toca total pero baja el profit', async () => {
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Diff En Contra', estado: 'acreditado',
      items: [
        { descripcion: 'Producto', cantidad: 1, precio_vendido: 1000, costo: 800, moneda: 'USD' },
        { descripcion: 'Diferencia de cambio (en contra)', cantidad: 1, precio_vendido: 0, costo: 3, moneda: 'USD' },
      ],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 1000, moneda: 'USD' }],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total_usd)).toBe(1000);
    expect(Number(res.body.ganancia_usd)).toBe(197); // 1000-800 + 0-3
  });
});

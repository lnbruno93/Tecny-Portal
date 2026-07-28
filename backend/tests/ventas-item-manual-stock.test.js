/**
 * Tests de integración — feature "Ítem manual con crear stock" (task #238)
 *
 * Contexto: en Ventas > Nueva venta, el operador puede elegir "Ítem manual" para
 * cargar un producto que no está en Inventario (típico: se acaba de recibir y
 * todavía no lo alta-ó, o es one-off que no vale la pena catalogar). Antes solo
 * quedaba como línea suelta de la venta. Ahora, si el operador marca
 * `agregar_stock=true` y llena datos de producto (nombre, imei, gb, color, etc.),
 * el backend crea el producto en `productos` con estado='vendido' en la misma
 * transacción atómica y linkea el `producto_id` al `venta_items`.
 *
 * Cubre:
 *   - Happy path: crea producto + linkea producto_id + estado='vendido'.
 *   - Compat: item sin agregar_stock → NO toca inventario (baseline).
 *   - IMEI dup dentro del payload → 409 imei_dup_payload.
 *   - IMEI dup contra stock vivo → 409 imei_dup_stock.
 *   - clase_id explícito → gana sobre derive por condición.
 *   - clase_id derive por condición=usado → celular_usado.
 *   - Nombre fallback: sin `nombre` explícito → usa descripción.
 *   - agregar_stock=true pero producto_id presente → NO re-crea (safeguard).
 *   - Item sin IMEI + agregar_stock → OK (accesorios, repuestos, etc.).
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, catBase;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

// Genera un IMEI único por test — el 15º dígito es checksum válido pero
// tampoco lo verificamos acá (el input es free-text). Prefix distinto por test
// para evitar colisión con canjes u otros tests que usan `900`-`906`.
function makeImei(prefix = '920') {
  return prefix + Date.now().toString().slice(-12);
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth())
    .send({ nombre: 'Base Item Manual Test' });
  catBase = cat.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Ventas — ítem manual crea stock (task #238)', () => {

  it('happy path: agregar_stock=true crea producto vendido + linkea producto_id', async () => {
    const imei = makeImei('921');
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{
        descripcion: 'iPhone 15 Pro Titanium',
        cantidad: 1, precio_vendido: 1200, costo: 900, moneda: 'USD',
        // ─── Feature: datos completos + crear en stock ───
        agregar_stock: true,
        nombre: 'iPhone 15 Pro',
        imei,
        gb: '256',
        color: 'Titanium',
        bateria: 100,
        categoria_id: catBase,
        condicion: 'nuevo',
        tipo_carga: 'unitario',
      }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 1200, moneda: 'USD' }],
    });
    expect(res.status).toBe(201);

    // El producto se creó en Inventario, con estado='vendido' (por eso NO
    // aparece en /productos sin filtro). Buscarlo por IMEI + estado=vendido.
    const inv = await request(app)
      .get(`/api/inventario/productos?buscar=${imei}&estado=vendido`)
      .set(auth());
    expect(inv.body.data).toHaveLength(1);
    const p = inv.body.data[0];
    expect(p.nombre).toBe('iPhone 15 Pro');
    expect(p.imei).toBe(imei);
    expect(p.gb).toBe('256');
    expect(p.color).toBe('Titanium');
    expect(Number(p.bateria)).toBe(100);
    expect(p.categoria_id).toBe(catBase);
    expect(p.condicion).toBe('nuevo');
    expect(p.estado).toBe('vendido');
    expect(Number(p.costo)).toBe(900);
    expect(Number(p.precio_venta)).toBe(1200);

    // Verificar el linkeo: la venta debe traer el producto_id en el item.
    const ventaId = res.body.id;
    const ventas = await request(app).get('/api/ventas').set(auth());
    const venta = ventas.body.data.find(v => v.id === ventaId);
    expect(venta).toBeDefined();
    expect(venta.items).toHaveLength(1);
    expect(venta.items[0].producto_id).toBe(p.id);
  });

  it('compat: item sin agregar_stock NO crea producto (baseline)', async () => {
    const imei = makeImei('922');
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{
        descripcion: 'Cable Lightning',
        cantidad: 1, precio_vendido: 20, costo: 5, moneda: 'USD',
        // ─── Sin agregar_stock: solo queda como línea ───
        // agregar_stock: false por default.
        imei,     // aunque venga imei, no debe crear producto.
        nombre: 'Cable',
      }],
    });
    expect(res.status).toBe(201);

    // No debería haber ningún producto con ese IMEI en Inventario.
    const inv = await request(app)
      .get(`/api/inventario/productos?buscar=${imei}`)
      .set(auth());
    expect(inv.body.data).toHaveLength(0);
  });

  it('IMEI duplicado dentro del payload → 409 imei_dup_payload', async () => {
    const imei = makeImei('923');
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [
        {
          descripcion: 'iPhone A', cantidad: 1, precio_vendido: 1000, costo: 800, moneda: 'USD',
          agregar_stock: true, nombre: 'iPhone A', imei, condicion: 'nuevo',
        },
        {
          descripcion: 'iPhone B', cantidad: 1, precio_vendido: 1100, costo: 850, moneda: 'USD',
          agregar_stock: true, nombre: 'iPhone B', imei,  // ← mismo IMEI, dup en payload
          condicion: 'nuevo',
        },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('imei_dup_payload');
    expect(res.body.error).toContain(imei);
  });

  it('IMEI ya existente en stock vivo → 409 imei_dup_stock', async () => {
    const imei = makeImei('924');
    // 1) Pre-crea un producto disponible con IMEI X.
    const preProd = await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario', clase: 'celular_sellado',
      nombre: 'iPhone Pre-existente',
      imei, categoria_id: catBase,
      costo: 500, costo_moneda: 'USD', precio_venta: 700, precio_moneda: 'USD',
      cantidad: 1, estado: 'disponible',
    });
    expect(preProd.status).toBe(201);

    // 2) Se intenta crear una venta con un item manual + mismo IMEI + agregar_stock.
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{
        descripcion: 'iPhone dup', cantidad: 1, precio_vendido: 900, costo: 700, moneda: 'USD',
        agregar_stock: true, nombre: 'iPhone dup', imei,
        condicion: 'nuevo',
      }],
    });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('imei_dup_stock');
    expect(res.body.error).toContain(imei);
    // Mensaje útil para el operador: sugerir agregar por nombre.
    expect(res.body.error).toMatch(/buscalo en Inventario/i);
  });

  it('clase_id explícito → producto queda con esa clase (no derive)', async () => {
    // Tomamos "Watch" como clase arbitraria que NO es la que derivaría por
    // condicion=nuevo (que sería celular_sellado).
    const clasesList = await request(app).get('/api/inventario/clases').set(auth());
    const watch = clasesList.body.find(c => c.slug_legacy === 'watch');
    expect(watch).toBeDefined();

    const imei = makeImei('925');
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{
        descripcion: 'Apple Watch S10', cantidad: 1, precio_vendido: 500, costo: 350, moneda: 'USD',
        agregar_stock: true,
        nombre: 'Apple Watch S10',
        imei,
        clase_id: watch.id,      // ← explícito
        condicion: 'nuevo',       // ← si derivara, sería celular_sellado
      }],
    });
    expect(res.status).toBe(201);

    const inv = await request(app)
      .get(`/api/inventario/productos?buscar=${imei}&estado=vendido`)
      .set(auth());
    expect(inv.body.data).toHaveLength(1);
    expect(inv.body.data[0].clase_id).toBe(watch.id);
  });

  it('sin clase_id + condicion=usado → derive celular_usado', async () => {
    const clasesList = await request(app).get('/api/inventario/clases').set(auth());
    const celUsado = clasesList.body.find(c => c.slug_legacy === 'celular_usado');
    expect(celUsado).toBeDefined();

    const imei = makeImei('926');
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{
        descripcion: 'iPhone 12 usado', cantidad: 1, precio_vendido: 400, costo: 300, moneda: 'USD',
        agregar_stock: true,
        nombre: 'iPhone 12',
        imei,
        condicion: 'usado',       // ← derive path
      }],
    });
    expect(res.status).toBe(201);

    const inv = await request(app)
      .get(`/api/inventario/productos?buscar=${imei}&estado=vendido`)
      .set(auth());
    expect(inv.body.data).toHaveLength(1);
    expect(inv.body.data[0].clase_id).toBe(celUsado.id);
  });

  it('sin nombre explícito → usa descripción como nombre', async () => {
    const imei = makeImei('927');
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{
        // Sin campo `nombre`: el backend debe usar `descripcion` como fallback.
        descripcion: 'iPhone 14 Pro Max 256 Deep Purple',
        cantidad: 1, precio_vendido: 1100, costo: 850, moneda: 'USD',
        agregar_stock: true,
        imei,
        condicion: 'nuevo',
      }],
    });
    expect(res.status).toBe(201);

    const inv = await request(app)
      .get(`/api/inventario/productos?buscar=${imei}&estado=vendido`)
      .set(auth());
    expect(inv.body.data).toHaveLength(1);
    expect(inv.body.data[0].nombre).toBe('iPhone 14 Pro Max 256 Deep Purple');
  });

  it('agregar_stock=true PERO producto_id presente → NO re-crea (safeguard)', async () => {
    // Escenario: user seleccionó un producto de Inventario (envía producto_id)
    // y ADEMÁS el flag agregar_stock quedó true por error del frontend. El
    // handler ignora el flag y usa el producto_id del stock (path normal).
    // No debe crear un producto duplicado.
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario', clase: 'celular_sellado',
      nombre: 'iPhone Safeguard',
      imei: makeImei('928-a'),
      categoria_id: catBase,
      costo: 700, costo_moneda: 'USD', precio_venta: 1000, precio_moneda: 'USD',
      cantidad: 1, estado: 'disponible',
    });
    expect(prod.status).toBe(201);
    const prodId = prod.body.id;

    // Snapshot: contar productos con "Safeguard" antes.
    const invPre = await request(app)
      .get('/api/inventario/productos?buscar=Safeguard').set(auth());
    const countPre = invPre.body.data.length;

    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{
        producto_id: prodId,         // ← path normal (producto del stock).
        descripcion: 'iPhone Safeguard',
        cantidad: 1, precio_vendido: 1000, costo: 700, moneda: 'USD',
        agregar_stock: true,          // ← flag encendido, pero producto_id ya presente.
        nombre: 'iPhone Safeguard Duplicado',  // ← si se re-crea, aparecería con este nombre.
        imei: makeImei('928-b'),      // ← si se re-crea, otro IMEI (evita el dup check).
      }],
    });
    expect(res.status).toBe(201);

    // Post-check: mismo count (no se agregó producto duplicado).
    const invPost = await request(app)
      .get('/api/inventario/productos?buscar=Safeguard').set(auth());
    expect(invPost.body.data.length).toBe(countPre);
    // El producto original quedó como vendido (path normal de descuento de stock).
    const safeguardProd = invPost.body.data.find(p => p.id === prodId);
    expect(safeguardProd).toBeDefined();
    expect(safeguardProd.estado).toBe('vendido');
  });

  it('agregar_stock con TODOS los campos completos (proveedor, observaciones, monedas separadas)', async () => {
    // 2026-07-28 v2 (feedback Lucas): el mini-form del ítem manual debe
    // permitir la MISMA info que el form de Inventario. Este test verifica
    // que TODOS los campos aterrizan correctamente en el producto creado
    // (incluyendo los agregados en v2: proveedor, observaciones, costo_moneda
    // y precio_moneda separados del `moneda` del item).
    const imei = makeImei('929');
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{
        descripcion: 'iPhone 16 Pro Max 512',
        cantidad: 1, precio_vendido: 1800, costo: 1400, moneda: 'USD',
        agregar_stock: true,
        nombre: 'iPhone 16 Pro Max',
        imei,
        gb: '512', color: 'Desert Titanium', bateria: 100,
        categoria_id: catBase, condicion: 'nuevo', tipo_carga: 'unitario',
        // v2: nuevos campos
        proveedor: 'Distribuidor Miami LLC',
        observaciones: 'Caja sellada. Compra de urgencia — 3 unidades del mismo lote.',
        costo_moneda: 'USD',
        precio_moneda: 'USD',
      }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 1800, moneda: 'USD' }],
    });
    expect(res.status).toBe(201);

    const inv = await request(app)
      .get(`/api/inventario/productos?buscar=${imei}&estado=vendido`)
      .set(auth());
    expect(inv.body.data).toHaveLength(1);
    const p = inv.body.data[0];
    expect(p.nombre).toBe('iPhone 16 Pro Max');
    expect(p.gb).toBe('512');
    expect(p.color).toBe('Desert Titanium');
    expect(Number(p.bateria)).toBe(100);
    expect(p.condicion).toBe('nuevo');
    expect(p.tipo_carga).toBe('unitario');
    expect(Number(p.costo)).toBe(1400);
    expect(Number(p.precio_venta)).toBe(1800);
    expect(p.costo_moneda).toBe('USD');
    expect(p.precio_moneda).toBe('USD');
    // v2: los nuevos campos deben persistir tal cual.
    expect(p.proveedor).toBe('Distribuidor Miami LLC');
    expect(p.observaciones).toContain('Caja sellada');
    expect(p.observaciones).toContain('Compra de urgencia');
  });

  it('costo_moneda/precio_moneda default al moneda del item si no vienen (compat)', async () => {
    // Backwards compat: si el frontend viejo no manda costo_moneda/precio_moneda,
    // el backend debe usar `moneda` del item (comportamiento pre-v2).
    const imei = makeImei('930');
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      tc_venta: 1500,
      items: [{
        descripcion: 'iPhone 14',
        cantidad: 1, precio_vendido: 1200000, costo: 900000, moneda: 'ARS',
        agregar_stock: true,
        nombre: 'iPhone 14',
        imei,
        condicion: 'nuevo',
        // Sin costo_moneda / precio_moneda — deben caer en 'ARS' (moneda del item).
      }],
    });
    expect(res.status).toBe(201);

    const inv = await request(app)
      .get(`/api/inventario/productos?buscar=${imei}&estado=vendido`)
      .set(auth());
    expect(inv.body.data).toHaveLength(1);
    expect(inv.body.data[0].costo_moneda).toBe('ARS');
    expect(inv.body.data[0].precio_moneda).toBe('ARS');
  });

  it('item sin IMEI + agregar_stock=true → OK (accesorio/repuesto sin serie)', async () => {
    // Accesorios sin serie: pueden crearse en stock sin IMEI y no colisionan.
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{
        descripcion: 'Cargador MagSafe 20W',
        cantidad: 1, precio_vendido: 40, costo: 15, moneda: 'USD',
        agregar_stock: true,
        nombre: 'Cargador MagSafe 20W',
        // sin imei — no debe romper el pre-check ni el INSERT.
        condicion: 'nuevo',
      }],
    });
    expect(res.status).toBe(201);

    // El producto se creó y quedó vendido.
    const inv = await request(app)
      .get('/api/inventario/productos?buscar=MagSafe 20W&estado=vendido').set(auth());
    expect(inv.body.data.length).toBeGreaterThan(0);
  });
});

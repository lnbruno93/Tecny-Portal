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
    tipo_carga: 'unitario', clase: 'celular', categoria_id: catBase, nombre: 'iPhone 15 Pro',
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
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorio', nombre: 'Cargador X', cantidad: 3 });
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'Cargador X', cantidad: 5, precio_vendido: 20, costo: 5, moneda: 'USD' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insuficiente/i);
  });

  it('descuenta un lote hasta 0 y luego rechaza otra venta', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorio', nombre: 'Cable Y', cantidad: 2 });
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
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorio', nombre: 'Funda Z', cantidad: 4 });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'Funda Z', cantidad: 3, precio_vendido: 12, costo: 4, moneda: 'USD' }] });
    await request(app).delete(`/api/ventas/${v.body.id}`).set(auth());
    const inv = await request(app).get('/api/inventario/productos?buscar=Funda Z').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(4);
  });
});

describe('Estado, cancelación y validación de TC', () => {
  it('crear una venta CANCELADA no descuenta stock', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorio', nombre: 'Stock Cancel', cantidad: 5 });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, estado: 'cancelado', items: [{ producto_id: prod.id, descripcion: 'Stock Cancel', cantidad: 2, precio_vendido: 10, costo: 4, moneda: 'USD' }] });
    expect(v.status).toBe(201);
    const inv = await request(app).get('/api/inventario/productos?buscar=Stock Cancel').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(5);
  });

  it('cancelar repone stock y reactivar lo vuelve a descontar', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorio', nombre: 'Stock Toggle', cantidad: 5 });
    const v = await request(app).post('/api/ventas').set(auth()).send({ fecha: hoy, items: [{ producto_id: prod.id, descripcion: 'Stock Toggle', cantidad: 2, precio_vendido: 10, costo: 4, moneda: 'USD' }] });
    await request(app).put(`/api/ventas/${v.body.id}`).set(auth()).send({ estado: 'cancelado' });
    let inv = await request(app).get('/api/inventario/productos?buscar=Stock Toggle').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(5);
    await request(app).put(`/api/ventas/${v.body.id}`).set(auth()).send({ estado: 'acreditado' });
    inv = await request(app).get('/api/inventario/productos?buscar=Stock Toggle').set(auth());
    expect(Number(inv.body.data[0].cantidad)).toBe(3);
  });

  it('borrar una venta cancelada no vuelve a tocar el stock', async () => {
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorio', nombre: 'Stock DelCancel', cantidad: 5 });
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
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorio', nombre: 'Auric Edit', cantidad: 5 });
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
    const prod = await crearProducto({ tipo_carga: 'lote', clase: 'accesorio', nombre: 'Auric Edit2', cantidad: 3 });
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

  it('ganancia neta = ganancia bruta − egresos', async () => {
    const res = await request(app).get(`/api/ventas/dashboard?desde=${hoy}&hasta=${hoy}`).set(auth());
    const d = res.body;
    expect(d.ganancia_neta_usd).toBeCloseTo(d.ganancia_bruta_usd - d.egresos_usd, 1);
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
      nombre: 'Lote NoTrackeado A2', clase: 'accesorio', tipo_carga: 'lote',
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
      nombre: 'Lote NoTrackeado A2 OK', clase: 'accesorio', tipo_carga: 'lote',
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

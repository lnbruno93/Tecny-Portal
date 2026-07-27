/**
 * Tests de integración — POST /api/proveedores/:id/devoluciones
 * (feature "Devolución de mercadería a proveedor", task #236, 2026-07-27)
 *
 * Cobertura:
 *   - Happy path: descuenta deuda + soft-delete productos + movimiento tipo='devolucion'
 *   - Validaciones schema: motivo enum, fecha formato, producto_ids min/max
 *   - Validaciones runtime:
 *       · productos_no_elegibles (no existen o no disponibles)
 *       · productos_wrong_proveedor (comprados a otro proveedor)
 *       · productos_moneda_no_usd (v1 constraint)
 *   - Idempotency-Key: rechaza UUID inválido + replay devuelve mov original
 *   - Proveedor inexistente → 404
 *   - Cross-tenant safety: schema.strict() + tenant guard via RLS (implícito)
 *
 * Pattern: espejo simétrico de entrega_mercaderia (POST /api/cuentas/entregas-mercaderia)
 * pero para proveedores en lugar de clientes.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

// Un UUID cualquiera válido para probar el path idempotente.
const VALID_UUID = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
const INVALID_UUID = 'no-es-uuid';

async function crearProveedor(over = {}) {
  const res = await request(app).post('/api/proveedores').set(auth())
    .send({ nombre: 'Mayorista Test Devolución', ...over });
  return res.body;
}

// Crea una compra con un producto en Inventario (patrón `producto_stock`).
// Devuelve `{ mov, producto }`. `producto.id` es el ID que se usa para devolver.
async function crearCompraConProducto({ proveedorId, categoriaId, imei, costo = 500, monedaCosto = 'USD', montoCompra = 500, moneda = 'USD', tc }) {
  const body = {
    proveedor_id: proveedorId, fecha: hoy, tipo: 'compra',
    monto: montoCompra, moneda,
    ...(tc ? { tc } : {}),
    items: [{
      producto: 'iPhone', imei_serial: imei, valor: costo,
      producto_stock: {
        tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: categoriaId,
        nombre: `iPhone Test ${imei}`, imei, cantidad: 1,
        costo, costo_moneda: monedaCosto,
        precio_venta: costo + 200, precio_moneda: 'USD',
      },
    }],
  };
  const compra = await request(app).post('/api/proveedores/movimientos').set(auth()).send(body);
  if (compra.status !== 201) {
    throw new Error(`Compra falló: ${compra.status} ${JSON.stringify(compra.body)}`);
  }
  return { mov: compra.body, producto: compra.body.productos_creados[0] };
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('POST /api/proveedores/:id/devoluciones — happy path', () => {
  let catId;

  beforeAll(async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone (Devolución Tests)' });
    catId = cat.body.id;
  });

  it('happy path: reduce deuda + soft-delete productos + crea movimiento tipo=devolucion', async () => {
    const prov = await crearProveedor({ nombre: 'ProvHappy Devolución' });

    // Compra de 2 productos USD 600 c/u → deuda = 1200 USD
    const p1 = await crearCompraConProducto({ proveedorId: prov.id, categoriaId: catId, imei: '900000000000001', costo: 600, montoCompra: 600 });
    const p2 = await crearCompraConProducto({ proveedorId: prov.id, categoriaId: catId, imei: '900000000000002', costo: 600, montoCompra: 600 });

    // Confirmar deuda actual
    const antes = await request(app).get('/api/proveedores').set(auth());
    const rowAntes = antes.body.data.find(r => r.id === prov.id);
    expect(Number(rowAntes.saldo_usd)).toBeCloseTo(1200, 2);

    // Devolución de ambos
    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .send({
        fecha: hoy,
        motivo: 'defecto',
        motivo_detalle: 'Ambos vinieron con la pantalla rota',
        producto_ids: [p1.producto.id, p2.producto.id],
      });

    expect(res.status).toBe(201);
    expect(res.body.productos_devueltos).toBe(2);
    expect(Number(res.body.monto_total_usd)).toBeCloseTo(1200, 2);
    expect(res.body.movimiento.tipo).toBe('devolucion');
    expect(res.body.movimiento.moneda).toBe('USD');
    expect(Number(res.body.movimiento.monto_usd)).toBeCloseTo(1200, 2);
    expect(res.body.movimiento.descripcion).toMatch(/Devolución.*Defecto.*2 producto/i);

    // La deuda ahora es 0
    const despues = await request(app).get('/api/proveedores').set(auth());
    const rowDesp = despues.body.data.find(r => r.id === prov.id);
    expect(Number(rowDesp.saldo_usd)).toBeCloseTo(0, 2);

    // Los productos NO aparecen más en Inventario
    const inv1 = await request(app).get(`/api/inventario/productos?buscar=900000000000001`).set(auth());
    expect(inv1.body.data.some(x => x.id === p1.producto.id)).toBe(false);
    const inv2 = await request(app).get(`/api/inventario/productos?buscar=900000000000002`).set(auth());
    expect(inv2.body.data.some(x => x.id === p2.producto.id)).toBe(false);

    // El GET de movimientos del proveedor incluye la devolución con items snapshot
    const movs = await request(app).get(`/api/proveedores/${prov.id}/movimientos`).set(auth());
    const devMov = movs.body.data.find(m => m.tipo === 'devolucion');
    expect(devMov).toBeDefined();
    expect(devMov.items).toHaveLength(2);
    expect(devMov.items.map(i => i.imei_serial).sort()).toEqual(['900000000000001', '900000000000002']);
    expect(Number(devMov.items[0].valor)).toBeCloseTo(600, 2);
  });

  it('devolución parcial: 1 de 3 productos → deuda baja proporcionalmente', async () => {
    const prov = await crearProveedor({ nombre: 'ProvParcial Devolución' });
    const p1 = await crearCompraConProducto({ proveedorId: prov.id, categoriaId: catId, imei: '900000000001001', costo: 300, montoCompra: 300 });
    const p2 = await crearCompraConProducto({ proveedorId: prov.id, categoriaId: catId, imei: '900000000001002', costo: 300, montoCompra: 300 });
    const p3 = await crearCompraConProducto({ proveedorId: prov.id, categoriaId: catId, imei: '900000000001003', costo: 300, montoCompra: 300 });

    // Deuda inicial: 900 USD
    const antes = (await request(app).get('/api/proveedores').set(auth())).body.data.find(r => r.id === prov.id);
    expect(Number(antes.saldo_usd)).toBeCloseTo(900, 2);

    // Devolver solo 1
    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .send({ fecha: hoy, motivo: 'arrepentimiento', producto_ids: [p2.producto.id] });
    expect(res.status).toBe(201);

    // Deuda ahora es 600
    const desp = (await request(app).get('/api/proveedores').set(auth())).body.data.find(r => r.id === prov.id);
    expect(Number(desp.saldo_usd)).toBeCloseTo(600, 2);

    // p1 y p3 siguen en Inventario, p2 no
    const inv1 = await request(app).get(`/api/inventario/productos?buscar=900000000001001`).set(auth());
    expect(inv1.body.data.some(x => x.id === p1.producto.id)).toBe(true);
    const inv2 = await request(app).get(`/api/inventario/productos?buscar=900000000001002`).set(auth());
    expect(inv2.body.data.some(x => x.id === p2.producto.id)).toBe(false);
    const inv3 = await request(app).get(`/api/inventario/productos?buscar=900000000001003`).set(auth());
    expect(inv3.body.data.some(x => x.id === p3.producto.id)).toBe(true);
  });

  it('acepta todos los motivos del enum', async () => {
    // Map motivo → substring del label esperado en la descripción (verificamos
    // el label human-readable, no el enum crudo).
    const CASES = [
      { motivo: 'error_proveedor',  label: 'Error del proveedor' },
      { motivo: 'defecto',          label: 'Defecto' },
      { motivo: 'arrepentimiento',  label: 'Arrepentimiento' },
      { motivo: 'cambio_modelo',    label: 'Cambio de modelo' },
      { motivo: 'otro',             label: 'Otro' },
    ];
    for (let i = 0; i < CASES.length; i++) {
      const { motivo, label } = CASES[i];
      const prov = await crearProveedor({ nombre: `ProvMotivo ${motivo}` });
      const p = await crearCompraConProducto({
        proveedorId: prov.id, categoriaId: catId,
        imei: `900000000002${String(i).padStart(3, '0')}`,
        costo: 100, montoCompra: 100,
      });
      const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
        .send({ fecha: hoy, motivo, producto_ids: [p.producto.id] });
      expect(res.status).toBe(201);
      expect(res.body.movimiento.descripcion).toContain(label);
    }
  });
});

describe('POST /api/proveedores/:id/devoluciones — validaciones schema', () => {
  let catId, prov, productoId;

  beforeAll(async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone (Devolución Schema Tests)' });
    catId = cat.body.id;
    prov = await crearProveedor({ nombre: 'ProvSchema Devolución' });
    const p = await crearCompraConProducto({ proveedorId: prov.id, categoriaId: catId, imei: '900000000003001', costo: 100, montoCompra: 100 });
    productoId = p.producto.id;
  });

  it('motivo inválido → 400', async () => {
    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .send({ fecha: hoy, motivo: 'motivo_falso', producto_ids: [productoId] });
    expect(res.status).toBe(400);
  });

  it('fecha con formato inválido → 400', async () => {
    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .send({ fecha: '27/07/2026', motivo: 'defecto', producto_ids: [productoId] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/fecha/i);
  });

  it('producto_ids vacío → 400', async () => {
    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [] });
    expect(res.status).toBe(400);
  });

  it('más de 200 producto_ids → 400', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: ids });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/200/i);
  });

  it('motivo_detalle > 500 chars → 400', async () => {
    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .send({
        fecha: hoy, motivo: 'otro',
        motivo_detalle: 'a'.repeat(501),
        producto_ids: [productoId],
      });
    expect(res.status).toBe(400);
  });

  it('campo extra → 400 (strict schema)', async () => {
    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [productoId], campo_hacker: 'x' });
    expect(res.status).toBe(400);
  });

  it('ID de proveedor no numérico → 404 (router regex \\d+ no matchea abc)', async () => {
    const res = await request(app).post('/api/proveedores/abc/devoluciones').set(auth())
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [productoId] });
    // El router usa /:id(\\d+), así que 'abc' no matchea la ruta → 404
    expect(res.status).toBe(404);
  });
});

describe('POST /api/proveedores/:id/devoluciones — validaciones runtime', () => {
  let catId;

  beforeAll(async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone (Devolución Runtime Tests)' });
    catId = cat.body.id;
  });

  it('proveedor inexistente → 404', async () => {
    const res = await request(app).post('/api/proveedores/999999/devoluciones').set(auth())
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [1] });
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe('proveedor_not_found');
  });

  it('producto que no existe → 409 productos_no_elegibles', async () => {
    const prov = await crearProveedor({ nombre: 'ProvInvalido Devolución' });
    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [8888888, 9999999] });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('productos_no_elegibles');
    expect(res.body.invalid_ids).toEqual(expect.arrayContaining([8888888, 9999999]));
  });

  it('producto ya vendido → 409 productos_no_elegibles', async () => {
    const prov = await crearProveedor({ nombre: 'ProvVendido Devolución' });
    const { producto } = await crearCompraConProducto({
      proveedorId: prov.id, categoriaId: catId,
      imei: '900000000004001', costo: 500, montoCompra: 500,
    });

    // Marcar el producto como vendido (bypass del flujo de venta — directo en DB)
    await pool.query(`UPDATE productos SET estado = 'vendido' WHERE id = $1`, [producto.id]);

    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [producto.id] });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('productos_no_elegibles');
    expect(res.body.invalid_ids).toContain(producto.id);
  });

  it('producto comprado a otro proveedor → 409 productos_wrong_proveedor', async () => {
    const provA = await crearProveedor({ nombre: 'ProvA Wrong Devolución' });
    const provB = await crearProveedor({ nombre: 'ProvB Wrong Devolución' });

    // Producto comprado a provA
    const { producto } = await crearCompraConProducto({
      proveedorId: provA.id, categoriaId: catId,
      imei: '900000000005001', costo: 400, montoCompra: 400,
    });

    // Intentamos devolverlo a provB
    const res = await request(app).post(`/api/proveedores/${provB.id}/devoluciones`).set(auth())
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [producto.id] });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('productos_wrong_proveedor');
    expect(res.body.invalid_ids).toContain(producto.id);
  });

  it('producto en moneda ARS → 409 productos_moneda_no_usd (v1 constraint)', async () => {
    const prov = await crearProveedor({ nombre: 'ProvARS Devolución' });
    // Compra en ARS (con TC 1000 para monto_usd=1)
    const { producto } = await crearCompraConProducto({
      proveedorId: prov.id, categoriaId: catId,
      imei: '900000000006001', costo: 1000, monedaCosto: 'ARS',
      montoCompra: 1000, moneda: 'ARS', tc: 1000,
    });

    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [producto.id] });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('productos_moneda_no_usd');
    expect(res.body.invalid_ids).toContain(producto.id);
  });

  it('mix: 1 producto válido + 1 producto de otro proveedor → 409 (rollback total)', async () => {
    const provA = await crearProveedor({ nombre: 'ProvA Mix Devolución' });
    const provB = await crearProveedor({ nombre: 'ProvB Mix Devolución' });

    const pOk = await crearCompraConProducto({
      proveedorId: provA.id, categoriaId: catId,
      imei: '900000000007001', costo: 200, montoCompra: 200,
    });
    const pWrong = await crearCompraConProducto({
      proveedorId: provB.id, categoriaId: catId,
      imei: '900000000007002', costo: 200, montoCompra: 200,
    });

    const res = await request(app).post(`/api/proveedores/${provA.id}/devoluciones`).set(auth())
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [pOk.producto.id, pWrong.producto.id] });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('productos_wrong_proveedor');

    // El producto válido NO se devolvió (rollback total, atomicidad)
    const inv = await request(app).get('/api/inventario/productos?buscar=900000000007001').set(auth());
    expect(inv.body.data.some(x => x.id === pOk.producto.id)).toBe(true);

    // La deuda de provA sigue igual (no se creó movimiento)
    const desp = (await request(app).get('/api/proveedores').set(auth())).body.data.find(r => r.id === provA.id);
    expect(Number(desp.saldo_usd)).toBeCloseTo(200, 2);
  });
});

describe('POST /api/proveedores/:id/devoluciones — Idempotency-Key', () => {
  let catId;

  beforeAll(async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone (Devolución Idem Tests)' });
    catId = cat.body.id;
  });

  it('rechaza UUID inválido → 400 idempotency_key_invalid', async () => {
    const prov = await crearProveedor({ nombre: 'ProvIdemInvalid Devolución' });
    const res = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .set('Idempotency-Key', INVALID_UUID)
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [1] });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('idempotency_key_invalid');
  });

  it('replay con mismo UUID → devuelve el movimiento original sin duplicar', async () => {
    const prov = await crearProveedor({ nombre: 'ProvIdemReplay Devolución' });
    const p = await crearCompraConProducto({
      proveedorId: prov.id, categoriaId: catId,
      imei: '900000000008001', costo: 500, montoCompra: 500,
    });

    const key = VALID_UUID();

    // 1ra request: 201, se procesa normalmente
    const r1 = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .set('Idempotency-Key', key)
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [p.producto.id] });
    expect(r1.status).toBe(201);
    const movIdOriginal = r1.body.movimiento.id;

    // 2da request: mismo key → 200 con `idempotent_replay: true`, sin duplicar
    const r2 = await request(app).post(`/api/proveedores/${prov.id}/devoluciones`).set(auth())
      .set('Idempotency-Key', key)
      .send({ fecha: hoy, motivo: 'defecto', producto_ids: [p.producto.id] });
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent_replay).toBe(true);
    expect(r2.body.id).toBe(movIdOriginal);

    // La deuda cayó UNA sola vez (no dos veces)
    const desp = (await request(app).get('/api/proveedores').set(auth())).body.data.find(r => r.id === prov.id);
    expect(Number(desp.saldo_usd)).toBeCloseTo(0, 2);

    // Solo 1 movimiento devolución en el listado (no 2)
    const movs = await request(app).get(`/api/proveedores/${prov.id}/movimientos`).set(auth());
    const devs = movs.body.data.filter(m => m.tipo === 'devolucion');
    expect(devs).toHaveLength(1);
  });
});

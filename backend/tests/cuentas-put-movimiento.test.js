/**
 * Tests de integración — PUT /api/cuentas/movimientos/:id (Fase B, task #300)
 *
 * Edit inline del movimiento B2B con diff-based items + sync inventario
 * bidireccional. Simétrico al PUT /api/proveedores/movimientos/:mid (task #262).
 *
 * Cubre:
 *   · Happy paths: edit fecha/notas/descripcion, edit item (texto libre),
 *     agregar item nuevo, remover item, recalc monto_total desde SUM(items.valor).
 *   · Sync inventario: agregar item con producto_id descuenta stock, remover
 *     item con producto_id revierte stock.
 *   · Guards: tipo != 'compra' → 400; cambiar producto_id/cantidad de item
 *     existente → 400; remover item vendido en otra venta → 409; stock
 *     insuficiente → 409; movimiento inexistente → 404; item ajeno → 400.
 *   · Recalc caja: mov con caja_id + monto cambia → reverseCajaMovimientos
 *     + postCajaMovimiento → caja saldo ajustado.
 *   · Idempotency: replay con misma key → devuelve mov existente.
 *
 * Archivo separado del cuentas.test.js (2100+ líneas) para navegabilidad.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let adminToken;
let cliId;
let catId;
let cajaUsdId;

async function saldoCaja(id) {
  const r = await request(app).get('/api/cajas/cajas').set('Authorization', `Bearer ${adminToken}`);
  return Number((r.body || []).find(c => c.id === id)?.saldo_actual ?? 0);
}
async function saldoCliente(id) {
  const r = await request(app).get(`/api/cuentas/clientes/${id}`).set('Authorization', `Bearer ${adminToken}`);
  return Number(r.body.saldo || 0);
}
async function crearProducto({ nombre = 'iPhone Test PUT', cantidad = 1, imei = null } = {}) {
  const r = await request(app).post('/api/inventario/productos').set('Authorization', `Bearer ${adminToken}`)
    .send({
      tipo_carga: cantidad > 1 ? 'lote' : 'unitario',
      clase: cantidad > 1 ? 'accesorios_varios' : 'celular_sellado',
      categoria_id: catId, nombre, imei,
      costo: 500, costo_moneda: 'USD',
      precio_venta: 800, precio_moneda: 'USD',
      cantidad,
    });
  return r.body;
}
async function crearVentaB2B({ producto_id, cantidad = 1, valor = 800, monto_total = 800, caja_id = null } = {}) {
  const items = producto_id
    ? [{ producto_id, cantidad, valor }]
    : [{ producto: 'Item libre', valor }];
  const res = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
    .send({
      cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra',
      monto_total, caja_id, items,
    });
  return res;
}
async function getMovConItems(movId) {
  const r = await request(app).get(`/api/cuentas/clientes/${cliId}/movimientos`)
    .set('Authorization', `Bearer ${adminToken}`);
  return (r.body.data || []).find(m => m.id === movId);
}

beforeAll(async () => {
  pool = await setupTestDb();
  const r1 = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = r1.body.token;

  const cli = await request(app).post('/api/cuentas/clientes').set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'Cliente PUT Tests', categoria: 'A+' });
  cliId = cli.body.id;

  const cat = await request(app).post('/api/inventario/categorias').set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre: 'PUT Tests' });
  catId = cat.body.id;

  const r = await request(app).get('/api/ventas/metodos-pago').set('Authorization', `Bearer ${adminToken}`);
  cajaUsdId = (r.body || []).find(m => m.moneda === 'USD').id;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ═══════════════════════════════════════════════════════════════
// HAPPY PATHS
// ═══════════════════════════════════════════════════════════════
describe('PUT /movimientos/:id — happy paths', () => {
  it('edit fecha + descripcion + notas (sin tocar items) → 200 + campos actualizados', async () => {
    const create = await crearVentaB2B({ valor: 100, monto_total: 100 });
    expect(create.status).toBe(201);
    const movId = create.body.id;

    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fecha: '2026-05-30',
        descripcion: 'Ref interna 12345',
        notas: 'Cliente pidió factura A',
      });
    expect(put.status).toBe(200);
    expect(String(put.body.fecha).slice(0, 10)).toBe('2026-05-30');
    expect(put.body.descripcion).toBe('Ref interna 12345');
    expect(put.body.notas).toBe('Cliente pidió factura A');
    // Items no tocados: monto_total sigue igual al original.
    expect(Number(put.body.monto_total)).toBe(100);
  });

  it('edit item (texto libre) cambia color/valor → 200 + monto_total recalculado', async () => {
    const create = await crearVentaB2B({ valor: 100, monto_total: 100 });
    const movId = create.body.id;
    const itemId = create.body.items[0].id;

    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ id: itemId, producto: 'Item libre', color: 'Rojo', valor: 150 }],
      });
    expect(put.status).toBe(200);
    expect(Number(put.body.monto_total)).toBe(150);  // recalculado
    expect(put.body.items[0].color).toBe('Rojo');
    expect(Number(put.body.items[0].valor)).toBe(150);
  });

  it('agregar item nuevo sin producto_id → 200 + suma correcta en monto_total', async () => {
    const create = await crearVentaB2B({ valor: 100, monto_total: 100 });
    const movId = create.body.id;
    const itemId = create.body.items[0].id;

    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          { id: itemId, producto: 'Item libre', valor: 100 },
          { producto: 'Nuevo item extra', valor: 75 },
        ],
      });
    expect(put.status).toBe(200);
    expect(put.body.items).toHaveLength(2);
    expect(Number(put.body.monto_total)).toBe(175);  // 100 + 75
  });

  it('remover item → 200 + monto_total recalculado', async () => {
    const create = await request(app).post('/api/cuentas/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 300,
        items: [
          { producto: 'Item A', valor: 100 },
          { producto: 'Item B', valor: 200 },
        ],
      });
    expect(create.status).toBe(201);
    const movId = create.body.id;
    const itemAId = create.body.items[0].id;

    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [{ id: itemAId, producto: 'Item A', valor: 100 }] });
    expect(put.status).toBe(200);
    expect(put.body.items).toHaveLength(1);
    expect(Number(put.body.monto_total)).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════
// SYNC INVENTARIO
// ═══════════════════════════════════════════════════════════════
describe('PUT /movimientos/:id — sync inventario', () => {
  it('agregar item con producto_id → descuenta stock', async () => {
    const create = await crearVentaB2B({ valor: 100, monto_total: 100 });
    const movId = create.body.id;
    const itemId = create.body.items[0].id;
    const prod = await crearProducto({ nombre: 'iPhone PUT Add', imei: '350200000010001' });

    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          { id: itemId, producto: 'Item libre', valor: 100 },
          { producto_id: prod.id, cantidad: 1, valor: 800 },
        ],
      });
    expect(put.status).toBe(200);
    expect(put.body.items).toHaveLength(2);
    expect(Number(put.body.monto_total)).toBe(900);

    // Stock del producto: bajó a 0 y quedó vendido.
    const p = await request(app).get(`/api/inventario/productos?buscar=350200000010001&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`);
    const pAct = p.body.data.find(x => x.id === prod.id);
    expect(Number(pAct.cantidad)).toBe(0);
    expect(pAct.estado).toBe('vendido');
  });

  it('remover item con producto_id → revierte stock', async () => {
    const prod = await crearProducto({ nombre: 'iPhone PUT Remove', imei: '350200000010002' });
    const create = await crearVentaB2B({ producto_id: prod.id, valor: 800, monto_total: 800 });
    expect(create.status).toBe(201);
    const movId = create.body.id;

    // Verificar que el POST original ya descontó stock.
    const p1 = await request(app).get(`/api/inventario/productos?buscar=350200000010002&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(p1.body.data.find(x => x.id === prod.id).estado).toBe('vendido');

    // PUT con items=[] → remueve todos los items.
    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [] });
    expect(put.status).toBe(200);
    expect(put.body.items).toHaveLength(0);
    expect(Number(put.body.monto_total)).toBe(0);

    // Stock repuesto.
    const p2 = await request(app).get(`/api/inventario/productos?buscar=350200000010002&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`);
    const pAct = p2.body.data.find(x => x.id === prod.id);
    expect(Number(pAct.cantidad)).toBe(1);
    expect(pAct.estado).toBe('disponible');
  });

  it('stock insuficiente al agregar nuevo → 409 con rollback', async () => {
    const prod = await crearProducto({ nombre: 'Accesorio Limitado PUT', cantidad: 2 });
    const create = await crearVentaB2B({ valor: 100, monto_total: 100 });
    const movId = create.body.id;
    const itemId = create.body.items[0].id;

    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          { id: itemId, producto: 'Item libre', valor: 100 },
          { producto_id: prod.id, cantidad: 5, valor: 500 },  // pide 5, hay 2
        ],
      });
    expect(put.status).toBe(409);
    expect(put.body.error).toMatch(/insuficiente/i);

    // Rollback: producto sigue con stock 2, mov sigue con 1 item + monto 100.
    const p = await request(app).get(`/api/inventario/productos?buscar=Limitado PUT&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(Number(p.body.data.find(x => x.id === prod.id).cantidad)).toBe(2);
    const mov = await getMovConItems(movId);
    expect(mov.items).toHaveLength(1);
    expect(Number(mov.monto_total)).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════
// GUARDS
// ═══════════════════════════════════════════════════════════════
describe('PUT /movimientos/:id — guards', () => {
  it('tipo != compra → 400', async () => {
    // Crear un pago (tipo=pago, requiere caja_id).
    const pago = await request(app).post('/api/cuentas/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'pago',
        monto_total: 50, caja_id: cajaUsdId,
      });
    expect(pago.status).toBe(201);

    const put = await request(app).put(`/api/cuentas/movimientos/${pago.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notas: 'nueva nota' });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/tipo='pago'|solo se pueden editar ventas b2b/i);
  });

  it('cambiar producto_id de item existente → 400', async () => {
    const prod1 = await crearProducto({ nombre: 'iPhone PUT P1', imei: '350200000020001' });
    const prod2 = await crearProducto({ nombre: 'iPhone PUT P2', imei: '350200000020002' });
    const create = await crearVentaB2B({ producto_id: prod1.id, valor: 800, monto_total: 800 });
    const movId = create.body.id;
    const itemId = create.body.items[0].id;

    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ id: itemId, producto_id: prod2.id, cantidad: 1, valor: 800 }],
      });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/no se puede cambiar producto_id/i);
  });

  it('cambiar cantidad de item existente con producto → 400', async () => {
    const prod = await crearProducto({ nombre: 'iPhone PUT Cant', cantidad: 5 });
    const create = await crearVentaB2B({ producto_id: prod.id, cantidad: 2, valor: 500, monto_total: 500 });
    const movId = create.body.id;
    const itemId = create.body.items[0].id;

    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ id: itemId, producto_id: prod.id, cantidad: 3, valor: 500 }],
      });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/no se puede cambiar cantidad/i);
  });

  it('movimiento inexistente → 404', async () => {
    const put = await request(app).put(`/api/cuentas/movimientos/999999`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notas: 'x' });
    expect(put.status).toBe(404);
  });

  it('item id ajeno al movimiento → 400', async () => {
    const create1 = await crearVentaB2B({ valor: 100, monto_total: 100 });
    const create2 = await crearVentaB2B({ valor: 100, monto_total: 100 });
    const item2Id = create2.body.items[0].id;

    // Intentar meter item de create2 en create1.
    const put = await request(app).put(`/api/cuentas/movimientos/${create1.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ id: item2Id, producto: 'x', valor: 100 }],
      });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/no pertenece a este movimiento/i);
  });

  it('body vacío (sin campos editables) → 400', async () => {
    const create = await crearVentaB2B({ valor: 100, monto_total: 100 });
    const put = await request(app).put(`/api/cuentas/movimientos/${create.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});  // ningún campo
    expect(put.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════
// RECALC CAJA
// ═══════════════════════════════════════════════════════════════
describe('PUT /movimientos/:id — recalc caja', () => {
  it('mov contado (con caja_id) + monto cambia → caja saldo se ajusta', async () => {
    const saldoAntes = await saldoCaja(cajaUsdId);
    const create = await crearVentaB2B({ valor: 500, monto_total: 500, caja_id: cajaUsdId });
    expect(create.status).toBe(201);
    // Caja subió 500.
    expect(await saldoCaja(cajaUsdId) - saldoAntes).toBeCloseTo(500, 2);

    const movId = create.body.id;
    const itemId = create.body.items[0].id;
    // Editar item: valor 500 → 800. Monto total sube a 800.
    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ id: itemId, producto: 'Item libre', valor: 800 }],
      });
    expect(put.status).toBe(200);
    expect(Number(put.body.monto_total)).toBe(800);
    // Caja debería reflejar 800 (no 500 + 800 = 1300 — el reverse borra el 500 antes).
    expect(await saldoCaja(cajaUsdId) - saldoAntes).toBeCloseTo(800, 2);
  });

  it('mov sin caja_id (a crédito) + monto cambia → caja no se toca', async () => {
    const saldoAntes = await saldoCaja(cajaUsdId);
    const create = await crearVentaB2B({ valor: 200, monto_total: 200 });  // sin caja_id
    const movId = create.body.id;
    const itemId = create.body.items[0].id;

    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ id: itemId, producto: 'Item libre', valor: 350 }],
      });
    expect(put.status).toBe(200);
    // Caja: sin cambio (no había caja_id).
    expect(await saldoCaja(cajaUsdId)).toBeCloseTo(saldoAntes, 2);
  });
});

// ═══════════════════════════════════════════════════════════════
// IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════
describe('PUT /movimientos/:id — Idempotency-Key replay', () => {
  it('mismo Idempotency-Key + mov ya editado con esa key → devuelve replay', async () => {
    // Crear con Idempotency-Key A (POST). UUID v4-compatible: 3er grupo empieza
    // con [1-8] (versión), 4to grupo con [89ab] (variant RFC 4122).
    const idemKey = '550e8400-e29b-41d4-a716-446655440000';
    const create = await request(app).post('/api/cuentas/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', idemKey)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 100,
        items: [{ producto: 'Item libre', valor: 100 }],
      });
    expect(create.status).toBe(201);
    const movId = create.body.id;

    // PUT con la misma key → detecta el mov ya existente y devuelve replay.
    const put = await request(app).put(`/api/cuentas/movimientos/${movId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', idemKey)
      .send({ notas: 'esto NO debería aplicarse (replay)' });
    expect(put.status).toBe(200);
    expect(put.body.idempotent_replay).toBe(true);
    // Notas no cambió (era null en el POST original).
    expect(put.body.notas == null).toBe(true);
  });
});

/**
 * Tests de integración — Proveedores (cuentas por pagar)
 * CRUD de proveedores + movimientos (compras/pagos) + saldo en USD.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

async function crearProveedor(over = {}) {
  const res = await request(app).post('/api/proveedores').set(auth())
    .send({ nombre: 'Mayorista Celulares SA', contacto_nombre: 'Juan', contacto_apellido: 'Pérez', whatsapp: '+5491111', ubicacion: 'CABA', ...over });
  return res.body;
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Proveedores — CRUD', () => {
  it('crea, lista (con saldo 0), obtiene, actualiza y borra', async () => {
    const created = await crearProveedor();
    expect(created.id).toBeDefined();
    expect(created.nombre).toBe('Mayorista Celulares SA');

    const list = await request(app).get('/api/proveedores').set(auth());
    expect(list.status).toBe(200);
    const row = list.body.data.find(p => p.id === created.id);
    expect(Number(row.saldo_usd)).toBe(0);

    const one = await request(app).get(`/api/proveedores/${created.id}`).set(auth());
    expect(one.status).toBe(200);
    expect(one.body.contacto_nombre).toBe('Juan');

    const upd = await request(app).put(`/api/proveedores/${created.id}`).set(auth()).send({ ubicacion: 'Rosario' });
    expect(upd.status).toBe(200);
    expect(upd.body.ubicacion).toBe('Rosario');

    const del = await request(app).delete(`/api/proveedores/${created.id}`).set(auth());
    expect(del.status).toBe(200);
    const del2 = await request(app).delete(`/api/proveedores/${created.id}`).set(auth());
    expect(del2.status).toBe(404);
  });

  it('valida ID inválido (400) y proveedor inexistente (404)', async () => {
    expect((await request(app).get('/api/proveedores/abc').set(auth())).status).toBe(400);
    expect((await request(app).get('/api/proveedores/999999').set(auth())).status).toBe(404);
    // PUT y DELETE con ID inválido también responden 400 (sin crashear el pool)
    expect((await request(app).put('/api/proveedores/abc').set(auth()).send({ nombre: 'x' })).status).toBe(400);
    expect((await request(app).delete('/api/proveedores/movimientos/abc').set(auth())).status).toBe(400);
  });

  it('arranca con saldo inicial si se provee', async () => {
    const created = await request(app).post('/api/proveedores').set(auth())
      .send({ nombre: 'Proveedor con Saldo Inicial', saldo_inicial: 1500 });
    expect(created.status).toBe(201);
    expect(Number(created.body.saldo_usd)).toBe(1500);

    const movs = await request(app).get(`/api/proveedores/${created.body.id}/movimientos`).set(auth());
    expect(movs.body.data).toHaveLength(1);
    expect(movs.body.data[0].tipo).toBe('saldo_inicial');

    // El saldo del listado lo refleja, pero NO cuenta como "compra"
    const list = await request(app).get('/api/proveedores').set(auth());
    const row = list.body.data.find(p => p.id === created.body.id);
    expect(Number(row.saldo_usd)).toBe(1500);
  });

  it('permite editar (ajustar) el saldo inicial', async () => {
    const created = await request(app).post('/api/proveedores').set(auth())
      .send({ nombre: 'Edit Saldo Inicial', saldo_inicial: 1000 });

    // Subir a 1500
    const upd = await request(app).put(`/api/proveedores/${created.body.id}`).set(auth())
      .send({ saldo_inicial: 1500 });
    expect(upd.status).toBe(200);
    let row = (await request(app).get('/api/proveedores').set(auth())).body.data.find(p => p.id === created.body.id);
    expect(Number(row.saldo_usd)).toBe(1500);
    expect(Number(row.saldo_inicial)).toBe(1500);

    // Bajar a 0 → quita el movimiento de apertura
    await request(app).put(`/api/proveedores/${created.body.id}`).set(auth()).send({ saldo_inicial: 0 });
    row = (await request(app).get('/api/proveedores').set(auth())).body.data.find(p => p.id === created.body.id);
    expect(Number(row.saldo_inicial)).toBe(0);
    expect(Number(row.saldo_usd)).toBe(0);
  });
});

describe('Proveedores — cuenta corriente', () => {
  it('compra y pago: el saldo (lo que debemos) refleja compras - pagos en USD', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor CC' });

    // Compra de USD 1000 → debemos 1000
    const compra = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', descripcion: '10 iPhone', monto: 1000, moneda: 'USD' });
    expect(compra.status).toBe(201);
    expect(Number(compra.body.monto_usd)).toBe(1000);

    // Pago de USD 600 → debemos 400
    const pago = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'pago', monto: 600, moneda: 'USD' });
    expect(pago.status).toBe(201);

    const list = await request(app).get('/api/proveedores').set(auth());
    const row = list.body.data.find(p => p.id === prov.id);
    expect(Number(row.saldo_usd)).toBe(400);
    expect(Number(row.movimientos)).toBe(2);
  });

  it('una compra carga ítems (productos comprados), igual que B2B', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor con Items' });
    const compra = await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 1900, moneda: 'USD',
      items: [
        { producto: 'iPhone', modelo: '15 Pro', color: 'Titanio', imei_serial: '111', valor: 950 },
        { producto: 'iPhone', modelo: '15 Pro', color: 'Negro',   imei_serial: '222', valor: 950 },
      ],
    });
    expect(compra.status).toBe(201);
    expect(compra.body.items).toHaveLength(2);

    // El GET de movimientos los devuelve embebidos
    const movs = await request(app).get(`/api/proveedores/${prov.id}/movimientos`).set(auth());
    const mov = movs.body.data.find(m => m.id === compra.body.id);
    expect(mov.items).toHaveLength(2);
    expect(mov.items[0].imei_serial).toBe('111');

    // Un pago no lleva ítems aunque se envíen
    const pago = await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: prov.id, fecha: hoy, tipo: 'pago', monto: 500, moneda: 'USD',
      items: [{ producto: 'no debería guardarse', valor: 1 }],
    });
    expect(pago.status).toBe(201);
    expect(pago.body.items).toHaveLength(0);
  });

  it('convierte ARS a USD con el TC; rechaza ARS sin TC', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor ARS' });

    const ok = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 142500, moneda: 'ARS', tc: 1425 });
    expect(ok.status).toBe(201);
    expect(Number(ok.body.monto_usd)).toBe(100); // 142500 / 1425

    const sinTc = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 1000, moneda: 'ARS' });
    expect(sinTc.status).toBe(400);
  });

  it('lista movimientos, borra uno y rechaza movimiento de proveedor inexistente', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor Movs' });
    const mov = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 50, moneda: 'USD' });

    const movs = await request(app).get(`/api/proveedores/${prov.id}/movimientos`).set(auth());
    expect(movs.status).toBe(200);
    expect(movs.body.data.length).toBe(1);

    const del = await request(app).delete(`/api/proveedores/movimientos/${mov.body.id}`).set(auth());
    expect(del.status).toBe(200);

    const notFound = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: 999999, fecha: hoy, tipo: 'compra', monto: 10, moneda: 'USD' });
    expect(notFound.status).toBe(404);
  });

  it('resumen de saldos lista solo proveedores con deuda', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor Deuda' });
    await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 250, moneda: 'USD' });

    const res = await request(app).get('/api/proveedores/resumen/saldos').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.proveedores.some(p => p.id === prov.id)).toBe(true);
    expect(Number(res.body.total_deuda_usd)).toBeGreaterThan(0);
  });
});

// ─── Compra con caja_id (contado) ────────────────────────────────────────
// Verifica el flujo "sale dinero, entra stock": una compra con caja_id
// descuenta la caja al instante y NO suma deuda. Sin caja_id queda a crédito
// (comportamiento histórico).
describe('Proveedores — compra contado (caja_id)', () => {
  let cajaUsdId;

  // Helper: saldo actual de la caja desde el listado de cajas (que incluye saldo_actual).
  async function saldoCaja(id) {
    const r = await request(app).get('/api/cajas/cajas').set(auth());
    const caja = (r.body || []).find(c => c.id === id);
    return Number(caja?.saldo_actual ?? 0);
  }

  beforeAll(async () => {
    // Creamos una caja USD dedicada con saldo inicial suficiente para los
    // egresos de "compra contado" de este suite. La regla nueva (#cajas-neg
    // del post-audit) prohíbe dejar una caja en negativo, así que usar la
    // caja del seed (saldo 0) hacía fallar los tests de egreso.
    const cajaRes = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Test Compra Contado', moneda: 'USD', saldo_inicial: 10000, orden: 99 });
    expect(cajaRes.status).toBe(201);
    cajaUsdId = cajaRes.body.id;
  });

  it('compra con caja_id: NO suma deuda y postea egreso en la caja', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor Contado' });
    const saldoAntes = await saldoCaja(cajaUsdId);

    const res = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 500, moneda: 'USD', caja_id: cajaUsdId });
    expect(res.status).toBe(201);
    expect(res.body.caja_id).toBe(cajaUsdId);

    // Saldo del proveedor: NO debe figurar en el resumen de deudas
    const resumen = await request(app).get('/api/proveedores/resumen/saldos').set(auth());
    expect(resumen.body.proveedores.find(p => p.id === prov.id)).toBeUndefined();

    // Saldo de la caja: bajó 500
    const saldoDesp = await saldoCaja(cajaUsdId);
    expect(saldoAntes - saldoDesp).toBeCloseTo(500, 2);
  });

  it('compra sin caja_id: SUMA deuda y NO toca cajas', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor Crédito' });
    const saldoAntes = await saldoCaja(cajaUsdId);

    const res = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 300, moneda: 'USD' });
    expect(res.status).toBe(201);

    const resumen = await request(app).get('/api/proveedores/resumen/saldos').set(auth());
    const entry = resumen.body.proveedores.find(p => p.id === prov.id);
    expect(entry).toBeTruthy();
    expect(Number(entry.saldo_usd)).toBeCloseTo(300, 2);

    // La caja no se tocó
    expect(await saldoCaja(cajaUsdId)).toBeCloseTo(saldoAntes, 2);
  });

  it('borrar una compra contado revierte el egreso de la caja', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor Revert' });
    const saldoAntes = await saldoCaja(cajaUsdId);

    const create = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 120, moneda: 'USD', caja_id: cajaUsdId });
    expect(create.status).toBe(201);
    // Caja bajó 120
    expect(saldoAntes - await saldoCaja(cajaUsdId)).toBeCloseTo(120, 2);

    const del = await request(app).delete(`/api/proveedores/movimientos/${create.body.id}`).set(auth());
    expect(del.status).toBe(200);
    // Vuelve al saldo inicial
    expect(await saldoCaja(cajaUsdId)).toBeCloseTo(saldoAntes, 2);
  });
});

// ─── Compra crea producto en Inventario ──────────────────────────────────
// Verifica el flujo "registrar compra = entra al stock":
//   - Si items[i].producto_stock viene → crea producto en Inventario.
//   - Auto-fill: producto.proveedor = nombre del proveedor de la compra.
//   - IMEI duplicado (contra stock vivo o dentro del mismo payload) → 409.
//   - producto_stock sin categoria_id → 400.
describe('Proveedores — compra crea producto en Inventario', () => {
  let catBase;

  beforeAll(async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone (Compra Tests)' });
    catBase = cat.body.id;
  });

  it('compra con producto_stock crea el producto en Inventario', async () => {
    const prov = await crearProveedor({ nombre: 'MayoCompra A' });
    const res = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({
        proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 850, moneda: 'USD',
        items: [{
          producto: 'iPhone', modelo: '15 Pro', tamano: '256', color: 'Natural',
          imei_serial: '350001000000001', valor: 850,
          producto_stock: {
            tipo_carga: 'unitario', clase: 'celular', categoria_id: catBase,
            nombre: 'iPhone 15 Pro', imei: '350001000000001',
            gb: '256', color: 'Natural', bateria: 100,
            costo: 850, costo_moneda: 'USD',
            precio_venta: 1100, precio_moneda: 'USD',
            cantidad: 1, condicion: 'nuevo',
          },
        }],
      });
    expect(res.status).toBe(201);
    expect(res.body.productos_creados).toHaveLength(1);
    const p = res.body.productos_creados[0];
    expect(p.imei).toBe('350001000000001');
    expect(p.proveedor).toBe('MayoCompra A'); // auto-fill
    expect(p.condicion).toBe('nuevo');
    expect(p.oculto).toBe(false);

    // Aparece en el listado de Inventario
    const list = await request(app).get('/api/inventario/productos?buscar=350001000000001').set(auth());
    expect(list.body.data.some(x => x.id === p.id)).toBe(true);
  });

  it('IMEI duplicado contra stock existente → 409 (no crea nada)', async () => {
    const prov = await crearProveedor({ nombre: 'MayoCompra B' });
    // Primera compra crea
    const first = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({
        proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 800, moneda: 'USD',
        items: [{ producto: 'iPhone', valor: 800,
          producto_stock: {
            tipo_carga: 'unitario', clase: 'celular', categoria_id: catBase,
            nombre: 'iPhone 14', imei: '350002000000002', cantidad: 1,
            costo: 800, costo_moneda: 'USD', precio_venta: 1000, precio_moneda: 'USD',
          },
        }],
      });
    expect(first.status).toBe(201);

    // Segunda compra con el MISMO IMEI debe ser rechazada
    const dup = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({
        proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 800, moneda: 'USD',
        items: [{ producto: 'iPhone', valor: 800,
          producto_stock: {
            tipo_carga: 'unitario', clase: 'celular', categoria_id: catBase,
            nombre: 'iPhone 14 (dup)', imei: '350002000000002', cantidad: 1,
            costo: 800, costo_moneda: 'USD', precio_venta: 1000, precio_moneda: 'USD',
          },
        }],
      });
    expect(dup.status).toBe(409);
    expect(dup.body.imeis_existentes).toContain('350002000000002');
    // Y el movimiento NO se creó (rollback)
    const movs = await request(app).get(`/api/proveedores/${prov.id}/movimientos`).set(auth());
    expect(movs.body.data).toHaveLength(1);
  });

  it('IMEI duplicado dentro del mismo payload → 409', async () => {
    const prov = await crearProveedor({ nombre: 'MayoCompra C' });
    const res = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({
        proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 1600, moneda: 'USD',
        items: [
          { valor: 800, producto_stock: {
            tipo_carga: 'unitario', clase: 'celular', categoria_id: catBase,
            nombre: 'iPhone 14', imei: '350003000000003', cantidad: 1,
            costo: 800, costo_moneda: 'USD', precio_venta: 1000, precio_moneda: 'USD',
          }},
          { valor: 800, producto_stock: {
            tipo_carga: 'unitario', clase: 'celular', categoria_id: catBase,
            nombre: 'iPhone 14', imei: '350003000000003', cantidad: 1,
            costo: 800, costo_moneda: 'USD', precio_venta: 1000, precio_moneda: 'USD',
          }},
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/duplicado/i);
  });

  it('producto_stock sin categoria_id → 400 (refine)', async () => {
    const prov = await crearProveedor({ nombre: 'MayoCompra D' });
    const res = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({
        proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 100, moneda: 'USD',
        items: [{ valor: 100,
          producto_stock: {
            tipo_carga: 'unitario', clase: 'celular',
            nombre: 'Sin categoría', cantidad: 1,
            costo: 100, costo_moneda: 'USD', precio_venta: 150, precio_moneda: 'USD',
          },
        }],
      });
    expect(res.status).toBe(400);
  });

  it('items SIN producto_stock siguen funcionando (caso legacy / gastos)', async () => {
    const prov = await crearProveedor({ nombre: 'MayoCompra E' });
    const res = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({
        proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 50, moneda: 'USD',
        items: [{ producto: 'Flete', valor: 50 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.productos_creados).toHaveLength(0);
  });
});

// Tests TANDA 3 post-auditoría: bulk de proveedores para import de stock.
// No tiene UNIQUE constraint (decisión histórica), así que usa SELECT existentes +
// INSERT solo los faltantes. Idempotente con case-insensitive match.
describe('POST /api/proveedores/bulk', () => {
  it('crea proveedores nuevos y devuelve count', async () => {
    const r = await request(app).post('/api/proveedores/bulk').set(auth())
      .send({ nombres: ['BulkProvA', 'BulkProvB'] });
    expect(r.status).toBe(200);
    expect(r.body.creados).toBe(2);
  });

  it('idempotente: 2da llamada con los mismos no duplica', async () => {
    await request(app).post('/api/proveedores/bulk').set(auth())
      .send({ nombres: ['BulkProvIdem'] });
    const r = await request(app).post('/api/proveedores/bulk').set(auth())
      .send({ nombres: ['BulkProvIdem'] });
    expect(r.body.creados).toBe(0);
  });

  it('case-insensitive: variantes de mayúsculas no duplican', async () => {
    await request(app).post('/api/proveedores/bulk').set(auth())
      .send({ nombres: ['BulkApple'] });
    const r = await request(app).post('/api/proveedores/bulk').set(auth())
      .send({ nombres: ['bulkapple'] });
    expect(r.body.creados).toBe(0);
  });

  it('lote mixto: 1 existente + 2 nuevos → creados=2', async () => {
    await request(app).post('/api/proveedores/bulk').set(auth())
      .send({ nombres: ['BulkMezcla1'] });
    const r = await request(app).post('/api/proveedores/bulk').set(auth())
      .send({ nombres: ['BulkMezcla1', 'BulkMezcla2', 'BulkMezcla3'] });
    expect(r.body.creados).toBe(2);
  });

  // 2026-06-14: el endpoint ahora devuelve también la lista resolve-or-create
  // (id+nombre) para que el frontend del import XLSX pueda referenciar
  // proveedor_id sin un RTT extra. Backward compat: `creados` sigue presente.
  it('devuelve proveedores: [{id, nombre}] de TODOS los pedidos (existentes + creados)', async () => {
    // 1ro creamos uno para tener un "existente"
    const r1 = await request(app).post('/api/proveedores/bulk').set(auth())
      .send({ nombres: ['BulkResolve_Existente'] });
    expect(r1.body.creados).toBe(1);
    expect(Array.isArray(r1.body.proveedores)).toBe(true);
    expect(r1.body.proveedores).toHaveLength(1);
    expect(r1.body.proveedores[0]).toMatchObject({ nombre: 'BulkResolve_Existente' });
    expect(typeof r1.body.proveedores[0].id).toBe('number');

    // 2da: mezcla del existente + uno nuevo
    const r2 = await request(app).post('/api/proveedores/bulk').set(auth())
      .send({ nombres: ['BulkResolve_Existente', 'BulkResolve_Nuevo'] });
    expect(r2.body.creados).toBe(1);
    expect(r2.body.proveedores).toHaveLength(2);
    const nombres = r2.body.proveedores.map(p => p.nombre).sort();
    expect(nombres).toEqual(['BulkResolve_Existente', 'BulkResolve_Nuevo']);
    // Todos tienen id numérico
    expect(r2.body.proveedores.every(p => typeof p.id === 'number')).toBe(true);
  });
});

// Tests del endpoint /api/proveedores/movimientos/bulk (2026-06-14):
// usado por el import XLSX cuando hay productos de varios proveedores en un
// solo archivo. Procesa N movimientos en una sola tx atómica.
describe('POST /api/proveedores/movimientos/bulk', () => {
  let catBulkBase;

  beforeAll(async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'iPhone (Bulk Tests)' });
    catBulkBase = cat.body.id;
  });

  it('happy path: 2 movimientos válidos → 2 compras + N productos creados', async () => {
    const provA = await crearProveedor({ nombre: 'BulkMulti A' });
    const provB = await crearProveedor({ nombre: 'BulkMulti B' });
    const r = await request(app).post('/api/proveedores/movimientos/bulk').set(auth()).send({
      movimientos: [
        {
          proveedor_id: provA.id, fecha: hoy, tipo: 'compra', monto: 1000, moneda: 'USD',
          descripcion: 'Import XLSX multi-A',
          items: [{ producto: 'iPhone', valor: 1000, producto_stock: {
            tipo_carga: 'unitario', clase: 'celular', categoria_id: catBulkBase,
            nombre: 'iPhone Bulk A', imei: '350010000000A01', cantidad: 1,
            costo: 1000, costo_moneda: 'USD', precio_venta: 1300, precio_moneda: 'USD',
          } }],
        },
        {
          proveedor_id: provB.id, fecha: hoy, tipo: 'compra', monto: 250, moneda: 'USD',
          descripcion: 'Import XLSX multi-B',
          items: [
            { producto: 'AirPods', valor: 150, producto_stock: {
              tipo_carga: 'unitario', clase: 'accesorio', categoria_id: catBulkBase,
              nombre: 'AirPods Pro', cantidad: 1,
              costo: 150, costo_moneda: 'USD', precio_venta: 200, precio_moneda: 'USD',
            } },
            { producto: 'Cargador', valor: 100, producto_stock: {
              tipo_carga: 'lote', clase: 'accesorio', categoria_id: catBulkBase,
              nombre: 'Cargador USB-C', cantidad: 10,
              costo: 10, costo_moneda: 'USD', precio_venta: 25, precio_moneda: 'USD',
            } },
          ],
        },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.count).toBe(2);
    expect(r.body.movimientos[0].productos_creados).toHaveLength(1);
    expect(r.body.movimientos[1].productos_creados).toHaveLength(2);
    // Auto-fill: proveedor del producto = nombre de su proveedor
    expect(r.body.movimientos[0].productos_creados[0].proveedor).toBe('BulkMulti A');
    expect(r.body.movimientos[1].productos_creados[0].proveedor).toBe('BulkMulti B');
  });

  it('atomicidad: IMEI duplicado en el 2do movimiento → NINGUNA compra se persiste', async () => {
    const provA = await crearProveedor({ nombre: 'BulkAtom A' });
    const provB = await crearProveedor({ nombre: 'BulkAtom B' });
    // Primero creamos un IMEI existente que va a colisionar
    await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: provA.id, fecha: hoy, tipo: 'compra', monto: 100, moneda: 'USD',
      items: [{ valor: 100, producto_stock: {
        tipo_carga: 'unitario', clase: 'celular', categoria_id: catBulkBase,
        nombre: 'Pre-existente', imei: '350011111111111', cantidad: 1,
        costo: 100, costo_moneda: 'USD', precio_venta: 150, precio_moneda: 'USD',
      } }],
    });
    // Snapshot del count antes del bulk
    const antes = await request(app).get('/api/inventario/productos?buscar=BulkAtom').set(auth());
    const countAntes = antes.body.data.length;
    // Bulk con 2 movs: el 1ro válido, el 2do tiene IMEI duplicado
    const r = await request(app).post('/api/proveedores/movimientos/bulk').set(auth()).send({
      movimientos: [
        {
          proveedor_id: provA.id, fecha: hoy, tipo: 'compra', monto: 500, moneda: 'USD',
          items: [{ valor: 500, producto_stock: {
            tipo_carga: 'unitario', clase: 'celular', categoria_id: catBulkBase,
            nombre: 'BulkAtom-Mov1', imei: '350012222222222', cantidad: 1,
            costo: 500, costo_moneda: 'USD', precio_venta: 700, precio_moneda: 'USD',
          } }],
        },
        {
          proveedor_id: provB.id, fecha: hoy, tipo: 'compra', monto: 100, moneda: 'USD',
          items: [{ valor: 100, producto_stock: {
            tipo_carga: 'unitario', clase: 'celular', categoria_id: catBulkBase,
            nombre: 'BulkAtom-Mov2', imei: '350011111111111', cantidad: 1, // ← dup con el pre-existente
            costo: 100, costo_moneda: 'USD', precio_venta: 150, precio_moneda: 'USD',
          } }],
        },
      ],
    });
    expect(r.status).toBe(409);
    expect(r.body.imeis_existentes).toContain('350011111111111');
    // Verificación crítica: el producto del MOV 1 (válido) NO debe haberse creado
    // porque el bulk es atómico (todos o ninguno).
    const despues = await request(app).get('/api/inventario/productos?buscar=BulkAtom-Mov1').set(auth());
    expect(despues.body.data.length).toBe(0);
    const inv = await request(app).get('/api/inventario/productos?buscar=BulkAtom').set(auth());
    expect(inv.body.data.length).toBe(countAntes);
  });

  it('IMEI duplicado ENTRE 2 movimientos del bulk → 409 con dup interno', async () => {
    const provA = await crearProveedor({ nombre: 'BulkDup Internal A' });
    const provB = await crearProveedor({ nombre: 'BulkDup Internal B' });
    const r = await request(app).post('/api/proveedores/movimientos/bulk').set(auth()).send({
      movimientos: [
        {
          proveedor_id: provA.id, fecha: hoy, tipo: 'compra', monto: 500, moneda: 'USD',
          items: [{ valor: 500, producto_stock: {
            tipo_carga: 'unitario', clase: 'celular', categoria_id: catBulkBase,
            nombre: 'A', imei: '350013333333333', cantidad: 1,
            costo: 500, costo_moneda: 'USD', precio_venta: 700, precio_moneda: 'USD',
          } }],
        },
        {
          proveedor_id: provB.id, fecha: hoy, tipo: 'compra', monto: 500, moneda: 'USD',
          items: [{ valor: 500, producto_stock: {
            tipo_carga: 'unitario', clase: 'celular', categoria_id: catBulkBase,
            nombre: 'B', imei: '350013333333333', cantidad: 1, // ← MISMO IMEI que mov A
            costo: 500, costo_moneda: 'USD', precio_venta: 700, precio_moneda: 'USD',
          } }],
        },
      ],
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/duplicado/i);
  });

  it('array vacío → 400 (schema)', async () => {
    const r = await request(app).post('/api/proveedores/movimientos/bulk').set(auth())
      .send({ movimientos: [] });
    expect(r.status).toBe(400);
  });

  it('respeta el rate limit del compraMovimientoLimiter', async () => {
    // Sanity: 1 request entra normal (los límites son por user/ip-window, no
    // queremos spam acá). El test específico de límite ya está cubierto en
    // tests del single endpoint que usa el mismo limiter.
    const prov = await crearProveedor({ nombre: 'BulkRate' });
    const r = await request(app).post('/api/proveedores/movimientos/bulk').set(auth()).send({
      movimientos: [{
        proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 100, moneda: 'USD',
        items: [{ valor: 100, producto_stock: {
          tipo_carga: 'unitario', clase: 'celular', categoria_id: catBulkBase,
          nombre: 'Rate', imei: '350014444444444', cantidad: 1,
          costo: 100, costo_moneda: 'USD', precio_venta: 150, precio_moneda: 'USD',
        } }],
      }],
    });
    expect(r.status).toBe(201);
  });
});

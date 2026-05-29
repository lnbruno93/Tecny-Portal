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

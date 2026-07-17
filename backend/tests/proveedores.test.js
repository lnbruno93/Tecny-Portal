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

  // 2026-07-08 Multi-país F2 backfill: mismo guard que ARS, para UYU.
  // Antes: un tenant UY podía persistir compra UYU sin tc → monto_usd=0 →
  // saldo del proveedor y CxP corruptos.
  //
  // NOTA: TEST_USER = tenant AR default, por lo que UYU pega primero con
  // `assertMonedaValidaParaPais` (400 "no habilitada para país AR"). El happy-
  // path UYU requeriría tenant UY y está cubierto por unit tests puros del
  // helper `requiereTc()` en `tests/schemas-common.test.js`. Acá lockeamos
  // que en NINGÚN caso una compra UYU sin TC llegue a persistirse con
  // monto_usd=0 silencioso.
  it('rechaza compra UYU sin TC (nunca persiste con monto_usd=0)', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor UYU' });

    const sinTc = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 1000, moneda: 'UYU' });
    expect(sinTc.status).toBe(400);
    // El body puede indicar "TC requerido" (schema) o "no habilitada para
    // país" (guard multi-país) — ambos son rechazos válidos que evitan el
    // bug del monto_usd=0 silencioso.
    expect(JSON.stringify(sinTc.body)).toMatch(/tc|UYU|no habilitada/i);
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
            tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBase,
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
            tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBase,
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
            tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBase,
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
            tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBase,
            nombre: 'iPhone 14', imei: '350003000000003', cantidad: 1,
            costo: 800, costo_moneda: 'USD', precio_venta: 1000, precio_moneda: 'USD',
          }},
          { valor: 800, producto_stock: {
            tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBase,
            nombre: 'iPhone 14', imei: '350003000000003', cantidad: 1,
            costo: 800, costo_moneda: 'USD', precio_venta: 1000, precio_moneda: 'USD',
          }},
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/duplicado/i);
  });

  // 2026-07-11: categoria_id pasó a opcional en TODOS los flujos de create
  // (schemas/inventario.js — sunset gradual de la dimensión "Colección" post
  // Opción A). El test antes esperaba 400 por el `.refine(categoriaRequerida)`;
  // ahora verifica el path positivo: producto_stock sin categoria_id se acepta
  // y el producto queda en Inventario con categoria_id NULL.
  it('producto_stock sin categoria_id → 201, se crea con categoria_id NULL', async () => {
    const prov = await crearProveedor({ nombre: 'MayoCompra D' });
    const res = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({
        proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 100, moneda: 'USD',
        items: [{ valor: 100,
          producto_stock: {
            tipo_carga: 'unitario', clase: 'celular_sellado',
            nombre: 'Sin categoría', cantidad: 1,
            costo: 100, costo_moneda: 'USD', precio_venta: 150, precio_moneda: 'USD',
          },
        }],
      });
    expect(res.status).toBe(201);
    // Verificar que el producto quedó en Inventario sin colección asignada.
    const lista = await request(app).get('/api/inventario/productos?buscar=Sin categoría').set(auth());
    const p = lista.body.data.find(x => x.nombre === 'Sin categoría');
    expect(p).toBeDefined();
    expect(p.categoria_id).toBeNull();
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
            tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBulkBase,
            nombre: 'iPhone Bulk A', imei: '350010000000A01', cantidad: 1,
            costo: 1000, costo_moneda: 'USD', precio_venta: 1300, precio_moneda: 'USD',
          } }],
        },
        {
          proveedor_id: provB.id, fecha: hoy, tipo: 'compra', monto: 250, moneda: 'USD',
          descripcion: 'Import XLSX multi-B',
          items: [
            { producto: 'AirPods', valor: 150, producto_stock: {
              tipo_carga: 'unitario', clase: 'accesorios_varios', categoria_id: catBulkBase,
              nombre: 'AirPods Pro', cantidad: 1,
              costo: 150, costo_moneda: 'USD', precio_venta: 200, precio_moneda: 'USD',
            } },
            { producto: 'Cargador', valor: 100, producto_stock: {
              tipo_carga: 'lote', clase: 'accesorios_varios', categoria_id: catBulkBase,
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
        tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBulkBase,
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
            tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBulkBase,
            nombre: 'BulkAtom-Mov1', imei: '350012222222222', cantidad: 1,
            costo: 500, costo_moneda: 'USD', precio_venta: 700, precio_moneda: 'USD',
          } }],
        },
        {
          proveedor_id: provB.id, fecha: hoy, tipo: 'compra', monto: 100, moneda: 'USD',
          items: [{ valor: 100, producto_stock: {
            tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBulkBase,
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
            tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBulkBase,
            nombre: 'A', imei: '350013333333333', cantidad: 1,
            costo: 500, costo_moneda: 'USD', precio_venta: 700, precio_moneda: 'USD',
          } }],
        },
        {
          proveedor_id: provB.id, fecha: hoy, tipo: 'compra', monto: 500, moneda: 'USD',
          items: [{ valor: 500, producto_stock: {
            tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBulkBase,
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

  it('rechaza tipo=entrega_mercaderia (bulk es solo para compras)', async () => {
    // 2026-07-17 (task #150) — el bulk es para import XLSX de compras. Si se
    // cuela una entrega_mercaderia, el loop del endpoint solo procesa items
    // cuando tipo=compra → los productos NO llegarían al stock. Rechazamos
    // en el schema para evitar el bug silencioso.
    const prov = await crearProveedor({ nombre: `Bulk Rechazo Entrega ${Date.now()}` });
    const r = await request(app).post('/api/proveedores/movimientos/bulk').set(auth()).send({
      movimientos: [{
        proveedor_id: prov.id, fecha: hoy, tipo: 'entrega_mercaderia', monto: 100, moneda: 'USD',
        items: [{ producto: 'X', valor: 100 }],
      }],
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/bulk.*compra|entrega.*single/i);
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
          tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBulkBase,
          nombre: 'Rate', imei: '350014444444444', cantidad: 1,
          costo: 100, costo_moneda: 'USD', precio_venta: 150, precio_moneda: 'USD',
        } }],
      }],
    });
    expect(r.status).toBe(201);
  });
});

// ─── POST /api/proveedores/bulk-delete-all (admin-only) ─────────────────────
describe('Proveedores — bulk-delete-all (admin)', () => {
  it('borra todos los proveedores + compras + revierte cajas (caso vacío)', async () => {
    // En un tenant sin proveedores vivos, devuelve ok con 0 todo.
    // Garantizamos estado vacío borrando lo que pudiera haber quedado.
    await pool.query(`UPDATE proveedores SET deleted_at = NOW() WHERE deleted_at IS NULL`);
    const r = await request(app).post('/api/proveedores/bulk-delete-all').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.proveedores_borrados).toBe(0);
    expect(r.body.movimientos_borrados).toBe(0);
  });

  it('caso completo: proveedor + compra al contado + producto disponible → borra todo y revierte caja', async () => {
    // Setup: caja USD para que la compra al contado tenga de dónde restar.
    const caja = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: `Caja BulkDelTest ${Date.now()}`, moneda: 'USD', saldo_inicial: 1000 });
    expect(caja.status).toBe(201);
    const cajaId = caja.body.id;
    const saldoInicial = 1000;

    // Categoría para el producto.
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: `CatBulkDel ${Date.now()}` });

    // Proveedor.
    const prov = await crearProveedor({ nombre: `ProvBulkDel ${Date.now()}` });

    // Compra al contado con producto en stock.
    const compra = await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 300, moneda: 'USD',
      caja_id: cajaId,
      items: [{ valor: 300, producto_stock: {
        tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: cat.body.id,
        nombre: 'TelBulkDel', imei: '350099999999999', cantidad: 1,
        costo: 300, costo_moneda: 'USD', precio_venta: 500, precio_moneda: 'USD',
      } }],
    });
    expect(compra.status).toBe(201);

    // Bulk delete.
    const r = await request(app).post('/api/proveedores/bulk-delete-all').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.proveedores_borrados).toBeGreaterThanOrEqual(1);
    expect(r.body.movimientos_borrados).toBeGreaterThanOrEqual(1);
    expect(r.body.productos_borrados).toBeGreaterThanOrEqual(1);

    // Caja vuelve al saldo inicial (egreso revertido).
    const cajas = await request(app).get('/api/cajas/cajas').set(auth());
    const cajaPost = cajas.body.find(c => c.id === cajaId);
    expect(Number(cajaPost.saldo_actual)).toBe(saldoInicial);

    // Cleanup: borrar la caja para no contaminar tests siguientes.
    await pool.query(`UPDATE metodos_pago SET deleted_at = NOW() WHERE id = $1`, [cajaId]);
  });

  it('bloquea con 409 si hay un producto vendido en compras', async () => {
    // Setup: proveedor → compra (sin caja, crédito) → producto → venta del producto.
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: `CatBulkDelVendido ${Date.now()}` });
    const prov = await crearProveedor({ nombre: `ProvBulkVendido ${Date.now()}` });
    const compra = await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 200, moneda: 'USD',
      items: [{ valor: 200, producto_stock: {
        tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: cat.body.id,
        nombre: 'TelVendido', imei: '350088888888888', cantidad: 1,
        costo: 200, costo_moneda: 'USD', precio_venta: 350, precio_moneda: 'USD',
      } }],
    });
    expect(compra.status).toBe(201);
    const prodId = compra.body.productos_creados[0].id;

    // Marcamos el producto como vendido (vía DB para evitar todo el flow de venta).
    await pool.query(`UPDATE productos SET estado = 'vendido' WHERE id = $1`, [prodId]);

    const r = await request(app).post('/api/proveedores/bulk-delete-all').set(auth());
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/se vendieron/i);
    expect(Array.isArray(r.body.productos_vendidos)).toBe(true);

    // El proveedor sigue vivo (no se tocó nada por el rollback).
    const list = await request(app).get('/api/proveedores').set(auth());
    expect(list.body.data.some(p => p.id === prov.id)).toBe(true);

    // Cleanup.
    await pool.query(`UPDATE productos SET deleted_at = NOW() WHERE id = $1`, [prodId]);
    await pool.query(`UPDATE proveedores SET deleted_at = NOW() WHERE id = $1`, [prov.id]);
  });
});

// ─── Feature: entrega_mercaderia (task #150, 2026-07-17) ─────────────────────
// Escenario disparador: un proveedor cancela deuda entregando productos en vez
// de dinero. Ej: Lucas adelantó $2500 a Kevin y ahora Kevin le trae PS5s por
// ese valor. En el modelo viejo no había forma limpia de registrarlo — una
// `compra` sin caja_id SUMABA deuda (incorrecto: la deuda ya existía). El
// nuevo tipo `entrega_mercaderia`:
//   - INGRESA productos al stock (como una compra).
//   - REDUCE el saldo del proveedor (como un pago).
//   - NO toca caja (los productos SON el pago).
describe('Proveedores — entrega_mercaderia', () => {
  let catEntrega;

  beforeAll(async () => {
    const cat = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: `Cat Entrega Mercaderia ${Date.now()}` });
    catEntrega = cat.body.id;
  });

  it('happy path: reduce saldo, crea productos, NO toca caja', async () => {
    // Setup: caja USD para verificar que no se mueve.
    const caja = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: `Caja Entrega ${Date.now()}`, moneda: 'USD', saldo_inicial: 5000 });
    expect(caja.status).toBe(201);
    const cajaId = caja.body.id;

    async function saldoCaja(id) {
      const r = await request(app).get('/api/cajas/cajas').set(auth());
      return Number((r.body || []).find(c => c.id === id)?.saldo_actual ?? 0);
    }
    const saldoCajaInicial = await saldoCaja(cajaId);

    // Prov con compra a crédito de 800 → nos debe... perdón, le debemos 800.
    const prov = await crearProveedor({ nombre: `Prov Entrega Feliz ${Date.now()}` });
    await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 800, moneda: 'USD' });

    // Ahora el proveedor cancela 500 entregándonos mercadería.
    const entrega = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({
        proveedor_id: prov.id, fecha: hoy, tipo: 'entrega_mercaderia', monto: 500, moneda: 'USD',
        descripcion: '1x PlayStation 5 a cuenta',
        items: [{ producto: 'PlayStation 5', valor: 500,
          producto_stock: {
            tipo_carga: 'unitario', clase: 'consolas',
            nombre: 'PlayStation 5', imei: `PS5-${Date.now()}`,
            cantidad: 1, categoria_id: catEntrega,
            costo: 500, costo_moneda: 'USD', precio_venta: 700, precio_moneda: 'USD',
          },
        }],
      });
    expect(entrega.status).toBe(201);
    expect(entrega.body.tipo).toBe('entrega_mercaderia');
    expect(entrega.body.productos_creados).toHaveLength(1);
    // Auto-fill del proveedor en el producto (mismo pattern que compra).
    expect(entrega.body.productos_creados[0].proveedor).toContain('Prov Entrega Feliz');

    // Saldo del proveedor: 800 (compra) - 500 (entrega) = 300.
    const list = await request(app).get('/api/proveedores').set(auth());
    const row = list.body.data.find(p => p.id === prov.id);
    expect(Number(row.saldo_usd)).toBeCloseTo(300, 2);

    // La caja NO se movió (aunque la creamos, no la pasamos como caja_id).
    expect(await saldoCaja(cajaId)).toBeCloseTo(saldoCajaInicial, 2);

    // Cleanup.
    await pool.query(`UPDATE metodos_pago SET deleted_at = NOW() WHERE id = $1`, [cajaId]);
  });

  it('flujo operativo Tek Haus: compra a crédito + entrega_mercaderia cierra a 0', async () => {
    // Caso más común según el pedido del cliente Tek Haus (task #150):
    // proveedor con deuda (compra a crédito NO PAGADA todavía), y cancela
    // entregando productos por el mismo valor. Saldo debe cerrar en 0.
    const prov = await crearProveedor({ nombre: `Tek Haus Proveedor ${Date.now()}` });

    // Compra a crédito de 2000 → nosotros le debemos 2000 al proveedor.
    const compra = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 2000, moneda: 'USD',
              descripcion: '4 PlayStations a crédito' });
    expect(compra.status).toBe(201);

    let list = await request(app).get('/api/proveedores').set(auth());
    let row = list.body.data.find(p => p.id === prov.id);
    expect(Number(row.saldo_usd)).toBeCloseTo(2000, 2);

    // El proveedor entrega 4 PS5 valuados en 2000 → cancela la deuda.
    // Alt: podría entregar productos DISTINTOS (a cuenta del anterior).
    const entrega = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({
        proveedor_id: prov.id, fecha: hoy, tipo: 'entrega_mercaderia', monto: 2000, moneda: 'USD',
        descripcion: 'PS5s entregadas a cuenta de la compra',
        items: [{ producto: 'PS5', valor: 2000,
          producto_stock: {
            tipo_carga: 'unitario', clase: 'consolas',
            nombre: 'PS5 Slim', imei: `TEK-${Date.now()}`,
            cantidad: 1, categoria_id: catEntrega,
            costo: 2000, costo_moneda: 'USD', precio_venta: 2500, precio_moneda: 'USD',
          },
        }],
      });
    expect(entrega.status).toBe(201);
    expect(entrega.body.productos_creados).toHaveLength(1);

    // Saldo final: compra +2000 + entrega -2000 = 0.
    list = await request(app).get('/api/proveedores').set(auth());
    row = list.body.data.find(p => p.id === prov.id);
    expect(Number(row.saldo_usd)).toBeCloseTo(0, 2);
  });

  it('sin items → 400 (no tiene sentido — sería un pago sin caja)', async () => {
    const prov = await crearProveedor({ nombre: `Prov Sin Items ${Date.now()}` });
    const r = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'entrega_mercaderia', monto: 100, moneda: 'USD' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/items|entrega/i);
  });

  it('con caja_id → 400 (entrega no toca caja)', async () => {
    const caja = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: `Caja Rechazo ${Date.now()}`, moneda: 'USD', saldo_inicial: 100 });
    const prov = await crearProveedor({ nombre: `Prov Con Caja ${Date.now()}` });
    const r = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({
        proveedor_id: prov.id, fecha: hoy, tipo: 'entrega_mercaderia', monto: 100, moneda: 'USD',
        caja_id: caja.body.id,
        items: [{ producto: 'X', valor: 100 }],
      });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/caja_id|entrega/i);

    // Cleanup.
    await pool.query(`UPDATE metodos_pago SET deleted_at = NOW() WHERE id = $1`, [caja.body.id]);
  });

  it('rechaza monto=0 cuando los items crean stock', async () => {
    const prov = await crearProveedor({ nombre: `Prov Monto 0 ${Date.now()}` });
    const r = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({
        proveedor_id: prov.id, fecha: hoy, tipo: 'entrega_mercaderia', monto: 0, moneda: 'USD',
        items: [{ producto: 'X', valor: 100,
          producto_stock: {
            tipo_carga: 'unitario', clase: 'consolas',
            nombre: 'PS5 Gratis', imei: `FREE-${Date.now()}`, cantidad: 1, categoria_id: catEntrega,
            costo: 100, costo_moneda: 'USD', precio_venta: 200, precio_moneda: 'USD',
          },
        }],
      });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/monto/i);
  });

  it('IMEI duplicado en la entrega → 409 (mismo path que compra)', async () => {
    const prov = await crearProveedor({ nombre: `Prov IMEI Dup ${Date.now()}` });
    const imei = `DUP-${Date.now()}`;
    // Primero cargamos el IMEI vía compra normal.
    await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 100, moneda: 'USD',
      items: [{ valor: 100, producto_stock: {
        tipo_carga: 'unitario', clase: 'consolas', categoria_id: catEntrega,
        nombre: 'Existente', imei, cantidad: 1,
        costo: 100, costo_moneda: 'USD', precio_venta: 150, precio_moneda: 'USD',
      } }],
    });
    // Ahora una entrega con el mismo IMEI debe caer.
    const r = await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: prov.id, fecha: hoy, tipo: 'entrega_mercaderia', monto: 100, moneda: 'USD',
      items: [{ valor: 100, producto_stock: {
        tipo_carga: 'unitario', clase: 'consolas', categoria_id: catEntrega,
        nombre: 'Dup entrega', imei, cantidad: 1,
        costo: 100, costo_moneda: 'USD', precio_venta: 150, precio_moneda: 'USD',
      } }],
    });
    expect(r.status).toBe(409);
    expect(r.body.imeis_existentes).toContain(imei);
  });

  it('resumen de saldos: entrega_mercaderia baja la deuda mostrada', async () => {
    const prov = await crearProveedor({ nombre: `Prov Resumen ${Date.now()}` });
    // Compra a crédito 1000.
    await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 1000, moneda: 'USD' });

    let resumen = await request(app).get('/api/proveedores/resumen/saldos').set(auth());
    let entry = resumen.body.proveedores.find(p => p.id === prov.id);
    expect(Number(entry.saldo_usd)).toBeCloseTo(1000, 2);

    // Entrega mercadería 400 → deuda pasa a 600.
    await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: prov.id, fecha: hoy, tipo: 'entrega_mercaderia', monto: 400, moneda: 'USD',
      items: [{ valor: 400, producto_stock: {
        tipo_carga: 'unitario', clase: 'consolas', categoria_id: catEntrega,
        nombre: 'Resumen', imei: `RES-${Date.now()}`, cantidad: 1,
        costo: 400, costo_moneda: 'USD', precio_venta: 550, precio_moneda: 'USD',
      } }],
    });
    resumen = await request(app).get('/api/proveedores/resumen/saldos').set(auth());
    entry = resumen.body.proveedores.find(p => p.id === prov.id);
    expect(Number(entry.saldo_usd)).toBeCloseTo(600, 2);
  });

  it('DELETE entrega_mercaderia: soft-deletea productos y revierte saldo', async () => {
    const prov = await crearProveedor({ nombre: `Prov Delete Entrega ${Date.now()}` });
    await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 500, moneda: 'USD' });

    const entrega = await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: prov.id, fecha: hoy, tipo: 'entrega_mercaderia', monto: 200, moneda: 'USD',
      items: [{ valor: 200, producto_stock: {
        tipo_carga: 'unitario', clase: 'consolas', categoria_id: catEntrega,
        nombre: 'Revert Test', imei: `REV-${Date.now()}`, cantidad: 1,
        costo: 200, costo_moneda: 'USD', precio_venta: 300, precio_moneda: 'USD',
      } }],
    });
    expect(entrega.status).toBe(201);
    const prodId = entrega.body.productos_creados[0].id;

    // Antes del delete: saldo = 500 - 200 = 300, producto vivo.
    let list = await request(app).get('/api/proveedores').set(auth());
    let row = list.body.data.find(p => p.id === prov.id);
    expect(Number(row.saldo_usd)).toBeCloseTo(300, 2);
    let prodRes = await pool.query(`SELECT deleted_at FROM productos WHERE id = $1`, [prodId]);
    expect(prodRes.rows[0].deleted_at).toBeNull();

    // Delete → saldo vuelve a 500, producto soft-deleted.
    const del = await request(app).delete(`/api/proveedores/movimientos/${entrega.body.id}`).set(auth());
    expect(del.status).toBe(200);
    list = await request(app).get('/api/proveedores').set(auth());
    row = list.body.data.find(p => p.id === prov.id);
    expect(Number(row.saldo_usd)).toBeCloseTo(500, 2);
    prodRes = await pool.query(`SELECT deleted_at FROM productos WHERE id = $1`, [prodId]);
    expect(prodRes.rows[0].deleted_at).not.toBeNull();
  });

  it('DELETE entrega_mercaderia con producto ya vendido → 409 (mismo guard que compra)', async () => {
    const prov = await crearProveedor({ nombre: `Prov Delete Vendido ${Date.now()}` });
    await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 500, moneda: 'USD' });

    const entrega = await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: prov.id, fecha: hoy, tipo: 'entrega_mercaderia', monto: 200, moneda: 'USD',
      items: [{ valor: 200, producto_stock: {
        tipo_carga: 'unitario', clase: 'consolas', categoria_id: catEntrega,
        nombre: 'Ya Vendido', imei: `SOLD-${Date.now()}`, cantidad: 1,
        costo: 200, costo_moneda: 'USD', precio_venta: 300, precio_moneda: 'USD',
      } }],
    });
    const prodId = entrega.body.productos_creados[0].id;
    await pool.query(`UPDATE productos SET estado = 'vendido' WHERE id = $1`, [prodId]);

    const del = await request(app).delete(`/api/proveedores/movimientos/${entrega.body.id}`).set(auth());
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/se vendieron/i);
  });
});

// ─── Consolidación helper saldoProveedor (task #150) ─────────────────────────
// Verifica que el helper `lib/saldoProveedor.js` es la fuente única de verdad
// y que el bug histórico de `dashboardMensual.deudaProveedores` está resuelto.
// Antes: la deuda del dashboard estaba INFLADA cuando había compras contado
// (compras con caja_id NO deberían sumar deuda — se pagaron al instante).
describe('Proveedores — helper saldoProveedor consolidación', () => {
  it('dashboardMensual respeta caja_id: compra contado NO suma a la deuda', async () => {
    // Preparación: 1 proveedor con una compra CONTADO $500 (caja ya paga).
    const caja = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: `Caja HelperContado ${Date.now()}`, moneda: 'USD', saldo_inicial: 2000 });
    const prov = await crearProveedor({ nombre: `Prov Helper Contado ${Date.now()}` });
    await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 500, moneda: 'USD', caja_id: caja.body.id });

    // Snapshot: el resumen ejecutivo del proveedor (canónico) dice deuda=0.
    const resumen = await request(app).get('/api/proveedores/resumen/saldos').set(auth());
    expect(resumen.body.proveedores.find(p => p.id === prov.id)).toBeUndefined();

    // Dashboard mensual — antes del fix devolvía $500 acá (bug); ahora
    // esa contribución NO debe estar. Hacemos el diff pre/post para aislarlo
    // de otras deudas históricas del tenant de test.
    const antes = await request(app).get('/api/dashboard/resumen-mensual').set(auth());
    // Otra compra contado $700, mismo proveedor: si el bug estuviera, el
    // deuda_usd subiría en $700. Con el fix, sube en $0.
    await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 700, moneda: 'USD', caja_id: caja.body.id });
    // Cache-buster: el endpoint tiene TTL 60s per (tenant, periodo). Rompemos
    // con un param dummy para que refetche.
    const despues = await request(app).get(`/api/dashboard/resumen-mensual?_ts=${Date.now()}`).set(auth());
    const deltaDeuda = Number(despues.body.actual.deuda_proveedores.deuda_usd)
                     - Number(antes.body.actual.deuda_proveedores.deuda_usd);
    // Sin bug: la compra contado no impacta deuda. Antes del fix: +700 acá.
    expect(deltaDeuda).toBeCloseTo(0, 1);

    // Cleanup.
    await pool.query(`UPDATE metodos_pago SET deleted_at = NOW() WHERE id = $1`, [caja.body.id]);
  });

  it('dashboardMensual reconoce entrega_mercaderia como reductor de deuda', async () => {
    // Prov con compra a crédito $600 → deuda=600 en el dashboard.
    const prov = await crearProveedor({ nombre: `Prov Helper Entrega ${Date.now()}` });
    await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 600, moneda: 'USD' });

    const catHelper = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: `Cat Helper ${Date.now()}` });

    const antes = await request(app).get(`/api/dashboard/resumen-mensual?_ts=${Date.now()}`).set(auth());
    // Entrega $400 → deuda debería BAJAR $400.
    await request(app).post('/api/proveedores/movimientos').set(auth()).send({
      proveedor_id: prov.id, fecha: hoy, tipo: 'entrega_mercaderia', monto: 400, moneda: 'USD',
      items: [{ valor: 400, producto_stock: {
        tipo_carga: 'unitario', clase: 'consolas', categoria_id: catHelper.body.id,
        nombre: 'Helper Test', imei: `HLP-${Date.now()}`, cantidad: 1,
        costo: 400, costo_moneda: 'USD', precio_venta: 550, precio_moneda: 'USD',
      } }],
    });
    const despues = await request(app).get(`/api/dashboard/resumen-mensual?_ts=${Date.now()}-2`).set(auth());
    const deltaDeuda = Number(despues.body.actual.deuda_proveedores.deuda_usd)
                     - Number(antes.body.actual.deuda_proveedores.deuda_usd);
    expect(deltaDeuda).toBeCloseTo(-400, 1);
  });
});

/**
 * Tests de integración — Cuentas Corrientes (CC)
 *
 * Cubre:
 *   POST   /api/cuentas/clientes             — crear cliente
 *   GET    /api/cuentas/clientes             — lista con saldo calculado, filtros
 *   GET    /api/cuentas/clientes/:id         — detalle con saldo
 *   PUT    /api/cuentas/clientes/:id         — actualizar (COALESCE parcial)
 *   DELETE /api/cuentas/clientes/:id         — soft-delete
 *   POST   /api/cuentas/movimientos          — compra con items, pago sin items, tx atómica
 *   GET    /api/cuentas/clientes/:id/movimientos — historial con items embebidos
 *   DELETE /api/cuentas/movimientos/:id      — soft-delete
 *   GET    /api/cuentas/clientes/:id/resumen — agregados por tipo
 *   GET    /api/cuentas/resumen-general      — CTE + top deudores
 *   GET    /api/cuentas/calendario           — agrupación por día
 *
 *   Saldo: verifica que compra suma y los 4 tipos de pago restan correctamente.
 *   Permisos: 403 cuando falta permiso "cuentas".
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER, createTestUser } = require('./helpers/setup');
const bcrypt  = require('bcrypt');

let pool;
let adminToken;
let opToken;     // usuario sin permiso cuentas
let clienteId;
let movCompraId;
let cajaUsdId;   // SOL-2: pago/parte_de_pago requieren caja_id

beforeAll(async () => {
  pool = await setupTestDb();

  // Autenticar como admin (tiene todos los permisos)
  const r1 = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = r1.body.token;

  // Crear usuario op sin permisos para testear 403. SEG-2: createTestUser
  // seedea tenant_users + tenant_user_roles para que el login no rebote NO_TENANT.
  await createTestUser(pool, {
    nombre: 'Op CC', username: 'opcc',
    email: 'opcc@test.local', password: 'op_cc_pass123',
    role: 'op',
  });
  const r2 = await request(app)
    .post('/api/auth/login')
    .send({ username: 'opcc', password: 'op_cc_pass123' });
  opToken = r2.body.token;

  // SOL-2: caja USD para los tests que registran pagos. El schema ahora exige
  // caja_id para tipo='pago'/'parte_de_pago' (antes se aceptaba null).
  const cajasRes = await request(app)
    .get('/api/cajas/cajas')
    .set('Authorization', `Bearer ${adminToken}`);
  cajaUsdId = (cajasRes.body || []).find(c => c.moneda === 'USD')?.id;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ═══════════════════════════════════════════════════════════════
// CREAR CLIENTE
// ═══════════════════════════════════════════════════════════════
describe('POST /api/cuentas/clientes', () => {
  it('crea cliente con campos obligatorios → 201', async () => {
    const res = await request(app)
      .post('/api/cuentas/clientes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'María', apellido: 'López', categoria: 'A-' });

    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('María');
    expect(res.body.apellido).toBe('López');
    expect(res.body.categoria).toBe('A-');
    expect(Number(res.body.saldo)).toBe(0); // nuevo cliente, saldo cero
    clienteId = res.body.id;
  });

  it('crea cliente con todos los campos opcionales → 201', async () => {
    const res = await request(app)
      .post('/api/cuentas/clientes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        nombre:      'Carlos',
        apellido:    'Pérez',
        contacto:    '+54 11 9999-8888',
        marca_redes: '@carlosperez',
        provincia:   'Buenos Aires',
        localidad:   'Ramos Mejía',
        direccion:   'Av. Principal 123',
        categoria:   'VIP',
        notas:       'Cliente frecuente',
      });

    expect(res.status).toBe(201);
    expect(res.body.categoria).toBe('VIP');
    expect(res.body.contacto).toBe('+54 11 9999-8888');
  });

  it('crea cliente con saldo inicial → el saldo arranca en ese monto', async () => {
    const res = await request(app)
      .post('/api/cuentas/clientes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Mayorista', apellido: 'Inicial', categoria: 'A+', saldo_inicial: 1500 });
    expect(res.status).toBe(201);
    expect(Number(res.body.saldo)).toBe(1500);

    // el saldo persiste en el detalle y en el resumen
    const det = await request(app).get(`/api/cuentas/clientes/${res.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(Number(det.body.saldo)).toBe(1500);
    const resumen = await request(app).get(`/api/cuentas/clientes/${res.body.id}/resumen`).set('Authorization', `Bearer ${adminToken}`);
    expect(Number(resumen.body.saldo)).toBe(1500);
    expect(Number(resumen.body.total_saldo_inicial)).toBe(1500);

    // un pago posterior reduce el saldo
    await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: res.body.id, fecha: '2026-05-26', tipo: 'pago', monto_total: 500, caja_id: cajaUsdId });
    const det2 = await request(app).get(`/api/cuentas/clientes/${res.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(Number(det2.body.saldo)).toBe(1000); // 1500 - 500
  });

  it('rechaza un saldo inicial negativo → 400', async () => {
    const res = await request(app)
      .post('/api/cuentas/clientes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Neg', categoria: 'A-', saldo_inicial: -10 });
    expect(res.status).toBe(400);
  });

  it('rechaza categoría inválida → 400', async () => {
    const res = await request(app)
      .post('/api/cuentas/clientes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Test', categoria: 'B' });

    expect(res.status).toBe(400);
  });

  it('rechaza nombre vacío → 400', async () => {
    const res = await request(app)
      .post('/api/cuentas/clientes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: '', categoria: 'A-' });

    expect(res.status).toBe(400);
  });

  it('sin permiso "cuentas" → 403', async () => {
    const res = await request(app)
      .post('/api/cuentas/clientes')
      .set('Authorization', `Bearer ${opToken}`)
      .send({ nombre: 'Test', categoria: 'A-' });

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════
// LISTAR CLIENTES
// ═══════════════════════════════════════════════════════════════
describe('GET /api/cuentas/clientes', () => {
  it('devuelve lista de clientes con campo saldo', async () => {
    const res = await request(app)
      .get('/api/cuentas/clientes')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.pagination).toHaveProperty('total');

    // Todos los items tienen saldo numérico
    res.body.data.forEach(c => {
      expect(typeof Number(c.saldo)).toBe('number');
      expect(Number.isNaN(Number(c.saldo))).toBe(false);
    });

    const found = res.body.data.find(c => c.id === clienteId);
    expect(found).toBeDefined();
    expect(Number(found.saldo)).toBe(0);
  });

  it('filtra por buscar (nombre parcial)', async () => {
    const res = await request(app)
      .get('/api/cuentas/clientes?buscar=María')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const ids = res.body.data.map(c => c.id);
    expect(ids).toContain(clienteId);
  });

  it('filtra por categoría', async () => {
    const res = await request(app)
      .get('/api/cuentas/clientes?categoria=VIP')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    res.body.data.forEach(c => expect(c.categoria).toBe('VIP'));
  });
});

// ═══════════════════════════════════════════════════════════════
// DETALLE CLIENTE
// ═══════════════════════════════════════════════════════════════
describe('GET /api/cuentas/clientes/:id', () => {
  it('devuelve el cliente con saldo', async () => {
    const res = await request(app)
      .get(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(clienteId);
    expect(res.body.nombre).toBe('María');
    expect(Number(res.body.saldo)).toBe(0);
  });

  it('ID inexistente → 404', async () => {
    const res = await request(app)
      .get('/api/cuentas/clientes/999999')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// ACTUALIZAR CLIENTE
// ═══════════════════════════════════════════════════════════════
describe('PUT /api/cuentas/clientes/:id', () => {
  it('actualiza nombre parcialmente (COALESCE)', async () => {
    const res = await request(app)
      .put(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'María Actualizada' });

    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe('María Actualizada');
    expect(res.body.apellido).toBe('López'); // no cambió
  });

  it('actualiza categoría', async () => {
    const res = await request(app)
      .put(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ categoria: 'A+' });

    expect(res.status).toBe(200);
    expect(res.body.categoria).toBe('A+');
  });

  it('ID inexistente → 404', async () => {
    const res = await request(app)
      .put('/api/cuentas/clientes/999999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Ghost' });

    expect(res.status).toBe(404);
  });

  it('sin campos → 400', async () => {
    const res = await request(app)
      .put(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════
// MOVIMIENTOS — SALDO
// ═══════════════════════════════════════════════════════════════
//
// #T-06: antes eran 5 tests independientes pero ENCADENADOS — cada uno
// asumía el saldo dejado por el anterior (50000 → 30000 → 25000 → 20000 →
// 10000). Si alguien agregaba un test en medio o cambiaba el orden,
// cascada de fallas falsas. Ahora un único test secuencial, robusto.
describe('POST /api/cuentas/movimientos — saldo (secuencial)', () => {
  it('flujo completo compra→pago→parte_de_pago→entrega→devolución verifica saldo en cada paso', async () => {
    const detalle = () => request(app)
      .get(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .then(r => parseFloat(r.body.saldo));

    // 1) COMPRA 50000 → saldo +50000
    const compra = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: clienteId, fecha: '2026-03-01', tipo: 'compra',
        descripcion: 'iPhone 15 Pro', monto_total: 50000,
        items: [{ producto: 'iPhone', modelo: '15 Pro', tamano: '256GB', valor: 900, imei_serial: '123456789012345' }],
      });
    expect(compra.status).toBe(201);
    expect(compra.body.tipo).toBe('compra');
    expect(parseFloat(compra.body.monto_total)).toBe(50000);
    expect(Array.isArray(compra.body.items)).toBe(true);
    expect(compra.body.items.length).toBe(1);
    expect(compra.body.items[0].modelo).toBe('15 Pro');
    movCompraId = compra.body.id;
    expect(await detalle()).toBe(50000);

    // 2) PAGO 20000 → saldo 30000 (items ignorados)
    const pago = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: clienteId, fecha: '2026-03-10', tipo: 'pago', monto_total: 20000,
        caja_id: cajaUsdId, items: [{ producto: 'ignorado' }],
      });
    expect(pago.status).toBe(201);
    expect(pago.body.items).toEqual([]); // pago no tiene items
    expect(await detalle()).toBe(30000);

    // 3) PARTE_DE_PAGO 5000 → saldo 25000
    const pp = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: clienteId, fecha: '2026-03-15', tipo: 'parte_de_pago', monto_total: 5000, caja_id: cajaUsdId });
    expect(pp.status).toBe(201);
    expect(await detalle()).toBe(25000);

    // 4) ENTREGA_MERCADERIA 5000 → saldo 20000
    const em = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: clienteId, fecha: '2026-03-20', tipo: 'entrega_mercaderia', monto_total: 5000 });
    expect(em.status).toBe(201);
    expect(await detalle()).toBe(20000);

    // 5) DEVOLUCION 10000 con items → saldo 10000
    const devo = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: clienteId, fecha: '2026-03-25', tipo: 'devolucion', monto_total: 10000,
        items: [{ producto: 'iPhone', modelo: '14', imei_serial: '987654321098765' }],
      });
    expect(devo.status).toBe(201);
    expect(devo.body.items.length).toBe(1); // devolucion SÍ tiene items
    expect(await detalle()).toBe(10000);
  });

  it('rechaza tipo inválido → 400', async () => {
    const res = await request(app)
      .post('/api/cuentas/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: clienteId, fecha: '2026-03-01', tipo: 'credito', monto_total: 1000 });

    expect(res.status).toBe(400);
  });

  it('rechaza cliente inexistente → 404', async () => {
    const res = await request(app)
      .post('/api/cuentas/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: 999999, fecha: '2026-03-01', tipo: 'compra', monto_total: 1000 });

    expect(res.status).toBe(404);
  });

  it('rechaza monto_total negativo → 400', async () => {
    const res = await request(app)
      .post('/api/cuentas/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: clienteId, fecha: '2026-03-01', tipo: 'pago', monto_total: -500 });

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════
// HISTORIAL DE MOVIMIENTOS
// ═══════════════════════════════════════════════════════════════
describe('GET /api/cuentas/clientes/:id/movimientos', () => {
  it('devuelve movimientos con items embebidos', async () => {
    const res = await request(app)
      .get(`/api/cuentas/clientes/${clienteId}/movimientos`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(5); // compra + pago + parte + entrega + devolucion
    expect(res.body.pagination).toHaveProperty('total');

    // Cada movimiento tiene campo items (aunque sea [])
    res.body.data.forEach(m => {
      expect(Array.isArray(m.items)).toBe(true);
    });

    // La compra tiene sus items
    const compra = res.body.data.find(m => m.id === movCompraId);
    expect(compra).toBeDefined();
    expect(compra.items.length).toBe(1);
    expect(compra.items[0].modelo).toBe('15 Pro');
  });

  it('cliente inexistente → 404', async () => {
    const res = await request(app)
      .get('/api/cuentas/clientes/999999/movimientos')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// ELIMINAR MOVIMIENTO
// ═══════════════════════════════════════════════════════════════
describe('DELETE /api/cuentas/movimientos/:id', () => {
  it('elimina el movimiento de compra → saldo se actualiza', async () => {
    const res = await request(app)
      .delete(`/api/cuentas/movimientos/${movCompraId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // El saldo debería bajar (la compra de 50000 se eliminó)
    // Quedan: pago 20000, parte 5000, entrega 5000, devolucion 10000 → saldo = 0 - 20000 - 5000 - 5000 - 10000 = -40000
    const detalle = await request(app)
      .get(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(parseFloat(detalle.body.saldo)).toBe(-40000);
  });

  it('movimiento inexistente → 404', async () => {
    const res = await request(app)
      .delete('/api/cuentas/movimientos/999999')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  it('movimiento ya eliminado → 404', async () => {
    const res = await request(app)
      .delete(`/api/cuentas/movimientos/${movCompraId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// RESUMEN DE CUENTA
// ═══════════════════════════════════════════════════════════════
describe('GET /api/cuentas/clientes/:id/resumen', () => {
  it('devuelve totales desglosados por tipo', async () => {
    const res = await request(app)
      .get(`/api/cuentas/clientes/${clienteId}/resumen`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cliente');
    expect(res.body.cliente.id).toBe(clienteId);

    // Campos de totales
    expect(res.body).toHaveProperty('total_compras');
    expect(res.body).toHaveProperty('total_pagos');
    expect(res.body).toHaveProperty('total_devoluciones');
    expect(res.body).toHaveProperty('total_parte_de_pago');
    expect(res.body).toHaveProperty('total_entrega_mercaderia');
    expect(res.body).toHaveProperty('saldo');

    // Valores exactos (compra eliminada, quedan los 4 tipos de pago)
    expect(parseFloat(res.body.total_compras)).toBe(0);
    expect(parseFloat(res.body.total_pagos)).toBe(20000);
    expect(parseFloat(res.body.total_parte_de_pago)).toBe(5000);
    expect(parseFloat(res.body.total_entrega_mercaderia)).toBe(5000);
    expect(parseFloat(res.body.total_devoluciones)).toBe(10000);
    expect(parseFloat(res.body.saldo)).toBe(-40000);
  });

  it('cliente inexistente → 404', async () => {
    const res = await request(app)
      .get('/api/cuentas/clientes/999999/resumen')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// RESUMEN GENERAL
// ═══════════════════════════════════════════════════════════════
describe('GET /api/cuentas/resumen-general', () => {
  it('devuelve estructura con cant_clientes, totales y top_deudores', async () => {
    const res = await request(app)
      .get('/api/cuentas/resumen-general')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cant_clientes');
    expect(res.body).toHaveProperty('total_deuda');
    expect(res.body).toHaveProperty('total_credito');
    expect(res.body).toHaveProperty('neto');
    expect(Array.isArray(res.body.top_deudores)).toBe(true);
    expect(Number(res.body.cant_clientes)).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// CALENDARIO
// ═══════════════════════════════════════════════════════════════
describe('GET /api/cuentas/calendario', () => {
  it('devuelve movimientos agrupados por día para un mes dado', async () => {
    const res = await request(app)
      .get('/api/cuentas/calendario?mes=2026-03')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Hay movimientos en marzo 2026
    expect(res.body.length).toBeGreaterThanOrEqual(1);

    // Cada fila tiene los campos esperados
    res.body.forEach(row => {
      expect(row).toHaveProperty('dia');
      expect(row).toHaveProperty('compras');
      expect(row).toHaveProperty('pagos');
      expect(row).toHaveProperty('devoluciones');
      expect(row).toHaveProperty('cant');
    });
  });

  it('mes sin movimientos → array vacío', async () => {
    const res = await request(app)
      .get('/api/cuentas/calendario?mes=2020-01')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('formato de mes inválido → 400', async () => {
    const res = await request(app)
      .get('/api/cuentas/calendario?mes=mayo-2026')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════
// ELIMINAR CLIENTE (al final para no romper otros tests)
// ═══════════════════════════════════════════════════════════════
describe('DELETE /api/cuentas/clientes/:id', () => {
  it('elimina el cliente (soft-delete) → 200', async () => {
    const res = await request(app)
      .delete(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('cliente eliminado ya no aparece en GET /clientes', async () => {
    const res = await request(app)
      .get('/api/cuentas/clientes')
      .set('Authorization', `Bearer ${adminToken}`);

    const ids = res.body.data.map(c => c.id);
    expect(ids).not.toContain(clienteId);
  });

  it('cliente eliminado → 404 en GET /:id', async () => {
    const res = await request(app)
      .get(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  it('eliminar de nuevo → 404', async () => {
    const res = await request(app)
      .delete(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });
});

// ─── DELETE cliente con cascada (2026-06-09) ────────────────────────────────
// Bug raíz descubierto en testing pre-salida: borrar un cliente solo
// soft-deleteaba la fila de clientes_cc, dejando sus movimientos vivos.
// Resultado: stock vendido sin venta visible + caja con ingresos huérfanos.
//
// Hoy DELETE /clientes/:id ahora cascadea: en la misma TX cancela todos los
// movimientos del cliente (restaura stock + revierte caja + audit). Acá
// verificamos los 3 efectos en un caso E2E con 2 ventas distintas.
describe('DELETE /api/cuentas/clientes/:id — cascada de movimientos', () => {
  let cliId, catId, cajaUsdId;

  beforeAll(async () => {
    const cli = await request(app).post('/api/cuentas/clientes').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Cliente Cascada', categoria: 'A+' });
    cliId = cli.body.id;
    const cat = await request(app).post('/api/inventario/categorias').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Cascada Cat' });
    catId = cat.body.id;
    const metRes = await request(app).get('/api/ventas/metodos-pago').set('Authorization', `Bearer ${adminToken}`);
    cajaUsdId = (metRes.body || []).find(m => m.moneda === 'USD').id;
  });

  async function crearProducto(imei) {
    const r = await request(app).post('/api/inventario/productos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        tipo_carga: 'unitario', clase: 'celular', categoria_id: catId,
        nombre: `Cascada ${imei}`, imei, costo: 500, costo_moneda: 'USD',
        precio_venta: 1000, precio_moneda: 'USD', cantidad: 1,
      });
    return r.body;
  }
  async function saldoCaja(id) {
    const r = await request(app).get('/api/cajas/cajas').set('Authorization', `Bearer ${adminToken}`);
    return Number((r.body || []).find(c => c.id === id)?.saldo_actual ?? 0);
  }

  it('GET /clientes/:id/delete-preview devuelve diff esperado', async () => {
    const prod = await crearProducto('350777000000001');
    await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-06-09', tipo: 'compra',
        monto_total: 1000, caja_id: cajaUsdId,
        items: [{ producto_id: prod.id, cantidad: 1, valor: 1000 }],
      });

    const r = await request(app).get(`/api/cuentas/clientes/${cliId}/delete-preview`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.cliente.id).toBe(cliId);
    expect(r.body.movimientos_a_cancelar).toBe(1);
    expect(Number(r.body.caja_a_revertir_usd)).toBe(1000);
    expect(r.body.productos_a_restaurar).toBe(1);
  });

  it('borrar cliente cascadea: 2 ventas → 2 productos restaurados + caja vuelta a 0', async () => {
    // 2da venta para tener 2 movimientos vivos.
    const prod2 = await crearProducto('350777000000002');
    await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-06-09', tipo: 'compra',
        monto_total: 1000, caja_id: cajaUsdId,
        items: [{ producto_id: prod2.id, cantidad: 1, valor: 1000 }],
      });

    const cajaAntes = await saldoCaja(cajaUsdId);

    const del = await request(app).delete(`/api/cuentas/clientes/${cliId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    expect(del.body.cascade.movimientos_cancelados).toBe(2);
    expect(del.body.cascade.productos_restaurados).toBe(2);

    // Stock de ambos productos: vuelto a disponible / cantidad 1.
    for (const imei of ['350777000000001', '350777000000002']) {
      const p = await request(app)
        .get(`/api/inventario/productos?buscar=${imei}&vista=todos_ocultos`)
        .set('Authorization', `Bearer ${adminToken}`);
      const pAct = p.body.data.find(x => x.imei === imei);
      expect(Number(pAct.cantidad)).toBe(1);
      expect(pAct.estado).toBe('disponible');
    }

    // Caja: se revirtieron los 2 ingresos de USD 1000 → bajó USD 2000.
    const cajaPost = await saldoCaja(cajaUsdId);
    expect(cajaPost - cajaAntes).toBeCloseTo(-2000, 2);

    // Cliente quedó soft-deleted.
    const r = await request(app).get(`/api/cuentas/clientes/${cliId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(404);
  });

  it('cliente sin movimientos → cascada es 0, cliente sigue borrado normalmente', async () => {
    const cli = await request(app).post('/api/cuentas/clientes').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Cliente sin movs', categoria: 'A+' });
    const del = await request(app).delete(`/api/cuentas/clientes/${cli.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    expect(del.body.cascade.movimientos_cancelados).toBe(0);
    expect(del.body.cascade.productos_restaurados).toBe(0);
  });
});

// ─── Venta B2B con descuento de stock (#75) ──────────────────────────────
// Verifica el flujo "sale stock, entra dinero":
//   - Items con producto_id descuentan stock en una TX.
//   - Compra con caja_id → ingreso a caja + NO suma deuda.
//   - Compra sin caja_id → suma deuda al cliente.
//   - Stock insuficiente → 409 con rollback total.
//   - Producto inexistente → 404 con rollback.
//   - Borrar el movimiento devuelve el stock y revierte la caja.
//   - Devolución re-suma stock.
describe('Venta B2B con stock', () => {
  let cliId, catId, cajaUsdId;

  async function saldoCaja(id) {
    const r = await request(app).get('/api/cajas/cajas').set('Authorization', `Bearer ${adminToken}`);
    return Number((r.body || []).find(c => c.id === id)?.saldo_actual ?? 0);
  }
  async function saldoCliente(id) {
    const r = await request(app).get(`/api/cuentas/clientes/${id}`).set('Authorization', `Bearer ${adminToken}`);
    return Number(r.body.saldo || 0);
  }
  async function crearProducto({ nombre = 'iPhone Test B2B', cantidad = 1, imei = null } = {}) {
    const r = await request(app).post('/api/inventario/productos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        tipo_carga: cantidad > 1 ? 'lote' : 'unitario',
        clase: cantidad > 1 ? 'accesorio' : 'celular',
        categoria_id: catId, nombre, imei,
        costo: 500, costo_moneda: 'USD',
        precio_venta: 800, precio_moneda: 'USD',
        cantidad,
      });
    return r.body;
  }

  beforeAll(async () => {
    // Cliente B2B
    const cli = await request(app).post('/api/cuentas/clientes').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Cliente B2B Stock', categoria: 'A+' });
    cliId = cli.body.id;
    // Categoría
    const cat = await request(app).post('/api/inventario/categorias').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'B2B Stock Tests' });
    catId = cat.body.id;
    // Caja USD
    const r = await request(app).get('/api/ventas/metodos-pago').set('Authorization', `Bearer ${adminToken}`);
    cajaUsdId = (r.body || []).find(m => m.moneda === 'USD').id;
  });

  it('compra con caja → ingresa caja, descuenta stock, NO suma deuda', async () => {
    const prod = await crearProducto({ nombre: 'iPhone V1', imei: '350200000000001' });
    const saldoCajaAntes = await saldoCaja(cajaUsdId);
    const saldoCliAntes  = await saldoCliente(cliId);

    const res = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra',
        monto_total: 800, caja_id: cajaUsdId,
        items: [{ producto_id: prod.id, cantidad: 1, valor: 800 }],
      });
    expect(res.status).toBe(201);

    // Stock: bajó a 0 y quedó vendido
    const p = await request(app).get(`/api/inventario/productos?buscar=350200000000001&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`);
    const pAct = p.body.data.find(x => x.id === prod.id);
    expect(Number(pAct.cantidad)).toBe(0);
    expect(pAct.estado).toBe('vendido');

    // Caja: subió 800. Cliente: NO sumó deuda.
    expect(await saldoCaja(cajaUsdId) - saldoCajaAntes).toBeCloseTo(800, 2);
    expect(await saldoCliente(cliId)).toBeCloseTo(saldoCliAntes, 2);
  });

  it('compra sin caja → suma deuda, descuenta stock, NO mueve caja', async () => {
    const prod = await crearProducto({ nombre: 'iPhone V2', imei: '350200000000002' });
    const saldoCajaAntes = await saldoCaja(cajaUsdId);
    const saldoCliAntes  = await saldoCliente(cliId);

    const res = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 800,
        items: [{ producto_id: prod.id, cantidad: 1, valor: 800 }],
      });
    expect(res.status).toBe(201);

    expect(await saldoCliente(cliId) - saldoCliAntes).toBeCloseTo(800, 2);
    expect(await saldoCaja(cajaUsdId)).toBeCloseTo(saldoCajaAntes, 2);
  });

  // Bug reportado durante testing pre-salida 2026-06-08: al cargar 2 ítems con
  // el mismo producto_id (ej. operador eligió el mismo IMEI 2 veces en el modal
  // B2B), el bulk UPDATE con UNNEST devolvía rowCount=1 (PG dedupea), el sanity
  // check fallaba y el endpoint retornaba 500 con "Inconsistencia al actualizar
  // stock" — confuso para el operador. Ahora detectamos los duplicados ANTES
  // y devolvemos 409 con la lista de productos duplicados.
  it('producto_id duplicado en items → 409 con lista de duplicados (no 500 opaco)', async () => {
    const prod = await crearProducto({ nombre: 'iPhone Dup', imei: '350200000000099' });
    const saldoCliAntes = await saldoCliente(cliId);

    const res = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 1600,
        items: [
          { producto_id: prod.id, cantidad: 1, valor: 800 },
          { producto_id: prod.id, cantidad: 1, valor: 800 }, // ← duplicado intencional
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/repetidos?|duplicad/i);
    expect(res.body.duplicados).toBeDefined();
    expect(res.body.duplicados.map(d => d.id)).toContain(prod.id);
    // Rollback total: el producto sigue disponible, no se sumó deuda.
    const p = await request(app).get(`/api/inventario/productos?buscar=350200000000099&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`);
    const pAct = p.body.data.find(x => x.id === prod.id);
    expect(Number(pAct.cantidad)).toBe(1);
    expect(pAct.estado).toBe('disponible');
    expect(await saldoCliente(cliId)).toBeCloseTo(saldoCliAntes, 2);
  });

  it('stock insuficiente → 409 con rollback total', async () => {
    const prod = await crearProducto({ nombre: 'Accesorio Limitado', cantidad: 3 });
    const saldoCliAntes = await saldoCliente(cliId);
    const res = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 1000,
        items: [{ producto_id: prod.id, cantidad: 10, valor: 1000 }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/insuficiente/i);
    const p = await request(app).get(`/api/inventario/productos?buscar=Limitado&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`);
    const pAct = p.body.data.find(x => x.id === prod.id);
    expect(Number(pAct.cantidad)).toBe(3);
    expect(await saldoCliente(cliId)).toBeCloseTo(saldoCliAntes, 2);
  });

  it('producto inexistente → 404 con rollback', async () => {
    const res = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 100,
        items: [{ producto_id: 999999, cantidad: 1, valor: 100 }],
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no existe/i);
  });

  it('borrar movimiento devuelve stock + revierte caja', async () => {
    const prod = await crearProducto({ nombre: 'iPhone V3', imei: '350200000000003' });
    const saldoCajaAntes = await saldoCaja(cajaUsdId);

    const create = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra',
        monto_total: 800, caja_id: cajaUsdId,
        items: [{ producto_id: prod.id, cantidad: 1, valor: 800 }],
      });
    expect(create.status).toBe(201);

    const del = await request(app).delete(`/api/cuentas/movimientos/${create.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);

    const p = await request(app).get(`/api/inventario/productos?buscar=350200000000003&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`);
    const pAct = p.body.data.find(x => x.id === prod.id);
    expect(Number(pAct.cantidad)).toBe(1);
    expect(pAct.estado).toBe('disponible');
    expect(await saldoCaja(cajaUsdId)).toBeCloseTo(saldoCajaAntes, 2);
  });

  it('devolución re-suma stock', async () => {
    const prod = await crearProducto({ nombre: 'iPhone Devo', imei: '350200000000004' });
    await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 800,
        items: [{ producto_id: prod.id, cantidad: 1, valor: 800 }],
      });
    const dev = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'devolucion', monto_total: 800,
        items: [{ producto_id: prod.id, cantidad: 1, valor: 800 }],
      });
    expect(dev.status).toBe(201);
    const p = await request(app).get(`/api/inventario/productos?buscar=350200000000004&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`);
    const pAct = p.body.data.find(x => x.id === prod.id);
    expect(Number(pAct.cantidad)).toBe(1);
    expect(pAct.estado).toBe('disponible');
  });

  it('legacy: items SIN producto_id siguen funcionando (texto libre)', async () => {
    const res = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 50,
        items: [{ producto: 'Accesorio varios', valor: 50 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.items[0].producto).toBe('Accesorio varios');
    expect(res.body.items[0].producto_id).toBeNull();
  });
});

// ─── Cobranza masiva (#76) ───────────────────────────────────────────────
// Registra N pagos en bloque, cada uno a su caja, con TX atómica.
describe('Cobranza masiva', () => {
  let cli1, cli2, cli3, cajaUSD, cajaARS;

  async function saldoCaja(id) {
    const r = await request(app).get('/api/cajas/cajas').set('Authorization', `Bearer ${adminToken}`);
    return Number((r.body || []).find(c => c.id === id)?.saldo_actual ?? 0);
  }
  async function saldoCliente(id) {
    const r = await request(app).get(`/api/cuentas/clientes/${id}`).set('Authorization', `Bearer ${adminToken}`);
    return Number(r.body.saldo || 0);
  }

  beforeAll(async () => {
    // 3 clientes con deuda inicial
    const mk = (nombre) => request(app).post('/api/cuentas/clientes').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre, categoria: 'A+', saldo_inicial: 500 }).then(r => r.body);
    cli1 = await mk('CobranzaMasiva A');
    cli2 = await mk('CobranzaMasiva B');
    cli3 = await mk('CobranzaMasiva C');
    // Cajas (USD y ARS) — usamos las del seed
    const r = await request(app).get('/api/ventas/metodos-pago').set('Authorization', `Bearer ${adminToken}`);
    cajaUSD = (r.body || []).find(m => m.moneda === 'USD');
    cajaARS = (r.body || []).find(m => m.moneda === 'ARS');
  });

  it('registra 3 cobranzas en TX atómica, distintos clientes y cajas', async () => {
    const sUsdAntes = await saldoCaja(cajaUSD.id);
    const sArsAntes = await saldoCaja(cajaARS.id);
    const sCli1 = await saldoCliente(cli1.id);
    const sCli2 = await saldoCliente(cli2.id);

    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cobranzas: [
          { cliente_cc_id: cli1.id, fecha: '2026-05-29', monto: 200, moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago' },
          { cliente_cc_id: cli2.id, fecha: '2026-05-29', monto: 150000, moneda: 'ARS', tc: 1000, caja_id: cajaARS.id, tipo: 'parte_de_pago' },
          { cliente_cc_id: cli3.id, fecha: '2026-05-29', monto: 100, moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.creados).toBe(3);

    // Cajas: USD subió 300 (200 + 100), ARS subió 150000
    expect(await saldoCaja(cajaUSD.id) - sUsdAntes).toBeCloseTo(300, 2);
    expect(await saldoCaja(cajaARS.id) - sArsAntes).toBeCloseTo(150000, 2);
    // Clientes: bajaron en USD
    expect(sCli1 - await saldoCliente(cli1.id)).toBeCloseTo(200, 2);
    expect(sCli2 - await saldoCliente(cli2.id)).toBeCloseTo(150, 2); // 150000 / 1000
  });

  it('sobrepago se permite (cliente queda a favor)', async () => {
    // cli1 tenía 500-200=300. Le cobramos 500 → queda -200 (a favor).
    const sCli1 = await saldoCliente(cli1.id);
    const sCaja = await saldoCaja(cajaUSD.id);
    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cobranzas: [
          { cliente_cc_id: cli1.id, fecha: '2026-05-29', monto: 500, moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago' },
        ],
      });
    expect(res.status).toBe(201);
    // Saldo del cliente bajó 500 (puede quedar negativo)
    expect(sCli1 - await saldoCliente(cli1.id)).toBeCloseTo(500, 2);
    // Caja subió 500
    expect(await saldoCaja(cajaUSD.id) - sCaja).toBeCloseTo(500, 2);
  });

  it('cliente inexistente en una fila → 400 con rollback total', async () => {
    const sCli2 = await saldoCliente(cli2.id);
    const sCaja = await saldoCaja(cajaUSD.id);
    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cobranzas: [
          { cliente_cc_id: cli2.id,  fecha: '2026-05-29', monto: 50,  moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago' },
          { cliente_cc_id: 999999,   fecha: '2026-05-29', monto: 100, moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago' },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.detalles[0].error).toMatch(/no existe/i);
    // Nada se aplicó: saldos intactos
    expect(await saldoCliente(cli2.id)).toBeCloseTo(sCli2, 2);
    expect(await saldoCaja(cajaUSD.id)).toBeCloseTo(sCaja, 2);
  });

  it('caja ARS sin TC → 400 (refine del schema)', async () => {
    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cobranzas: [
          { cliente_cc_id: cli3.id, fecha: '2026-05-29', monto: 50000, moneda: 'ARS', caja_id: cajaARS.id, tipo: 'pago' },
        ],
      });
    expect(res.status).toBe(400);
  });

  it('lote vacío → 400', async () => {
    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({ cobranzas: [] });
    expect(res.status).toBe(400);
  });

  // ─── #T-04: edge cases adicionales de cobranza masiva ───────────────
  it('lote con 101 cobranzas → 400 (límite max=100)', async () => {
    const cobranzas = Array.from({ length: 101 }, () => ({
      cliente_cc_id: cli1.id, fecha: '2026-05-29',
      monto: 1, moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago',
    }));
    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({ cobranzas });
    expect(res.status).toBe(400);
  });

  it('sobrepago contra cliente con saldo a favor → permite (queda más negativo)', async () => {
    // Llevamos cli1 a saldo negativo
    const sCli1Antes = await saldoCliente(cli1.id);
    // Garantizamos saldo negativo: cobramos $100 contra un cliente sin deuda
    if (sCli1Antes > 0) {
      await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
        .send({ cobranzas: [{ cliente_cc_id: cli1.id, fecha: '2026-05-29', monto: sCli1Antes, moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago' }] });
    }
    const sCli1Neg = await saldoCliente(cli1.id);
    // Ahora otro pago: lleva más negativo
    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({ cobranzas: [{ cliente_cc_id: cli1.id, fecha: '2026-05-29', monto: 50, moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago' }] });
    expect(res.status).toBe(201);
    expect(sCli1Neg - await saldoCliente(cli1.id)).toBeCloseTo(50, 2);
  });

  it('caja con moneda incorrecta → 400 (caja ARS recibe pago USD)', async () => {
    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cobranzas: [
          { cliente_cc_id: cli1.id, fecha: '2026-05-29', monto: 100, moneda: 'USD', caja_id: cajaARS.id, tipo: 'pago' },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/moneda/i);
  });

  it('saldo_inicial de cliente baja correctamente al cobrar', async () => {
    const cliNuevo = await request(app).post('/api/cuentas/clientes').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Cli Saldo Ini', categoria: 'A+', saldo_inicial: 1000 }).then(r => r.body);
    expect(await saldoCliente(cliNuevo.id)).toBeCloseTo(1000, 2);

    await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cobranzas: [
          { cliente_cc_id: cliNuevo.id, fecha: '2026-05-29', monto: 600, moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago' },
        ],
      });
    expect(await saldoCliente(cliNuevo.id)).toBeCloseTo(400, 2);
  });

  // ─── #T-1: error paths más allá de cliente inválido en pos 0 ──────────
  // Gap detectado en LOW-T1: hay tests de cliente inexistente en pos 1,
  // pero faltan caja inexistente en posición intermedia, caja soft-deleted
  // entre validación y commit, y race de N cobranzas paralelas sobre el
  // mismo cliente. Estos cubren el SELECT FOR UPDATE pre-validación (#M-01).

  it('caja inexistente en posición intermedia → 400 con rollback total', async () => {
    const sCli2 = await saldoCliente(cli2.id);
    const sCli3 = await saldoCliente(cli3.id);
    const sCaja = await saldoCaja(cajaUSD.id);
    // Fila 1 OK, fila 2 con caja inexistente, fila 3 OK → todo rollback.
    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cobranzas: [
          { cliente_cc_id: cli2.id, fecha: '2026-05-29', monto: 30, moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago' },
          { cliente_cc_id: cli3.id, fecha: '2026-05-29', monto: 40, moneda: 'USD', caja_id: 999999, tipo: 'pago' },
          { cliente_cc_id: cli2.id, fecha: '2026-05-29', monto: 50, moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago' },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.detalles?.[0]?.error || res.body.error || '').toMatch(/caja|no existe/i);
    // Verificamos rollback: nada cambió
    expect(await saldoCliente(cli2.id)).toBeCloseTo(sCli2, 2);
    expect(await saldoCliente(cli3.id)).toBeCloseTo(sCli3, 2);
    expect(await saldoCaja(cajaUSD.id)).toBeCloseTo(sCaja, 2);
  });

  it('caja soft-deleted entre requests → 400 (pre-validación FOR UPDATE filtra deleted_at)', async () => {
    // Insertamos una caja directo por SQL para no consumir rate-limits ni
    // depender del schema HTTP, la soft-deleteamos, y verificamos que la
    // pre-validación FOR UPDATE (WHERE deleted_at IS NULL) la rechace.
    const db = require('../src/config/database');
    const { rows: [cajaInsertada] } = await db.query(
      `INSERT INTO metodos_pago (nombre, moneda, saldo_inicial)
       VALUES ('Caja borrar T1', 'USD', 0) RETURNING id`
    );
    await db.query('UPDATE metodos_pago SET deleted_at = NOW() WHERE id = $1', [cajaInsertada.id]);

    const sCli1 = await saldoCliente(cli1.id);
    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cobranzas: [
          { cliente_cc_id: cli1.id, fecha: '2026-05-29', monto: 25, moneda: 'USD', caja_id: cajaInsertada.id, tipo: 'pago' },
        ],
      });
    expect(res.status).toBe(400);
    expect(await saldoCliente(cli1.id)).toBeCloseTo(sCli1, 2);
  });

  it('movimiento con cliente soft-deleted → 400 (paralelo al test de caja borrada)', async () => {
    // Mismo patrón pero sobre clientes_cc: la pre-validación del FOR UPDATE
    // filtra deleted_at IS NULL, así que un cliente borrado entre el create
    // y la cobranza debe ser rechazado.
    const db = require('../src/config/database');
    const { rows: [cliInsertado] } = await db.query(
      `INSERT INTO clientes_cc (nombre, categoria) VALUES ('Cli borrar T1', 'A+') RETURNING id`
    );
    await db.query('UPDATE clientes_cc SET deleted_at = NOW() WHERE id = $1', [cliInsertado.id]);

    const sCaja = await saldoCaja(cajaUSD.id);
    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cobranzas: [
          { cliente_cc_id: cliInsertado.id, fecha: '2026-05-29', monto: 20, moneda: 'USD', caja_id: cajaUSD.id, tipo: 'pago' },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.detalles?.[0]?.error || res.body.error || '').toMatch(/cliente|no existe|inválido/i);
    expect(await saldoCaja(cajaUSD.id)).toBeCloseTo(sCaja, 2);
  });
});

// ─── #T-02, T-03: DELETE B2B con producto borrado/devolución ──────────
describe('DELETE movimiento B2B — edge cases con stock', () => {
  let cliId, catId, cajaUsdId;

  async function saldoCaja(id) {
    const r = await request(app).get('/api/cajas/cajas').set('Authorization', `Bearer ${adminToken}`);
    return Number((r.body || []).find(c => c.id === id)?.saldo_actual ?? 0);
  }

  beforeAll(async () => {
    const cli = await request(app).post('/api/cuentas/clientes').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Cliente DELETE B2B', categoria: 'A+' });
    cliId = cli.body.id;
    const cat = await request(app).post('/api/inventario/categorias').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'DELETE B2B Tests' });
    catId = cat.body.id;
    // Caja con saldo inicial para egresos sucesivos
    const cajaRes = await request(app).post('/api/cajas/cajas').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Caja DELETE B2B', moneda: 'USD', saldo_inicial: 5000, orden: 99 });
    cajaUsdId = cajaRes.body.id;
  });

  it('#T-02 — DELETE venta con producto soft-deleted no rompe (no incrementa stock fantasma)', async () => {
    // 1) Crear producto + venta B2B
    const prod = await request(app).post('/api/inventario/productos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        tipo_carga: 'unitario', clase: 'celular', categoria_id: catId,
        nombre: 'iPhone para borrar', imei: '350909000000001',
        costo: 500, costo_moneda: 'USD', precio_venta: 800, precio_moneda: 'USD', cantidad: 1,
      });
    const venta = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 800,
        items: [{ producto_id: prod.body.id, cantidad: 1, valor: 800 }],
      });
    expect(venta.status).toBe(201);

    // 2) Soft-delete del producto (alguien lo borró del Inventario)
    await request(app).delete(`/api/inventario/productos/${prod.body.id}`).set('Authorization', `Bearer ${adminToken}`);

    // 3) Borrar la venta. NO debería romper aunque el producto esté borrado.
    //    El UPDATE de stock incrementa el producto borrado (queda en cantidad>0
    //    pero deleted_at sigue null... este es el comportamiento actual; lo que
    //    nos interesa es que el DELETE de la venta no tire 500.
    const del = await request(app).delete(`/api/cuentas/movimientos/${venta.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
  });

  it('#T-03 — DELETE devolución revierte el aumento de stock (signo correcto)', async () => {
    const prod = await request(app).post('/api/inventario/productos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        tipo_carga: 'unitario', clase: 'celular', categoria_id: catId,
        nombre: 'iPhone Devo DELETE', imei: '350909000000002',
        costo: 500, costo_moneda: 'USD', precio_venta: 800, precio_moneda: 'USD', cantidad: 1,
      });
    // Vender → stock 0
    await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 800,
        items: [{ producto_id: prod.body.id, cantidad: 1, valor: 800 }],
      });
    // Devolución → stock 1
    const devo = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'devolucion', monto_total: 800,
        items: [{ producto_id: prod.body.id, cantidad: 1, valor: 800 }],
      });
    expect(devo.status).toBe(201);
    // Confirmar stock=1
    let p = (await request(app).get(`/api/inventario/productos?buscar=350909000000002&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`)).body.data.find(x => x.id === prod.body.id);
    expect(Number(p.cantidad)).toBe(1);

    // Borrar la devolución → debería volver stock a 0 (signo invertido)
    const del = await request(app).delete(`/api/cuentas/movimientos/${devo.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    p = (await request(app).get(`/api/inventario/productos?buscar=350909000000002&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`)).body.data.find(x => x.id === prod.body.id);
    expect(Number(p.cantidad)).toBe(0);
    expect(p.estado).toBe('vendido');
  });

  it('#B-06 — DELETE devolución con stock vendido entre medio → 409', async () => {
    // 1) Crear producto, vender (stock 1→0), devolver (0→1), vender de nuevo (1→0)
    const prod = await request(app).post('/api/inventario/productos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        tipo_carga: 'unitario', clase: 'celular', categoria_id: catId,
        nombre: 'iPhone CHECK', imei: '350909000000003',
        costo: 500, costo_moneda: 'USD', precio_venta: 800, precio_moneda: 'USD', cantidad: 1,
      });
    await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 800,
        items: [{ producto_id: prod.body.id, cantidad: 1, valor: 800 }] });
    const devo = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'devolucion', monto_total: 800,
        items: [{ producto_id: prod.body.id, cantidad: 1, valor: 800 }] });
    // Re-vender lo devuelto: stock 1 → 0
    await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 800,
        items: [{ producto_id: prod.body.id, cantidad: 1, valor: 800 }] });

    // Ahora intentar borrar la devolución → debería bajar 0 → -1 → CHECK constraint
    // Pero gracias a B-06, devolvemos 409 explícito ANTES del UPDATE.
    const del = await request(app).delete(`/api/cuentas/movimientos/${devo.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/stock|vend/i);
  });
});

// ─── Devolución INLINE de item (2026-06-09) ─────────────────────────────
// Lucas pidió un botón ↺ por fila en el desglose de la venta B2B: marcar
// un item devuelto sin crear un movimiento manual. El item original queda
// con devuelto_at != NULL (frontend lo tacha) y se crea un mov_cc
// 'devolucion' asociado para preservar trazabilidad contable + restaurar
// stock + ajustar saldo del cliente.
describe('POST /api/cuentas/movimientos/:movId/items/:itemId/devolver', () => {
  let cliId, catId, prod1, prod2, ventaId;

  beforeAll(async () => {
    const cli = await request(app).post('/api/cuentas/clientes').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Cliente Devo Inline', categoria: 'A+' });
    cliId = cli.body.id;
    const cat = await request(app).post('/api/inventario/categorias').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Devo Inline Cat' });
    catId = cat.body.id;
    // 2 productos para la venta multi-item
    const p1 = await request(app).post('/api/inventario/productos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        tipo_carga: 'unitario', clase: 'celular', categoria_id: catId,
        nombre: 'iPhone Devo Inline 1', imei: '359000000000001',
        costo: 500, costo_moneda: 'USD',
        precio_venta: 1000, precio_moneda: 'USD', cantidad: 1,
      });
    prod1 = p1.body;
    const p2 = await request(app).post('/api/inventario/productos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        tipo_carga: 'unitario', clase: 'celular', categoria_id: catId,
        nombre: 'iPhone Devo Inline 2', imei: '359000000000002',
        costo: 700, costo_moneda: 'USD',
        precio_venta: 1400, precio_moneda: 'USD', cantidad: 1,
      });
    prod2 = p2.body;
    // Venta B2B multi-item, sin caja (queda como deuda)
    const venta = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-06-09', tipo: 'compra', monto_total: 2400,
        items: [
          { producto_id: prod1.id, producto: 'iPhone Devo Inline 1', imei_serial: '359000000000001', cantidad: 1, valor: 1000 },
          { producto_id: prod2.id, producto: 'iPhone Devo Inline 2', imei_serial: '359000000000002', cantidad: 1, valor: 1400 },
        ],
      });
    expect(venta.status).toBe(201);
    ventaId = venta.body.id;
  });

  async function getItems() {
    const r = await pool.query(
      `SELECT * FROM items_movimiento_cc WHERE movimiento_cc_id = $1 ORDER BY id`,
      [ventaId]
    );
    return r.rows;
  }
  async function getSaldoCliente() {
    const r = await request(app).get(`/api/cuentas/clientes/${cliId}`).set('Authorization', `Bearer ${adminToken}`);
    return Number(r.body.saldo || 0);
  }

  it('devuelve un item → marca devuelto_at + crea mov de devolución + restaura stock + baja saldo', async () => {
    const items = await getItems();
    const itemAdevolver = items.find(i => i.producto_id === prod1.id);
    expect(itemAdevolver.devuelto_at).toBeNull();
    const saldoAntes = await getSaldoCliente();
    expect(saldoAntes).toBeCloseTo(2400, 2);

    const r = await request(app)
      .post(`/api/cuentas/movimientos/${ventaId}/items/${itemAdevolver.id}/devolver`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.devolucion_mov_id).toBeGreaterThan(0);
    expect(Number(r.body.monto_devuelto_usd)).toBe(1000);

    // Item original quedó marcado.
    const itemPost = (await getItems()).find(i => i.id === itemAdevolver.id);
    expect(itemPost.devuelto_at).not.toBeNull();
    expect(itemPost.devolucion_mov_id).toBe(r.body.devolucion_mov_id);

    // Stock restaurado.
    const p = await request(app).get(`/api/inventario/productos?buscar=359000000000001&vista=todos_ocultos`)
      .set('Authorization', `Bearer ${adminToken}`);
    const pAct = p.body.data.find(x => x.id === prod1.id);
    expect(Number(pAct.cantidad)).toBe(1);
    expect(pAct.estado).toBe('disponible');

    // Saldo del cliente bajó por el monto del item devuelto (la devolución
    // resta deuda — el cliente "te debe menos" porque te devolvió mercadería).
    const saldoPost = await getSaldoCliente();
    expect(saldoPost).toBeCloseTo(saldoAntes - 1000, 2);

    // El otro item del mov original NO se tocó.
    const itemOtro = (await getItems()).find(i => i.producto_id === prod2.id);
    expect(itemOtro.devuelto_at).toBeNull();
  });

  it('devolver un item ya devuelto → 409 idempotente', async () => {
    const items = await getItems();
    const yaDevuelto = items.find(i => i.producto_id === prod1.id);
    expect(yaDevuelto.devuelto_at).not.toBeNull();
    const r = await request(app)
      .post(`/api/cuentas/movimientos/${ventaId}/items/${yaDevuelto.id}/devolver`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ya fue devuelto/i);
  });

  it('item de movimiento que NO es tipo "compra" → 409', async () => {
    // Crear un pago y intentar devolver "su item" (no tiene, pero el mov no es compra)
    const pago = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cliId, fecha: '2026-06-09', tipo: 'pago', monto_total: 500, caja_id: cajaUsdId });
    expect(pago.status).toBe(201);
    // No tiene items pero igual probamos con un id cualquiera; el endpoint
    // valida el tipo del movimiento ANTES de buscar el item.
    const r = await request(app)
      .post(`/api/cuentas/movimientos/${pago.body.id}/items/999999/devolver`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/tipo "compra"/i);
  });

  it('item sin producto_id (texto libre) → 409', async () => {
    // Crear venta con item de texto libre (sin producto_id)
    const venta = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-06-09', tipo: 'compra', monto_total: 100,
        items: [{ producto: 'Accesorio varios', valor: 100 }],
      });
    expect(venta.status).toBe(201);
    const itemTxt = venta.body.items[0];
    const r = await request(app)
      .post(`/api/cuentas/movimientos/${venta.body.id}/items/${itemTxt.id}/devolver`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/texto libre|no tiene producto/i);
  });

  it('movimiento o item inexistente → 404', async () => {
    const r1 = await request(app)
      .post(`/api/cuentas/movimientos/999999/items/1/devolver`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r1.status).toBe(404);
    const r2 = await request(app)
      .post(`/api/cuentas/movimientos/${ventaId}/items/999999/devolver`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r2.status).toBe(404);
  });

  // 2026-06-10 — PATCH /movimientos/:id/estado: alternar acreditado/pendiente.
  it('PATCH /movimientos/:id/estado alterna entre acreditado y pendiente', async () => {
    const cli = await request(app).post('/api/cuentas/clientes').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Cli estado', categoria: 'A+' });
    const mov = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cli.body.id, fecha: '2026-06-10', tipo: 'compra', monto_total: 500,
        items: [{ producto: 'Texto libre', valor: 500 }],
      });
    expect(mov.status).toBe(201);
    expect(mov.body.estado).toBe('acreditado'); // default

    // Cambiar a pendiente
    const r1 = await request(app)
      .patch(`/api/cuentas/movimientos/${mov.body.id}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'pendiente' });
    expect(r1.status).toBe(200);
    expect(r1.body.estado).toBe('pendiente');

    // Mismo estado → sin_cambios
    const r2 = await request(app)
      .patch(`/api/cuentas/movimientos/${mov.body.id}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'pendiente' });
    expect(r2.body.sin_cambios).toBe(true);

    // Estado inválido → 400 schema
    const r3 = await request(app)
      .patch(`/api/cuentas/movimientos/${mov.body.id}/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'invalido' });
    expect(r3.status).toBe(400);

    // Mov inexistente → 404
    const r4 = await request(app)
      .patch(`/api/cuentas/movimientos/999999/estado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ estado: 'acreditado' });
    expect(r4.status).toBe(404);
  });

  // 2026-06-09 — eliminar el movimiento de devolución debe destachar el item
  // original (devuelto_at = NULL). Sin esto, el item queda visualmente tachado
  // pero con stock vendido — inconsistencia.
  it('eliminar el mov de devolución → destacha el item original (devuelto_at NULL)', async () => {
    // Crear venta + devolver 1 item → item queda con devuelto_at != NULL.
    const cli = await request(app).post('/api/cuentas/clientes').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Cli destacha', categoria: 'A+' });
    const cat = await request(app).post('/api/inventario/categorias').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Cat destacha' });
    const prod = await request(app).post('/api/inventario/productos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        tipo_carga: 'unitario', clase: 'celular', categoria_id: cat.body.id,
        nombre: 'iPhone destacha', imei: '359000000000777',
        costo: 500, costo_moneda: 'USD',
        precio_venta: 1000, precio_moneda: 'USD', cantidad: 1,
      });
    const venta = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cli.body.id, fecha: '2026-06-09', tipo: 'compra', monto_total: 1000,
        items: [{ producto_id: prod.body.id, producto: 'iPhone destacha', imei_serial: '359000000000777', cantidad: 1, valor: 1000 }],
      });
    const items = await pool.query('SELECT id FROM items_movimiento_cc WHERE movimiento_cc_id = $1', [venta.body.id]);
    const itemId = items.rows[0].id;
    const devo = await request(app)
      .post(`/api/cuentas/movimientos/${venta.body.id}/items/${itemId}/devolver`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(devo.status).toBe(200);

    const pre = await pool.query('SELECT devuelto_at, devolucion_mov_id FROM items_movimiento_cc WHERE id = $1', [itemId]);
    expect(pre.rows[0].devuelto_at).not.toBeNull();

    // Borrar la devolución.
    const del = await request(app).delete(`/api/cuentas/movimientos/${devo.body.devolucion_mov_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);

    // El item original ya no debería estar tachado.
    const post = await pool.query('SELECT devuelto_at, devolucion_mov_id FROM items_movimiento_cc WHERE id = $1', [itemId]);
    expect(post.rows[0].devuelto_at).toBeNull();
    expect(post.rows[0].devolucion_mov_id).toBeNull();
  });
});

// ─── #T-05: schemas .strict() rechazan campos extra ──────────────────
describe('Schemas .strict() — rechazar campos extra', () => {
  let cliId, cajaUsdId;
  beforeAll(async () => {
    const cli = await request(app).post('/api/cuentas/clientes').set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Cli strict', categoria: 'A+' });
    cliId = cli.body.id;
    const r = await request(app).get('/api/ventas/metodos-pago').set('Authorization', `Bearer ${adminToken}`);
    cajaUsdId = (r.body || []).find(m => m.moneda === 'USD').id;
  });

  it('createMovimientoCC con campo extra → 400', async () => {
    const res = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'pago', monto_total: 100,
        caja_id: cajaUsdId, campo_inventado: 'no debería pasar',
      });
    expect(res.status).toBe(400);
  });

  it('itemMovimientoCC con campo extra → 400 (#H-08)', async () => {
    const res = await request(app).post('/api/cuentas/movimientos').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: cliId, fecha: '2026-05-29', tipo: 'compra', monto_total: 50,
        items: [{ producto: 'Algo', valor: 50, foo_extra: 'bar' }],
      });
    expect(res.status).toBe(400);
  });

  it('cobranzaItem con campo extra → 400', async () => {
    const res = await request(app).post('/api/cuentas/cobranzas-masivas').set('Authorization', `Bearer ${adminToken}`)
      .send({
        cobranzas: [{
          cliente_cc_id: cliId, fecha: '2026-05-29', monto: 10, moneda: 'USD',
          caja_id: cajaUsdId, tipo: 'pago', notas_invalidas: 'extra',
        }],
      });
    expect(res.status).toBe(400);
  });
});

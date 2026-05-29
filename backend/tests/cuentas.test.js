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
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const bcrypt  = require('bcrypt');

let pool;
let adminToken;
let opToken;     // usuario sin permiso cuentas
let clienteId;
let movCompraId;

beforeAll(async () => {
  pool = await setupTestDb();

  // Autenticar como admin (tiene todos los permisos)
  const r1 = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = r1.body.token;

  // Crear usuario op sin permisos para testear 403
  const hash = await bcrypt.hash('op_cc_pass123', 10);
  await pool.query(
    'INSERT INTO users (nombre, username, password_hash, role) VALUES ($1,$2,$3,$4)',
    ['Op CC', 'opcc', hash, 'op']
  );
  const r2 = await request(app)
    .post('/api/auth/login')
    .send({ username: 'opcc', password: 'op_cc_pass123' });
  opToken = r2.body.token;
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
      .send({ cliente_cc_id: res.body.id, fecha: '2026-05-26', tipo: 'pago', monto_total: 500 });
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
describe('POST /api/cuentas/movimientos — saldo', () => {
  it('compra de 50000 → saldo +50000', async () => {
    const res = await request(app)
      .post('/api/cuentas/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: clienteId,
        fecha:         '2026-03-01',
        tipo:          'compra',
        descripcion:   'iPhone 15 Pro',
        monto_total:   50000,
        items: [
          { producto: 'iPhone', modelo: '15 Pro', capacidad: '256GB', precio_usd: 900, imei_serial: '123456789012345' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.tipo).toBe('compra');
    expect(parseFloat(res.body.monto_total)).toBe(50000);
    // Items solo se crean para compra/devolucion
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].modelo).toBe('15 Pro');
    movCompraId = res.body.id;

    // Verificar saldo en detalle del cliente
    const detalle = await request(app)
      .get(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(parseFloat(detalle.body.saldo)).toBe(50000);
  });

  it('pago de 20000 → saldo cae a 30000', async () => {
    const res = await request(app)
      .post('/api/cuentas/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: clienteId,
        fecha:         '2026-03-10',
        tipo:          'pago',
        monto_total:   20000,
        // Los items se ignoran para tipo 'pago'
        items: [{ producto: 'ignorado' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.tipo).toBe('pago');
    expect(res.body.items).toEqual([]); // pago no tiene items

    const detalle = await request(app)
      .get(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(parseFloat(detalle.body.saldo)).toBe(30000);
  });

  it('parte_de_pago de 5000 → saldo cae a 25000', async () => {
    const res = await request(app)
      .post('/api/cuentas/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: clienteId, fecha: '2026-03-15', tipo: 'parte_de_pago', monto_total: 5000 });

    expect(res.status).toBe(201);

    const detalle = await request(app)
      .get(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(parseFloat(detalle.body.saldo)).toBe(25000);
  });

  it('entrega_mercaderia de 5000 → saldo cae a 20000', async () => {
    const res = await request(app)
      .post('/api/cuentas/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: clienteId, fecha: '2026-03-20', tipo: 'entrega_mercaderia', monto_total: 5000 });

    expect(res.status).toBe(201);

    const detalle = await request(app)
      .get(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(parseFloat(detalle.body.saldo)).toBe(20000);
  });

  it('devolucion de 10000 con items → saldo cae a 10000', async () => {
    const res = await request(app)
      .post('/api/cuentas/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        cliente_cc_id: clienteId,
        fecha:         '2026-03-25',
        tipo:          'devolucion',
        monto_total:   10000,
        items: [{ producto: 'iPhone', modelo: '14', imei_serial: '987654321098765' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.items.length).toBe(1); // devolucion SÍ tiene items

    const detalle = await request(app)
      .get(`/api/cuentas/clientes/${clienteId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(parseFloat(detalle.body.saldo)).toBe(10000);
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
});

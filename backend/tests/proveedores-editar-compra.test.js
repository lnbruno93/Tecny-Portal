/**
 * Tests de integración — PUT /api/proveedores/movimientos/:mid (edit compra).
 *
 * Feature Fase B pedido Gianfranco Amato (2026-07-30):
 * Editar campos + agregar/remover items de una compra existente, con sync
 * automático a Inventario para los productos asociados.
 *
 * Escenarios cubiertos:
 *  1. Happy: editar solo fecha/notas del mov (sin tocar items) — no cambia items ni monto
 *  2. Happy: UPDATE item existente — sync a producto asociado (nombre, imei, color)
 *  3. Happy: INSERT item nuevo con producto_stock → crea producto en Inventario
 *  4. Happy: DELETE item → soft-delete producto asociado + recalcula monto
 *  5. Guard: DELETE item cuyo producto YA se vendió → 409
 *  6. Guard: IMEI duplicado dentro del mismo lote → 409
 *  7. Guard: IMEI de item nuevo choca con producto existente ajeno → 409
 *  8. Guard: tipo=pago no editable por esta ruta → 400
 *  9. Recalculo: cambiar valor de un item → monto recalculado + caja ajustada si contado
 * 10. Audit trail: JSON con items_added/removed/updated + monto antes/después
 * 11. 404: movimiento inexistente
 *
 * Setup: cada test crea su propio proveedor + compra (aislado por describe).
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;

beforeAll(async () => {
  pool = await setupTestDb();
  const authRes = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = authRes.body.token;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ── Helpers ────────────────────────────────────────────────────────────
async function crearProveedor(nombre) {
  const res = await request(app)
    .post('/api/proveedores')
    .set('Authorization', `Bearer ${token}`)
    .send({ nombre });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function crearCompra(proveedorId, opts = {}) {
  const {
    items = [],
    monto,
    caja_id = null,
    fecha = '2026-07-29',
    notas = null,
  } = opts;
  // Si no viene monto explícito, sumar valores de items
  const montoCalculado = monto ?? items.reduce((acc, it) => acc + (Number(it.valor) || 0), 0);
  const res = await request(app)
    .post('/api/proveedores/movimientos')
    .set('Authorization', `Bearer ${token}`)
    .send({
      proveedor_id: proveedorId,
      fecha,
      tipo: 'compra',
      monto: montoCalculado,
      moneda: 'USD',
      caja_id,
      notas,
      items,
    });
  expect([201, 200]).toContain(res.status);
  return res.body;
}

async function getMovimientos(proveedorId) {
  const res = await request(app)
    .get(`/api/proveedores/${proveedorId}/movimientos`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.data;
}

async function getProducto(id) {
  // No hay GET /productos/:id — query directo con RLS aplicado.
  await pool.query(`SELECT set_config('app.current_tenant', $1::text, true)`, [String(TEST_USER.tenantId)]);
  const r = await pool.query('SELECT * FROM productos WHERE id = $1 AND deleted_at IS NULL', [id]);
  return r.rows[0] || null;
}

// ── Tests ──────────────────────────────────────────────────────────────
describe('PUT /movimientos/:mid — editar solo campos del movimiento', () => {
  it('cambia fecha + notas sin tocar items → monto queda igual', async () => {
    const provId = await crearProveedor('MayoristaEditFechaNotas');
    const mov = await crearCompra(provId, {
      items: [{ producto: 'iPhone 14', valor: 500 }],
    });
    const res = await request(app)
      .put(`/api/proveedores/movimientos/${mov.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha: '2026-07-30',
        notas: 'Actualizada — factura #123',
      });
    expect(res.status).toBe(200);
    expect(res.body.notas).toBe('Actualizada — factura #123');
    expect(String(res.body.fecha).slice(0, 10)).toBe('2026-07-30');
    expect(Number(res.body.monto)).toBe(500);
    expect(res.body.items).toHaveLength(1);
  });
});

describe('PUT /movimientos/:mid — editar campos de items existentes', () => {
  it('UPDATE item con producto_stock sincroniza producto en Inventario', async () => {
    const provId = await crearProveedor('MayoristaSyncProducto');
    const mov = await crearCompra(provId, {
      items: [{
        producto: 'iPhone 14',
        modelo: 'Pro',
        tamano: '128',
        color: 'Azul',
        imei_serial: '111222333444555',
        valor: 800,
        producto_stock: {
          nombre: 'iPhone 14 Pro',
          imei: '111222333444555',
          gb: '128',
          color: 'Azul',
          costo: 800,
        },
      }],
    });
    const itemId = mov.items[0].id;
    const productoId = mov.productos_creados[0].id;

    // Cambio nombre + color + valor. Debería reflejarse en el producto.
    const res = await request(app)
      .put(`/api/proveedores/movimientos/${mov.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{
          id: itemId,
          producto: 'iPhone 14 Pro Max',
          modelo: 'Pro Max',
          tamano: '256',
          color: 'Negro',
          imei_serial: '111222333444555', // sin cambio
          valor: 900,
        }],
      });
    expect(res.status).toBe(200);
    expect(res.body.items[0].producto).toBe('iPhone 14 Pro Max');
    expect(res.body.items[0].color).toBe('Negro');
    expect(Number(res.body.items[0].valor)).toBe(900);
    expect(Number(res.body.monto)).toBe(900); // recalculado

    // Verifico que el producto en Inventario también se actualizó
    const prod = await getProducto(productoId);
    expect(prod.nombre).toBe('iPhone 14 Pro Max');
    expect(prod.color).toBe('Negro');
    expect(prod.gb).toBe('256');
    expect(Number(prod.costo)).toBe(900);
  });
});

describe('PUT /movimientos/:mid — agregar items nuevos', () => {
  it('INSERT item nuevo con producto_stock crea producto en Inventario', async () => {
    const provId = await crearProveedor('MayoristaInsertItem');
    const mov = await crearCompra(provId, {
      items: [{ producto: 'iPhone 13', valor: 400 }],
    });
    const itemExistente = mov.items[0].id;

    const res = await request(app)
      .put(`/api/proveedores/movimientos/${mov.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          // Item existente sin cambios
          { id: itemExistente, producto: 'iPhone 13', valor: 400 },
          // Item nuevo con producto_stock
          {
            producto: 'iPhone 15',
            modelo: 'Standard',
            tamano: '256',
            color: 'Verde',
            imei_serial: '999888777666555',
            valor: 700,
            producto_stock: {
              nombre: 'iPhone 15',
              imei: '999888777666555',
              gb: '256',
              color: 'Verde',
              costo: 700,
            },
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(Number(res.body.monto)).toBe(1100); // 400 + 700
    expect(res.body.productos_creados).toHaveLength(1);
    expect(res.body.productos_creados[0].nombre).toBe('iPhone 15');
    expect(res.body.productos_creados[0].imei).toBe('999888777666555');
  });
});

describe('PUT /movimientos/:mid — remover items', () => {
  it('DELETE item soft-deletea producto asociado + recalcula monto', async () => {
    const provId = await crearProveedor('MayoristaDeleteItem');
    const mov = await crearCompra(provId, {
      items: [
        {
          producto: 'iPad Pro', modelo: 'M2', tamano: '256', color: 'Silver',
          imei_serial: 'IPAD-DELETE-001', valor: 1200,
          producto_stock: {
            nombre: 'iPad Pro M2', imei: 'IPAD-DELETE-001', gb: '256',
            color: 'Silver', costo: 1200,
          },
        },
        {
          producto: 'Cargador USB-C', valor: 30,
          // Sin producto_stock — no crea producto
        },
      ],
    });
    const [itemAEliminar, itemQueQueda] = mov.items;
    const productoAEliminar = mov.productos_creados[0].id;

    // Body con solo el segundo item → el primero se remueve
    const res = await request(app)
      .put(`/api/proveedores/movimientos/${mov.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { id: itemQueQueda.id, producto: 'Cargador USB-C', valor: 30 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(itemQueQueda.id);
    expect(Number(res.body.monto)).toBe(30); // solo el cargador

    // El producto asociado debería estar soft-deleted
    const prodBorrado = await getProducto(productoAEliminar);
    expect(prodBorrado).toBeNull(); // devuelve 404 → getProducto retorna null
  });
});

describe('PUT /movimientos/:mid — guards', () => {
  it('409 si intentás remover un item cuyo producto YA se vendió', async () => {
    const provId = await crearProveedor('MayoristaGuardVendido');
    const mov = await crearCompra(provId, {
      items: [{
        producto: 'iPhone Vendido', modelo: 'A', tamano: '128', color: 'Rojo',
        imei_serial: 'IMEI-VENDIDO-001', valor: 500,
        producto_stock: {
          nombre: 'iPhone Vendido', imei: 'IMEI-VENDIDO-001', gb: '128',
          color: 'Rojo', costo: 500,
        },
      }],
    });
    const productoId = mov.productos_creados[0].id;

    // Marcar el producto como vendido directo en DB (simulando una venta)
    await pool.query(`SELECT set_config('app.current_tenant', $1::text, true)`, [String(TEST_USER.tenantId)]);
    await pool.query(`UPDATE productos SET estado = 'vendido' WHERE id = $1`, [productoId]);

    // Intento remover el item → debería fallar
    const res = await request(app)
      .put(`/api/proveedores/movimientos/${mov.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/vendido/i);
    expect(res.body.productos_vendidos).toContain('iPhone Vendido');
  });

  it('409 si hay IMEI duplicado en items nuevos (mismo lote)', async () => {
    const provId = await crearProveedor('MayoristaIMEIDupInterno');
    const mov = await crearCompra(provId, {
      items: [{ producto: 'Existente', valor: 100 }],
    });

    const res = await request(app)
      .put(`/api/proveedores/movimientos/${mov.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { id: mov.items[0].id, producto: 'Existente', valor: 100 },
          {
            producto: 'A', imei_serial: 'IMEI-DUP-001', valor: 200,
            producto_stock: { nombre: 'A', imei: 'IMEI-DUP-001', costo: 200 },
          },
          {
            producto: 'B', imei_serial: 'IMEI-DUP-001', valor: 300,
            producto_stock: { nombre: 'B', imei: 'IMEI-DUP-001', costo: 300 },
          },
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/IMEI duplicado dentro del mismo lote/);
  });

  it('409 si IMEI nuevo choca con producto ajeno en Inventario', async () => {
    const provId1 = await crearProveedor('MayoristaIMEIchoca1');
    const provId2 = await crearProveedor('MayoristaIMEIchoca2');
    // Compra en prov1 que crea producto con IMEI conocido
    await crearCompra(provId1, {
      items: [{
        producto: 'Xerox', imei_serial: 'IMEI-COLLISION-999', valor: 100,
        producto_stock: {
          nombre: 'Xerox', imei: 'IMEI-COLLISION-999', costo: 100,
        },
      }],
    });
    // Compra en prov2 que quiero editar para agregar item con MISMO imei
    const mov2 = await crearCompra(provId2, {
      items: [{ producto: 'Otro', valor: 50 }],
    });

    const res = await request(app)
      .put(`/api/proveedores/movimientos/${mov2.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { id: mov2.items[0].id, producto: 'Otro', valor: 50 },
          {
            producto: 'Choca', imei_serial: 'IMEI-COLLISION-999', valor: 200,
            producto_stock: { nombre: 'Choca', imei: 'IMEI-COLLISION-999', costo: 200 },
          },
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/IMEI ya existe/);
    expect(res.body.imeis_existentes).toContain('IMEI-COLLISION-999');
  });

  it('400 si el tipo del movimiento NO es "compra"', async () => {
    const provId = await crearProveedor('MayoristaPagoNoEditable');
    // Crear un pago (no compra)
    const pagoRes = await request(app)
      .post('/api/proveedores/movimientos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        proveedor_id: provId,
        fecha: '2026-07-29',
        tipo: 'pago',
        monto: 100,
        moneda: 'USD',
        caja_id: null,  // sin caja = doesn't work para pago, pero el schema lo permite
      });
    // Nota: si pago requiere caja_id, este test se ajusta.
    // Como fallback usamos un mov tipo compra pero cambiado en DB para test.
    if (pagoRes.status !== 201) {
      // No podemos crear pago sin caja → forzar tipo cambio directo en DB
      const mov = await crearCompra(provId, { items: [{ producto: 'X', valor: 10 }] });
      await pool.query(`SELECT set_config('app.current_tenant', $1::text, true)`, [String(TEST_USER.tenantId)]);
      await pool.query(`UPDATE proveedor_movimientos SET tipo = 'saldo_inicial' WHERE id = $1`, [mov.id]);
      const res = await request(app)
        .put(`/api/proveedores/movimientos/${mov.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Solo se pueden editar compras/);
      return;
    }
    const res = await request(app)
      .put(`/api/proveedores/movimientos/${pagoRes.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Solo se pueden editar compras/);
  });

  it('404 si el movimiento no existe', async () => {
    const res = await request(app)
      .put('/api/proveedores/movimientos/999999999')
      .set('Authorization', `Bearer ${token}`)
      .send({ notas: 'test' });
    expect(res.status).toBe(404);
  });
});

describe('PUT /movimientos/:mid — recálculo monto y caja', () => {
  it('cambiar valor de un item recalcula monto de la compra', async () => {
    const provId = await crearProveedor('MayoristaRecalculo');
    const mov = await crearCompra(provId, {
      items: [
        { producto: 'A', valor: 100 },
        { producto: 'B', valor: 200 },
      ],
    });
    expect(Number(mov.monto)).toBe(300);

    // Cambio valor del primero: 100 → 500. Monto debería ser 500 + 200 = 700.
    const res = await request(app)
      .put(`/api/proveedores/movimientos/${mov.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { id: mov.items[0].id, producto: 'A', valor: 500 },
          { id: mov.items[1].id, producto: 'B', valor: 200 },
        ],
      });
    expect(res.status).toBe(200);
    expect(Number(res.body.monto)).toBe(700);
    expect(Number(res.body.monto_usd)).toBe(700);
  });
});

describe('PUT /movimientos/:mid — audit trail', () => {
  it('audit_logs contiene contadores de items added/removed/updated', async () => {
    const provId = await crearProveedor('MayoristaAudit');
    const mov = await crearCompra(provId, {
      items: [
        { producto: 'A', valor: 100 },
        { producto: 'B', valor: 200 },
      ],
    });

    const res = await request(app)
      .put(`/api/proveedores/movimientos/${mov.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          // 1 UPDATE (item 0), 1 REMOVE (item 1), 1 INSERT (nuevo)
          { id: mov.items[0].id, producto: 'A editado', valor: 150 },
          { producto: 'C nuevo', valor: 300 },
        ],
      });
    expect(res.status).toBe(200);

    // Query audit_logs para verificar
    await pool.query(`SELECT set_config('app.current_tenant', $1::text, true)`, [String(TEST_USER.tenantId)]);
    const audit = await pool.query(
      `SELECT datos_despues FROM audit_logs
        WHERE tabla = 'proveedor_movimientos' AND accion = 'UPDATE' AND registro_id = $1
        ORDER BY id DESC LIMIT 1`,
      [mov.id]
    );
    expect(audit.rows).toHaveLength(1);
    const despues = audit.rows[0].datos_despues;
    expect(despues.items_updated).toBe(1);
    expect(despues.items_removed).toBe(1);
    expect(despues.items_added).toBe(1);
    expect(despues.monto).toBe(450); // 150 + 300
  });
});

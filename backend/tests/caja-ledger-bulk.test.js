// Tests unitarios de `postCajaMovimientosBulk` — TANDA 1 Perf #4 (2026-07-05).
//
// El helper single (`postCajaMovimiento`) ya tiene cobertura de integración a
// través de las rutas en `caja-ledger.test.js` (retail venta + envío). Como
// `syncVentaCaja` y `syncEnvioCaja` ahora llaman a la versión bulk, esos tests
// existentes también exercizan el camino bulk transitivamente.
//
// Esta suite verifica invariantes específicos de la versión bulk que no se
// cubren en el camino integration:
//   1. Empty array es no-op.
//   2. Movimientos con caja_id null o monto <= 0 se saltean (no error).
//   3. Moneda incompatible con grupo de la caja → 400.
//   4. Caja soft-deleted → 400.
//   5. Bulk con 3 pagos a 2 cajas distintas: todos insertados.
//   6. Egreso que dejaría la caja en negativo → 400 (validación de saldo bulk).

const {
  postCajaMovimientosBulk,
  postCajaMovimiento,
} = require('../src/lib/cajaLedger');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;
const hoy = new Date().toISOString().split('T')[0];

// Helper: ejecutar la función bajo una tx con RLS setup (tenant 1).
async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = 1`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Helper: crear una caja directamente en DB (bypaseando la ruta) para tests unitarios.
async function crearCajaDb(client, { moneda = 'USD', saldo_inicial = 0, deleted = false } = {}) {
  const nombre = `Caja bulk test ${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await client.query(
    `INSERT INTO metodos_pago (tenant_id, nombre, moneda, saldo_inicial, deleted_at)
     VALUES (1, $1, $2, $3, ${deleted ? 'NOW()' : 'NULL'}) RETURNING id, moneda, saldo_inicial`,
    [nombre, moneda, saldo_inicial]
  );
  return rows[0];
}

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe('postCajaMovimientosBulk', () => {
  it('empty array: no-op, retorna []', async () => {
    const result = await inTx((client) => postCajaMovimientosBulk(client, []));
    expect(result).toEqual([]);
  });

  it('null / undefined: no-op, retorna []', async () => {
    const r1 = await inTx((client) => postCajaMovimientosBulk(client, null));
    const r2 = await inTx((client) => postCajaMovimientosBulk(client, undefined));
    expect(r1).toEqual([]);
    expect(r2).toEqual([]);
  });

  it('saltea movimientos con caja_id null o monto <= 0 (no error)', async () => {
    const result = await inTx(async (client) => {
      const caja = await crearCajaDb(client, { moneda: 'USD' });
      return postCajaMovimientosBulk(client, [
        { caja_id: null, fecha: hoy, tipo: 'ingreso', monto: 100, moneda: 'USD', origen: 'venta' },
        { caja_id: caja.id, fecha: hoy, tipo: 'ingreso', monto: 0, moneda: 'USD', origen: 'venta' },
        { caja_id: caja.id, fecha: hoy, tipo: 'ingreso', monto: -10, moneda: 'USD', origen: 'venta' },
      ]);
    });
    expect(result).toEqual([]);
  });

  it('inserta N movimientos a cajas distintas en 1 sola query', async () => {
    // Uso realista: N pagos de una MISMA venta a cajas distintas. El UNIQUE
    // partial `uq_caja_mov_origen_activo` (migration 20260603000001) es sobre
    // (ref_tabla, ref_id, caja_id, tipo) — como cada caja es distinta, no viola.
    const result = await inTx(async (client) => {
      const cajaA = await crearCajaDb(client, { moneda: 'USD' });
      const cajaB = await crearCajaDb(client, { moneda: 'ARS' });
      const cajaC = await crearCajaDb(client, { moneda: 'USD' });
      return postCajaMovimientosBulk(client, [
        { caja_id: cajaA.id, fecha: hoy, tipo: 'ingreso', monto: 100,  moneda: 'USD', tc: null, origen: 'venta', ref_tabla: 'ventas', ref_id: 999, concepto: 'A', user_id: 1 },
        { caja_id: cajaB.id, fecha: hoy, tipo: 'ingreso', monto: 1400, moneda: 'ARS', tc: 1400, origen: 'venta', ref_tabla: 'ventas', ref_id: 999, concepto: 'B', user_id: 1 },
        { caja_id: cajaC.id, fecha: hoy, tipo: 'ingreso', monto: 50,   moneda: 'USD', tc: null, origen: 'venta', ref_tabla: 'ventas', ref_id: 999, concepto: 'C', user_id: 1 },
      ]);
    });
    expect(result).toHaveLength(3);
    // Movimientos USD: monto_usd = monto.
    expect(Number(result[0].monto_usd)).toBe(100);
    // Movimiento ARS: monto_usd = 1400 / 1400 = 1.
    expect(Number(result[1].monto_usd)).toBe(1);
    expect(Number(result[2].monto_usd)).toBe(50);
  });

  it('rechaza moneda que no coincide con grupo de la caja → 400', async () => {
    await expect(
      inTx(async (client) => {
        const caja = await crearCajaDb(client, { moneda: 'USD' });
        return postCajaMovimientosBulk(client, [
          { caja_id: caja.id, fecha: hoy, tipo: 'ingreso', monto: 1400, moneda: 'ARS', tc: 1400, origen: 'venta' },
        ]);
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/moneda del pago.*no coincide/i),
    });
  });

  it('BLOCKER 2026-07-05: pago UYU rechazado en caja USD (no se mezcla el saldo)', async () => {
    // Regresión directa del bug donde UYU compartía grupo con USD.
    await expect(
      inTx(async (client) => {
        const caja = await crearCajaDb(client, { moneda: 'USD' });
        return postCajaMovimientosBulk(client, [
          { caja_id: caja.id, fecha: hoy, tipo: 'ingreso', monto: 40000, moneda: 'UYU', tc: 40, origen: 'venta' },
        ]);
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rechaza caja soft-deleted → 400', async () => {
    await expect(
      inTx(async (client) => {
        const caja = await crearCajaDb(client, { moneda: 'USD', deleted: true });
        return postCajaMovimientosBulk(client, [
          { caja_id: caja.id, fecha: hoy, tipo: 'ingreso', monto: 100, moneda: 'USD', origen: 'venta' },
        ]);
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/caja.*no existe/i),
    });
  });

  it('rechaza egreso que dejaría la caja en saldo negativo → 400', async () => {
    await expect(
      inTx(async (client) => {
        const caja = await crearCajaDb(client, { moneda: 'USD', saldo_inicial: 50 });
        return postCajaMovimientosBulk(client, [
          { caja_id: caja.id, fecha: hoy, tipo: 'egreso', monto: 100, moneda: 'USD', origen: 'egreso' },
        ]);
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/saldo insuficiente/i),
    });
  });

  it('permite egresos si el batch neto no rompe el saldo (ingreso compensa)', async () => {
    // Semántica bulk: valida saldo POST-batch. Un ingreso puede compensar un
    // egreso "grande" dentro del mismo batch. En la práctica los callers actuales
    // no mezclan tipos, pero verificamos el diseño.
    const result = await inTx(async (client) => {
      const caja = await crearCajaDb(client, { moneda: 'USD', saldo_inicial: 50 });
      return postCajaMovimientosBulk(client, [
        { caja_id: caja.id, fecha: hoy, tipo: 'ingreso', monto: 200, moneda: 'USD', origen: 'venta' },
        { caja_id: caja.id, fecha: hoy, tipo: 'egreso',  monto: 100, moneda: 'USD', origen: 'egreso' },
      ]);
    });
    expect(result).toHaveLength(2);
  });

  it('paridad con postCajaMovimiento single: mismo output para 1 pago', async () => {
    // Sanity: el bulk con 1 pago debe producir el mismo row que el single.
    const bulkRow = await inTx(async (client) => {
      const caja = await crearCajaDb(client, { moneda: 'USD' });
      const [r] = await postCajaMovimientosBulk(client, [
        { caja_id: caja.id, fecha: hoy, tipo: 'ingreso', monto: 250, moneda: 'USD', tc: null, origen: 'venta', ref_tabla: 'ventas', ref_id: 42, concepto: 'x', user_id: 1 },
      ]);
      return r;
    });
    const singleRow = await inTx(async (client) => {
      const caja = await crearCajaDb(client, { moneda: 'USD' });
      return postCajaMovimiento(client, {
        caja_id: caja.id, fecha: hoy, tipo: 'ingreso', monto: 250, moneda: 'USD', tc: null,
        origen: 'venta', ref_tabla: 'ventas', ref_id: 42, concepto: 'x', user_id: 1,
      });
    });
    // Comparamos campos "portables" (id y caja_id difieren por definición).
    expect(bulkRow.tipo).toBe(singleRow.tipo);
    expect(Number(bulkRow.monto)).toBe(Number(singleRow.monto));
    expect(Number(bulkRow.monto_usd)).toBe(Number(singleRow.monto_usd));
    expect(bulkRow.origen).toBe(singleRow.origen);
    expect(bulkRow.ref_tabla).toBe(singleRow.ref_tabla);
    expect(bulkRow.ref_id).toBe(singleRow.ref_id);
    expect(bulkRow.concepto).toBe(singleRow.concepto);
    expect(bulkRow.user_id).toBe(singleRow.user_id);
  });
});

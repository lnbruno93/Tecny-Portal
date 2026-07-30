/**
 * Tests de integración — RELEVO de Proveedores (feature 2026-07-29).
 *
 * Cubre POST /api/proveedores/:id/relevo — ajuste manual del saldo con audit.
 *
 * Escenarios cubiertos:
 *   1. Happy path: relevo hacia arriba (delta+) crea movimiento 'relevo_incremento'.
 *   2. Happy path: relevo hacia abajo (delta-) crea movimiento 'relevo_reduccion'.
 *   3. Validación: nota muy corta → 400 (Zod schema min 10 chars).
 *   4. Validación: saldo_nuevo_usd === saldo_actual → 400 (no hay ajuste).
 *   5. 404: proveedor inexistente.
 *   6. Saldo negativo permitido (adelanto no recibido como mercadería).
 *   7. Audit trail: JSON con snapshot completo (saldo_ant, saldo_nuevo, delta, nota).
 *   8. Reverte: dos relevos consecutivos vuelven al saldo original.
 *   9. SALDO_CASE_M consume los 2 nuevos tipos correctamente (contract test).
 *
 * NO cubre (fuera de scope para este PR):
 *   - Capability check (`proveedores.relevar` no está en TEST_USER — bypassa por admin).
 *   - Cross-tenant notification al partner (Red B2B — deferred a v2, requiere
 *     extender CHECK constraint de cross_tenant_notifications.type).
 *   - Cross-tenant isolation (probado por withTenant en el handler + RLS).
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;
let proveedorId;

beforeAll(async () => {
  pool = await setupTestDb();
  const authRes = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = authRes.body.token;

  // Crear proveedor de prueba con saldo inicial 1000 USD (deuda arranque).
  const provRes = await request(app)
    .post('/api/proveedores')
    .set('Authorization', `Bearer ${token}`)
    .send({ nombre: 'Mayorista Test Relevo', saldo_inicial: 1000 });
  proveedorId = provRes.body.id;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe('POST /api/proveedores/:id/relevo — happy paths', () => {
  it('relevo hacia arriba (saldo_nuevo > actual) crea movimiento tipo "relevo_incremento"', async () => {
    // Proveedor arranca con saldo_inicial 1000 → saldo_actual = 1000 (les debemos 1000).
    // Ajusto a 1500 → delta +500 → tipo relevo_incremento.
    const res = await request(app)
      .post(`/api/proveedores/${proveedorId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:           '2026-07-29',
        saldo_nuevo_usd: 1500,
        nota:            'Compra olvidada del 25/07: le pedimos mercadería por USD 500 y no la cargué',
      });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.saldo_anterior).toBe(1000);
    expect(res.body.saldo_nuevo).toBe(1500);
    expect(res.body.delta).toBe(500);
    expect(res.body.movimiento.tipo).toBe('relevo_incremento');
    expect(Number(res.body.movimiento.monto)).toBe(500);
    expect(Number(res.body.movimiento.monto_usd)).toBe(500);
    expect(res.body.movimiento.moneda).toBe('USD');
  });

  it('relevo hacia abajo (saldo_nuevo < actual) crea movimiento tipo "relevo_reduccion"', async () => {
    // Post-test anterior: saldo = 1500. Ajusto a 800 → delta -700 → tipo relevo_reduccion.
    const res = await request(app)
      .post(`/api/proveedores/${proveedorId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:           '2026-07-29',
        saldo_nuevo_usd: 800,
        nota:            'Pago en efectivo olvidado a Kevin el 20/07 por USD 700 (recibo firmado)',
      });
    expect(res.status).toBe(201);
    expect(res.body.saldo_anterior).toBe(1500);
    expect(res.body.saldo_nuevo).toBe(800);
    expect(res.body.delta).toBe(-700);
    expect(res.body.movimiento.tipo).toBe('relevo_reduccion');
    expect(Number(res.body.movimiento.monto)).toBe(700);
    expect(Number(res.body.movimiento.monto_usd)).toBe(700);
  });

  it('relevo con saldo_nuevo negativo (adelanto entregado) es permitido', async () => {
    // Post-test anterior: saldo = 800. Ajusto a -200 (le entregamos plata como adelanto
    // que aún no recibimos como mercadería) → delta -1000 → tipo relevo_reduccion.
    const res = await request(app)
      .post(`/api/proveedores/${proveedorId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:           '2026-07-29',
        saldo_nuevo_usd: -200,
        nota:            'Adelanto USD 200 entregado el 28/07 pendiente de recibir mercadería',
      });
    expect(res.status).toBe(201);
    expect(res.body.saldo_nuevo).toBe(-200);
    expect(res.body.delta).toBe(-1000);
    expect(res.body.movimiento.tipo).toBe('relevo_reduccion');
    expect(Number(res.body.movimiento.monto)).toBe(1000);
  });

  it('dos relevos consecutivos permiten revertir al saldo original (audit forense)', async () => {
    // Post-test anterior: saldo = -200. Revertimos → ajustamos a 1000 (el original).
    // delta = +1200 → relevo_incremento.
    const res = await request(app)
      .post(`/api/proveedores/${proveedorId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:           '2026-07-29',
        saldo_nuevo_usd: 1000,
        nota:            'Revertir el relevo del 29/07 — el adelanto se cargó como movimiento formal',
      });
    expect(res.status).toBe(201);
    expect(res.body.saldo_anterior).toBe(-200);
    expect(res.body.saldo_nuevo).toBe(1000);
    expect(res.body.delta).toBe(1200);
    expect(res.body.movimiento.tipo).toBe('relevo_incremento');
  });
});

describe('POST /api/proveedores/:id/relevo — validation errors', () => {
  it('rechaza nota vacía (Zod schema min 10 chars)', async () => {
    const res = await request(app)
      .post(`/api/proveedores/${proveedorId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: '2026-07-29', saldo_nuevo_usd: 500, nota: '' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/nota|10 caracteres/i);
  });

  it('rechaza nota demasiado corta (<10 chars)', async () => {
    const res = await request(app)
      .post(`/api/proveedores/${proveedorId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: '2026-07-29', saldo_nuevo_usd: 500, nota: 'ajuste' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/10 caracteres/i);
  });

  it('rechaza saldo_nuevo_usd igual al saldo actual (delta = 0)', async () => {
    // Post-test "reverte": saldo = 1000. Envío ese mismo saldo → debería rechazar.
    const res = await request(app)
      .post(`/api/proveedores/${proveedorId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:           '2026-07-29',
        saldo_nuevo_usd: 1000,  // igual al actual
        nota:            'Intento de relevo sin diferencia real que ajustar',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/igual al actual/i);
  });

  it('rechaza fecha con formato inválido (Zod schema YYYY-MM-DD)', async () => {
    const res = await request(app)
      .post(`/api/proveedores/${proveedorId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:           '29/07/2026',  // formato AR, no ISO
        saldo_nuevo_usd: 2000,
        nota:            'Relevo con fecha mal formateada para testear el schema Zod',
      });
    expect(res.status).toBe(400);
  });

  it('rechaza campos extra (schema.strict())', async () => {
    const res = await request(app)
      .post(`/api/proveedores/${proveedorId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:           '2026-07-29',
        saldo_nuevo_usd: 2000,
        nota:            'Relevo con campo extra para verificar Zod strict rechaza',
        campo_no_esperado: 'valor cualquiera',
      });
    expect(res.status).toBe(400);
  });

  it('404 si el proveedor no existe', async () => {
    const res = await request(app)
      .post('/api/proveedores/9999999/relevo')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:           '2026-07-29',
        saldo_nuevo_usd: 100,
        nota:            'Test con proveedor inexistente en el sistema actual',
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no encontrado/i);
  });
});

describe('POST /api/proveedores/:id/relevo — audit + SALDO_CASE contract', () => {
  it('crea audit_log con snapshot completo (saldo_ant, saldo_nuevo, delta, nota)', async () => {
    // Hacemos un relevo nuevo y buscamos su audit_log.
    // Post-tests anteriores: saldo del proveedor = 1000.
    const relRes = await request(app)
      .post(`/api/proveedores/${proveedorId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:           '2026-07-29',
        saldo_nuevo_usd: 1250,
        nota:            'Cierre mensual: 250 USD de mercadería recibida sin cargar en el sistema',
      });
    expect(relRes.status).toBe(201);
    const movId = relRes.body.movimiento.id;

    // Query audit_logs directamente. RLS activo → SET LOCAL.
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant = 1`);  // TEST tenant id
      const { rows } = await client.query(
        `SELECT accion, datos_despues FROM audit_logs
          WHERE tabla = 'proveedor_movimientos' AND registro_id = $1::text
          ORDER BY id DESC LIMIT 1`,
        [String(movId)]
      );
      expect(rows[0]).toBeDefined();
      expect(rows[0].accion).toBe('INSERT');
      const despues = rows[0].datos_despues;
      expect(despues.accion_negocio).toBe('relevo_proveedor');
      expect(Number(despues.saldo_anterior)).toBe(1000);
      expect(Number(despues.saldo_nuevo)).toBe(1250);
      expect(Number(despues.delta)).toBe(250);
      expect(despues.nota).toMatch(/Cierre mensual/);
    } finally {
      client.release();
    }
  });

  it('SALDO_CASE_M consume relevo_incremento (+) y relevo_reduccion (-) correctamente', async () => {
    // Contract test: fuerza la lectura del saldo vía GET /resumen/saldos que
    // usa SALDO_CASE_M. Si la fórmula no maneja los 2 nuevos tipos, el saldo
    // devuelto no coincidirá con el last saldo_nuevo del último relevo.
    const res = await request(app)
      .get('/api/proveedores/resumen/saldos')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const prov = res.body.proveedores.find((p) => p.id === proveedorId);
    expect(prov).toBeDefined();
    // Post último relevo: saldo debe ser 1250 (el saldo_nuevo del último relevo).
    // Este número surge de sumar TODOS los movimientos (relevos incluidos) vía SALDO_CASE_M.
    expect(Number(prov.saldo_usd)).toBe(1250);
  });
});

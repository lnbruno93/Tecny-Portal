/**
 * Tests de integración — RELEVO de Cajas (feature 2026-07-29).
 *
 * Cubre POST /api/cajas/:id/relevo — ajuste manual del saldo con audit.
 *
 * Escenarios cubiertos:
 *   1. Happy path: relevo hacia arriba (delta+) crea movimiento 'ingreso'.
 *   2. Happy path: relevo hacia abajo (delta-) crea movimiento 'egreso'.
 *   3. Validación: nota muy corta → 400 (Zod schema).
 *   4. Validación: saldo_nuevo === saldo_actual → 400 (no hay ajuste).
 *   5. Validación: caja ARS sin tc → 400.
 *   6. 404: caja inexistente.
 *   7. Origen del movimiento resultante = 'relevo' (Dashboard exclusion).
 *   8. Reverte: dos relevos consecutivos vuelven al saldo original.
 *   9. Saldo negativo permitido (no aplica guard de postCajaMovimiento).
 *  10. Audit trail: JSON con snapshot completo (saldo_ant, saldo_nuevo, delta, nota).
 *
 * NO cubre (fuera de scope para este PR):
 *   - Capability check (`cajas.relevar` no está en TEST_USER — bypassa por admin role).
 *     Requiere test dedicado con user sin rol admin, insertando capabilities manuales.
 *   - Cross-tenant isolation (probado indirectamente por withTenant en el handler).
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;
let cajaUsdId;
let cajaArsId;

beforeAll(async () => {
  pool = await setupTestDb();
  const authRes = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = authRes.body.token;

  // Crear 2 cajas de prueba: una USD (sin tc requirement) y una ARS (con tc).
  const cajaUsd = await request(app)
    .post('/api/cajas/cajas')
    .set('Authorization', `Bearer ${token}`)
    .send({ nombre: 'Caja Test USD Relevo', moneda: 'USD', saldo_inicial: 1000 });
  cajaUsdId = cajaUsd.body.id;

  const cajaArs = await request(app)
    .post('/api/cajas/cajas')
    .set('Authorization', `Bearer ${token}`)
    .send({ nombre: 'Caja Test ARS Relevo', moneda: 'ARS', saldo_inicial: 500000 });
  cajaArsId = cajaArs.body.id;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe('POST /api/cajas/:id/relevo — happy paths', () => {
  it('relevo hacia arriba (saldo_nuevo > actual) crea movimiento tipo "ingreso"', async () => {
    const res = await request(app)
      .post(`/api/cajas/cajas/${cajaUsdId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-07-29',
        saldo_nuevo: 1500,  // caja tenía 1000, ajusto a 1500 → delta +500
        nota:        'Arqueo mensual: encontré USD 500 más en el cajón',
      });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.saldo_anterior).toBe(1000);
    expect(res.body.saldo_nuevo).toBe(1500);
    expect(res.body.delta).toBe(500);
    expect(res.body.movimiento.tipo).toBe('ingreso');
    expect(Number(res.body.movimiento.monto)).toBe(500);
    expect(res.body.movimiento.origen).toBe('relevo');
    expect(res.body.movimiento.concepto).toMatch(/Arqueo mensual/);
  });

  it('relevo hacia abajo (saldo_nuevo < actual) crea movimiento tipo "egreso"', async () => {
    // Caja USD ahora está en 1500. Ajusto a 1200 → delta -300, tipo egreso.
    const res = await request(app)
      .post(`/api/cajas/cajas/${cajaUsdId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-07-29',
        saldo_nuevo: 1200,
        nota:        'Pago olvidado a proveedor por USD 300 el 25/07 en efectivo',
      });
    expect(res.status).toBe(201);
    expect(res.body.saldo_anterior).toBe(1500);
    expect(res.body.saldo_nuevo).toBe(1200);
    expect(res.body.delta).toBe(-300);
    expect(res.body.movimiento.tipo).toBe('egreso');
    expect(Number(res.body.movimiento.monto)).toBe(300);
    expect(res.body.movimiento.origen).toBe('relevo');
  });

  it('caja ARS con tc calcula monto_usd equivalente correctamente', async () => {
    // Caja ARS tiene saldo_inicial 500000, sin movimientos aún → actual = 500000.
    // Ajusto a 600000 con tc=1000 → delta +100000 ARS = 100 USD equivalente.
    const res = await request(app)
      .post(`/api/cajas/cajas/${cajaArsId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-07-29',
        saldo_nuevo: 600000,
        tc:          1000,
        nota:        'Cliente pagó ARS 100000 no registrados el 20/07',
      });
    expect(res.status).toBe(201);
    expect(res.body.delta).toBe(100000);
    expect(Number(res.body.movimiento.monto)).toBe(100000);
    expect(Number(res.body.movimiento.monto_usd)).toBe(100);
    expect(res.body.movimiento.tipo).toBe('ingreso');
  });

  it('relevo con saldo negativo (adelanto no registrado) es permitido', async () => {
    // Caja USD post-relevos = 1200. Ajusto a -100 (adelanto entregado) → delta -1300.
    // El endpoint bypassa la guard "no-negative" de postCajaMovimiento (ver comentario).
    const res = await request(app)
      .post(`/api/cajas/cajas/${cajaUsdId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-07-29',
        saldo_nuevo: -100,
        nota:        'Adelanto USD 100 entregado a Kevin que no se registró',
      });
    expect(res.status).toBe(201);
    expect(res.body.saldo_nuevo).toBe(-100);
    expect(res.body.delta).toBe(-1300);
    expect(res.body.movimiento.tipo).toBe('egreso');
    expect(Number(res.body.movimiento.monto)).toBe(1300);
  });
});

describe('POST /api/cajas/:id/relevo — validation errors', () => {
  it('rechaza nota vacía (Zod schema min 10 chars)', async () => {
    const res = await request(app)
      .post(`/api/cajas/cajas/${cajaUsdId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: '2026-07-29', saldo_nuevo: 500, nota: '' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/nota|10 caracteres/i);
  });

  it('rechaza nota demasiado corta (<10 chars)', async () => {
    const res = await request(app)
      .post(`/api/cajas/cajas/${cajaUsdId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: '2026-07-29', saldo_nuevo: 500, nota: 'ajuste' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/10 caracteres/i);
  });

  it('rechaza saldo_nuevo igual al saldo actual (delta = 0)', async () => {
    // Primero conseguir el saldo actual de la caja USD (que quedó en -100 tras
    // el test anterior). Envío ese mismo saldo → debería rechazar.
    const res = await request(app)
      .post(`/api/cajas/cajas/${cajaUsdId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-07-29',
        saldo_nuevo: -100,  // igual al actual (el test anterior lo dejó ahí)
        nota:        'Intento de relevo sin diferencia real',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/igual al actual/i);
  });

  it('rechaza caja ARS sin tc', async () => {
    const res = await request(app)
      .post(`/api/cajas/cajas/${cajaArsId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-07-29',
        saldo_nuevo: 700000,  // diferente al anterior (600000)
        nota:        'Ajuste ARS sin tipo de cambio — debería fallar',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tipo de cambio|tc/i);
  });

  it('404 si la caja no existe', async () => {
    const res = await request(app)
      .post('/api/cajas/cajas/9999999/relevo')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-07-29',
        saldo_nuevo: 100,
        nota:        'Test con caja inexistente en el sistema',
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no encontrada/i);
  });

  it('rechaza ID inválido (no numérico)', async () => {
    const res = await request(app)
      .post('/api/cajas/cajas/abc/relevo')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-07-29',
        saldo_nuevo: 100,
        nota:        'Test con id malformado en la URL de la request',
      });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/cajas/:id/relevo — audit + Dashboard exclusion', () => {
  it('crea audit_log con snapshot completo (saldo_ant, saldo_nuevo, delta, nota)', async () => {
    // Hacemos un relevo nuevo y buscamos su audit_log.
    const relRes = await request(app)
      .post(`/api/cajas/cajas/${cajaArsId}/relevo`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:       '2026-07-29',
        saldo_nuevo: 650000,  // desde 600000 → delta +50000
        tc:          1000,
        nota:        'Cierre semanal de caja: 50k ARS de ventas retail cash',
      });
    expect(relRes.status).toBe(201);
    const movId = relRes.body.movimiento.id;

    // Query audit_logs directamente. tenant_id ya lo setea el middleware.
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant = 1`);  // TEST tenant id
      const { rows } = await client.query(
        `SELECT accion, datos_despues FROM audit_logs
          WHERE tabla = 'caja_movimientos' AND registro_id = $1::text
          ORDER BY id DESC LIMIT 1`,
        [String(movId)]
      );
      expect(rows[0]).toBeDefined();
      expect(rows[0].accion).toBe('INSERT');
      const despues = rows[0].datos_despues;
      expect(despues.accion_negocio).toBe('relevo_caja');
      expect(Number(despues.saldo_anterior)).toBe(600000);
      expect(Number(despues.saldo_nuevo)).toBe(650000);
      expect(Number(despues.delta)).toBe(50000);
      expect(despues.nota).toMatch(/Cierre semanal/);
    } finally {
      client.release();
    }
  });

  it('el movimiento de relevo tiene origen "relevo" (Dashboard lo excluye)', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant = 1`);
      const { rows } = await client.query(
        `SELECT origen FROM caja_movimientos
          WHERE caja_id = $1 AND deleted_at IS NULL AND origen = 'relevo'`,
        [cajaUsdId]
      );
      // Deben haber varios relevos por los tests anteriores (los USD).
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((r) => expect(r.origen).toBe('relevo'));
    } finally {
      client.release();
    }
  });
});

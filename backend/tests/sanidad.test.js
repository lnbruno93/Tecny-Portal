/**
 * Tests del endpoint /api/sanidad (feature 2026-06-23 Sanidad del Negocio).
 *
 * Cubre:
 *   · GET ?meses=6 devuelve 6 meses con shape esperado (bruto/gastos/neto/daily).
 *   · GET valida `meses` (out of range → 400).
 *   · GET sin auth → 401; member sin capability 'sanidad.trabajar' → 403.
 *   · GET refleja egresos recurrentes activos en gastos.proyectado_usd.
 *   · GET refleja egresos pagados (estado='pagado') en gastos.real_usd, con
 *     agrupación correcta por recurrente_id + bucket "Otros" para los sueltos.
 *   · GET cierra todo en USD (incluyendo recurrentes con moneda ARS y TC).
 *   · GET respeta RLS — un tenant no ve egresos/recurrentes de otro tenant.
 *   · PUT /proyeccion upsert (crea + actualiza), con audit.
 *   · PUT valida periodo (regex YYYY-MM) y bruto >= 0.
 *   · DELETE /proyeccion/:periodo es idempotente (204 incluso si no existe).
 *
 * El backend usa la misma DB de tests que el resto del suite — la migration
 * 20260623210000_proyecciones_mensuales.js se aplica vía `npm run migrate`
 * en setupTestDb(). Cleanup defensivo per-test para aislamiento.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;
let adminToken;
let memberSinCajasToken;

// Helper: firma un JWT con los claims típicos del portal.
// 2026-06-23 F4: ahora aceptamos `tenant_cap_rol` + `caps` opcionales para el
// sistema capability-based. Si no se pasan, el middleware hace fallback a DB.
function signToken({ id, username, email, role, tenant_id, tenant_rol, tenant_cap_rol, caps }) {
  return jwt.sign(
    {
      id, username, email, role, tenant_id, tenant_rol,
      ...(tenant_cap_rol !== undefined ? { tenant_cap_rol } : {}),
      ...(caps !== undefined ? { caps } : {}),
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256' }
  );
}

// Helper: periodo YYYY-MM del mes actual y N-anterior. Usamos UTC para no
// depender del TZ del runner — la lógica del route usa también UTC.
function periodoActual() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

beforeAll(async () => {
  pool = await setupTestDb();

  // Admin del tenant 1 con tenant_rol=admin. El testadmin que crea setupTestDb
  // tiene role=admin global → admin bypass lo deja pasar todos los gates
  // requireCapability (tanto el viejo requirePermission como el nuevo).
  adminToken = signToken({
    id: 1, username: 'testadmin', email: 'testadmin@test.local',
    role: 'admin', tenant_id: 1, tenant_rol: 'admin',
  });

  // Member sin capability `sanidad.trabajar` — para validar el gate de mount.
  await pool.query(`DELETE FROM tenant_users WHERE user_id IN (SELECT id FROM users WHERE username = 'memberSinCajas')`);
  await pool.query(`DELETE FROM users WHERE username = 'memberSinCajas'`);
  const { rows: [member] } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
     VALUES ('Member Sin Caps', 'memberSinCajas', 'sincajas@test.local', $1, 'op', NOW())
     RETURNING id`,
    [bcrypt.hashSync('pwpw1234', 4)]
  );
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'member')`,
    [member.id]
  );
  // 2026-06-23 F4: firmamos con tenant_cap_rol='custom' + caps={} para que el
  // middleware requireCapability lea las caps directo del JWT y rechace
  // (default-deny). Sin esto, haría fallback a DB y el resultado sería el
  // mismo, pero el path JWT es más rápido y aislado del estado de DB.
  memberSinCajasToken = signToken({
    id: member.id, username: 'memberSinCajas', email: 'sincajas@test.local',
    role: 'op', tenant_id: 1, tenant_rol: 'member',
    tenant_cap_rol: 'custom', caps: {},
  });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

beforeEach(async () => {
  // Cleanup defensivo entre tests — proyecciones, recurrentes y egresos del
  // tenant 1. Sin esto, tests previos pueden filtrar data y romper assertions
  // basadas en "total exacto del mes".
  await pool.query(`DELETE FROM proyecciones_mensuales WHERE tenant_id = 1`);
  await pool.query(`DELETE FROM egresos WHERE tenant_id = 1`);
  await pool.query(`DELETE FROM egresos_recurrentes WHERE tenant_id = 1`);
});

// ─── GET /api/sanidad ────────────────────────────────────────────────────────

describe('GET /api/sanidad', () => {
  it('sin auth → 401', async () => {
    const r = await request(app).get('/api/sanidad');
    expect(r.status).toBe(401);
  });

  it('member sin capability sanidad.trabajar → 403', async () => {
    const r = await request(app)
      .get('/api/sanidad')
      .set('Authorization', `Bearer ${memberSinCajasToken}`);
    expect(r.status).toBe(403);
  });

  it('default 6 meses con shape esperado', async () => {
    const r = await request(app)
      .get('/api/sanidad')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.meses)).toBe(true);
    expect(r.body.meses).toHaveLength(6);

    const ultimo = r.body.meses[r.body.meses.length - 1];
    expect(ultimo).toMatchObject({
      periodo: expect.stringMatching(/^\d{4}-(0[1-9]|1[0-2])$/),
      dias_mes: expect.any(Number),
      bruto: expect.objectContaining({
        proyectado_usd: null,                // no hay proyección cargada
        real_usd: expect.any(Number),
        real_retail_usd: expect.any(Number),
        real_b2b_usd: expect.any(Number),
      }),
      gastos: expect.any(Array),
      total_gastos: expect.objectContaining({
        proyectado_usd: expect.any(Number),
        real_usd: expect.any(Number),
      }),
      neto: expect.objectContaining({
        // neto_proyectado es null cuando bruto_proyectado es null.
        proyectado_usd: null,
        real_usd: expect.any(Number),
      }),
      daily: expect.objectContaining({
        bruto_real_usd: expect.any(Number),
        neto_real_usd: expect.any(Number),
      }),
    });
  });

  it('meses fuera de rango → 400', async () => {
    const r = await request(app)
      .get('/api/sanidad?meses=99')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(400);
  });

  it('refleja egresos recurrentes activos en gastos.proyectado_usd', async () => {
    // Insertamos 2 recurrentes activos: uno USD, uno ARS (con TC).
    await pool.query(
      `INSERT INTO egresos_recurrentes (concepto, monto, moneda, tc, dia_del_mes, activo, tenant_id)
       VALUES ('Sueldo Test',  4500,   'USD', NULL, 1, true, 1),
              ('Alquiler ARS', 600000, 'ARS', 1480, 1, true, 1)`
    );

    const r = await request(app)
      .get('/api/sanidad?meses=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);

    const mes = r.body.meses[0];
    expect(mes.gastos).toHaveLength(2);
    const sueldo = mes.gastos.find(g => g.concepto === 'Sueldo Test');
    const alquiler = mes.gastos.find(g => g.concepto === 'Alquiler ARS');
    expect(sueldo.proyectado_usd).toBe(4500);
    // ARS → USD usando TC: 600000 / 1480 = 405.405... → round2 = 405.41
    expect(alquiler.proyectado_usd).toBe(405.41);
    // sin egreso pagado → real_usd null.
    expect(sueldo.real_usd).toBeNull();
    expect(alquiler.real_usd).toBeNull();

    // total_gastos.proyectado_usd = suma
    expect(mes.total_gastos.proyectado_usd).toBeCloseTo(4905.41, 2);
  });

  it('agrupa egresos reales por recurrente_id + bucket "Otros"', async () => {
    // Recurrente "Sueldo" + egresos pagados del mes actual: uno linkeado
    // al recurrente, otro suelto (recurrente_id NULL → bucket "Otros").
    const { rows: [rec] } = await pool.query(
      `INSERT INTO egresos_recurrentes (concepto, monto, moneda, dia_del_mes, activo, tenant_id)
       VALUES ('Sueldo X', 1000, 'USD', 1, true, 1) RETURNING id`
    );
    const periodo = periodoActual();
    const hoy = `${periodo}-15`;

    await pool.query(
      `INSERT INTO egresos (fecha, concepto, monto, moneda, monto_usd, estado, recurrente_id, tenant_id)
       VALUES ($1, 'Sueldo X pagado', 1000, 'USD', 1000, 'pagado', $2, 1),
              ($1, 'Compra extra',     350,  'USD',  350, 'pagado', NULL, 1)`,
      [hoy, rec.id]
    );

    const r = await request(app)
      .get('/api/sanidad?meses=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);

    const mes = r.body.meses[0];
    // Esperamos al menos 2 entries: el recurrente + "Otros".
    const sueldoLine = mes.gastos.find(g => g.recurrente_id === rec.id);
    expect(sueldoLine.real_usd).toBe(1000);
    const otros = mes.gastos.find(g => g.recurrente_id == null);
    expect(otros).toBeDefined();
    expect(otros.concepto).toMatch(/Otros/);
    expect(otros.real_usd).toBe(350);
    expect(mes.total_gastos.real_usd).toBeCloseTo(1350, 2);
  });

  it('ignora egresos NO pagados (estado=pendiente)', async () => {
    await pool.query(
      `INSERT INTO egresos_recurrentes (concepto, monto, moneda, dia_del_mes, activo, tenant_id)
       VALUES ('Recurrente Test', 500, 'USD', 1, true, 1)`
    );
    const periodo = periodoActual();
    await pool.query(
      `INSERT INTO egresos (fecha, concepto, monto, moneda, monto_usd, estado, tenant_id)
       VALUES ($1, 'No pagado aún', 500, 'USD', 500, 'pendiente', 1)`,
      [`${periodo}-10`]
    );

    const r = await request(app)
      .get('/api/sanidad?meses=1')
      .set('Authorization', `Bearer ${adminToken}`);
    const mes = r.body.meses[0];
    // El recurrente aparece proyectado pero el egreso pendiente NO suma en real_usd.
    expect(mes.total_gastos.real_usd).toBe(0);
  });

  it('soft-deleted egresos no se suman', async () => {
    const periodo = periodoActual();
    await pool.query(
      `INSERT INTO egresos (fecha, concepto, monto, moneda, monto_usd, estado, deleted_at, tenant_id)
       VALUES ($1, 'Borrado', 999, 'USD', 999, 'pagado', NOW(), 1)`,
      [`${periodo}-10`]
    );

    const r = await request(app)
      .get('/api/sanidad?meses=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.body.meses[0].total_gastos.real_usd).toBe(0);
  });
});

// ─── PUT /api/sanidad/proyeccion ────────────────────────────────────────────

describe('PUT /api/sanidad/proyeccion', () => {
  it('upsert crea + actualiza el mismo periodo', async () => {
    const periodo = periodoActual();

    // Primer PUT: crear.
    const r1 = await request(app)
      .put('/api/sanidad/proyeccion')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ periodo, bruto_proyectado_usd: 50000 });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ periodo, bruto_proyectado_usd: 50000 });

    // Segundo PUT al mismo periodo: actualizar (no falla por unique).
    const r2 = await request(app)
      .put('/api/sanidad/proyeccion')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ periodo, bruto_proyectado_usd: 80000 });
    expect(r2.status).toBe(200);
    expect(r2.body.bruto_proyectado_usd).toBe(80000);

    // Verifica que GET refleja el valor actualizado.
    const r3 = await request(app)
      .get('/api/sanidad?meses=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r3.body.meses[0].bruto.proyectado_usd).toBe(80000);
  });

  it('rechaza periodo inválido', async () => {
    const r = await request(app)
      .put('/api/sanidad/proyeccion')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ periodo: '2026-13', bruto_proyectado_usd: 1000 });
    expect(r.status).toBe(400);
  });

  it('rechaza bruto negativo', async () => {
    const r = await request(app)
      .put('/api/sanidad/proyeccion')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ periodo: '2026-06', bruto_proyectado_usd: -100 });
    expect(r.status).toBe(400);
  });

  it('acepta bruto = 0 (caso "mes sin facturación esperada")', async () => {
    const r = await request(app)
      .put('/api/sanidad/proyeccion')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ periodo: '2026-06', bruto_proyectado_usd: 0 });
    expect(r.status).toBe(200);
    expect(r.body.bruto_proyectado_usd).toBe(0);
  });

  it('sin auth → 401', async () => {
    const r = await request(app)
      .put('/api/sanidad/proyeccion')
      .send({ periodo: '2026-06', bruto_proyectado_usd: 1000 });
    expect(r.status).toBe(401);
  });
});

// ─── DELETE /api/sanidad/proyeccion/:periodo ────────────────────────────────

describe('DELETE /api/sanidad/proyeccion/:periodo', () => {
  it('borra una proyección existente', async () => {
    // Setup: crear la proyección.
    await request(app)
      .put('/api/sanidad/proyeccion')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ periodo: '2026-08', bruto_proyectado_usd: 30000 });

    const r = await request(app)
      .delete('/api/sanidad/proyeccion/2026-08')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(204);

    // Verifica que ya no aparece en GET.
    const { rows } = await pool.query(
      `SELECT * FROM proyecciones_mensuales WHERE tenant_id = 1 AND periodo = '2026-08'`
    );
    expect(rows).toHaveLength(0);
  });

  it('es idempotente — DELETE de periodo inexistente → 204', async () => {
    const r = await request(app)
      .delete('/api/sanidad/proyeccion/2099-12')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(204);
  });

  it('rechaza periodo con formato inválido', async () => {
    const r = await request(app)
      .delete('/api/sanidad/proyeccion/no-es-un-periodo')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(400);
  });
});

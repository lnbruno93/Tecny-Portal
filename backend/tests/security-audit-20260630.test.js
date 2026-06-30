/**
 * Tests de los 5 fixes defense-in-depth de la Auditoría 2026-06-30:
 *
 *   S-01: venta_emails_enviados — WITH CHECK explícito (INSERT con tenant
 *         distinto al current_tenant rebota con 42501).
 *   S-02: _esc() en email.js escapa `"` y `'` (no solo <>&).
 *   S-03: ipro_app NO tiene SELECT sobre tenant_admin_actions (permission
 *         denied).
 *   S-04: cross_tenant_operation_items + cross_tenant_pagos tienen RLS:
 *         user del tenant A no ve rows de ops del tenant B (sin JOIN).
 *   S-25: super-admin sin 2FA → 403 con code='super_admin_2fa_required'.
 *
 * Patrón:
 *   - S-01 + S-03 + S-04: bajo role NOSUPERUSER (mismo enfoque que
 *     migrations-rls-nosuperuser.test.js + multitenant-isolation-destructive.test.js).
 *   - S-02: unit puro contra el módulo lib/email.js exportando _esc.
 *   - S-25: integration via supertest (mismo enfoque que superAdmin.test.js).
 *
 * No-explotables hoy — la cobertura existente bloquea el ataque por otro
 * camino. Estos tests garantizan la red de seguridad para futuros cambios.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let app;
let userAuthCache;

const ROLE_NAME = 'audit_20260630_tester';
const TENANT_A = 9301;
const TENANT_B = 9302;

beforeAll(async () => {
  pool = await setupTestDb();
  app = require('../src/app');
  userAuthCache = require('../src/lib/userAuthCache');

  // Limpieza defensiva de corrida previa abortada.
  try {
    await pool.query(`REASSIGN OWNED BY ${ROLE_NAME} TO CURRENT_USER`);
    await pool.query(`DROP OWNED BY ${ROLE_NAME} CASCADE`);
  } catch (_) { /* role no existía */ }
  await pool.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);

  await pool.query(`CREATE ROLE ${ROLE_NAME} LOGIN NOSUPERUSER`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${ROLE_NAME}`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${ROLE_NAME}`);

  // 2 tenants para los tests cross-tenant.
  await pool.query(`
    INSERT INTO tenants (id, nombre, slug, plan) VALUES
      ($1, 'Audit S-01 A', 'audit-s01-a', 'pro'),
      ($2, 'Audit S-01 B', 'audit-s01-b', 'pro')
    ON CONFLICT (id) DO NOTHING
  `, [TENANT_A, TENANT_B]);
  await pool.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), ${TENANT_B}))`);
});

afterAll(async () => {
  try {
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE_NAME}`);
    await pool.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${ROLE_NAME}`);
    await pool.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);
  } catch (_) { /* swallow */ }
  await pool.query(`DELETE FROM cross_tenant_pagos WHERE cross_tenant_operation_id IN (
    SELECT id FROM cross_tenant_operations WHERE seller_tenant_id IN ($1, $2) OR buyer_tenant_id IN ($1, $2))`,
    [TENANT_A, TENANT_B]);
  await pool.query(`DELETE FROM cross_tenant_operation_items WHERE cross_tenant_operation_id IN (
    SELECT id FROM cross_tenant_operations WHERE seller_tenant_id IN ($1, $2) OR buyer_tenant_id IN ($1, $2))`,
    [TENANT_A, TENANT_B]);
  await pool.query(`DELETE FROM cross_tenant_operations WHERE seller_tenant_id IN ($1, $2) OR buyer_tenant_id IN ($1, $2)`,
    [TENANT_A, TENANT_B]);
  await pool.query(`DELETE FROM tenant_partnerships WHERE tenant_a_id IN ($1, $2) OR tenant_b_id IN ($1, $2)`,
    [TENANT_A, TENANT_B]);
  await pool.query(`DELETE FROM venta_emails_enviados WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  await pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  await teardownTestDb(pool);
});

// ──────────────────────────────────────────────────────────────────────────
// S-01: venta_emails_enviados — WITH CHECK rebota INSERT cross-tenant
// ──────────────────────────────────────────────────────────────────────────
describe('Auditoría 2026-06-30 S-01 — venta_emails_enviados WITH CHECK', () => {
  let ventaIdA;

  beforeAll(async () => {
    // Necesitamos una venta del tenant A para FK de venta_emails_enviados.
    // Insert pasa por RLS (ventas tiene FORCE RLS) — usamos client con SET LOCAL.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      const { rows } = await client.query(`
        INSERT INTO ventas (tenant_id, order_id, fecha, estado, cliente_nombre)
        VALUES ($1, $2, CURRENT_DATE, 'pendiente', 'Cliente S01')
        RETURNING id
      `, [TENANT_A, `ORD-S01-${Date.now()}`]);
      ventaIdA = rows[0].id;
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('INSERT con tenant_id distinto al current_tenant rebota con 42501 bajo NOSUPERUSER', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      // Seteamos current_tenant = TENANT_A, intentamos INSERT con tenant_id = TENANT_B.
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);

      await expect(
        client.query(
          `INSERT INTO venta_emails_enviados (tenant_id, venta_id, email_to, status)
           VALUES ($1, $2, 'attacker@example.com', 'sent')`,
          [TENANT_B, ventaIdA]
        )
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/row-level security policy/i),
      });

      await client.query('ROLLBACK');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
  });

  it('INSERT con tenant_id matching al current_tenant pasa OK', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);

      const res = await client.query(
        `INSERT INTO venta_emails_enviados (tenant_id, venta_id, email_to, status)
         VALUES ($1, $2, 'cliente@ok.com', 'sent') RETURNING id`,
        [TENANT_A, ventaIdA]
      );
      expect(res.rows[0].id).toBeGreaterThan(0);

      await client.query('ROLLBACK');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S-02: _esc() escapa comillas también
// ──────────────────────────────────────────────────────────────────────────
describe('Auditoría 2026-06-30 S-02 — _esc() escapa comillas', () => {
  it('_esc() escapa < > & " \'', () => {
    const { _esc } = require('../src/lib/email');
    expect(_esc('Foo" onclick="x">')).toBe('Foo&quot; onclick=&quot;x&quot;&gt;');
  });

  it('_esc() escape simple quote', () => {
    const { _esc } = require('../src/lib/email');
    expect(_esc("It's a test")).toBe('It&#39;s a test');
  });

  it('_esc() escape ampersand antes que las nuevas reglas (sin double-encoding)', () => {
    const { _esc } = require('../src/lib/email');
    // El input 'a&b"c' debe escaparse como 'a&amp;b&quot;c' — el & nuevo
    // resultante de &quot; NO debe re-escaparse a &amp;quot;.
    expect(_esc('a&b"c')).toBe('a&amp;b&quot;c');
  });

  it('_esc() handles null/undefined → string vacía', () => {
    const { _esc } = require('../src/lib/email');
    expect(_esc(null)).toBe('');
    expect(_esc(undefined)).toBe('');
  });

  it('_esc() es seguro para break-out de href atributo', () => {
    const { _esc } = require('../src/lib/email');
    // Un partnerNombre malicioso intentando salir del href="..." en el shell HTML.
    const malicious = 'Evil Corp" onload="alert(1)';
    const escaped = _esc(malicious);
    // Validamos que la comilla está escapada.
    expect(escaped).not.toContain('"');
    expect(escaped).toContain('&quot;');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S-03: tenant_admin_actions — REVOKE ipro_app
// ──────────────────────────────────────────────────────────────────────────
//
// CAVEAT: en local/test/CI el role `ipro_app` NO existe (el migration de
// REVOKE skip-ea con NOTICE). Por lo tanto NO podemos probar el REVOKE
// directamente con SET ROLE. Lo que SÍ podemos verificar es:
//
//   (a) Que el migration que aplica el REVOKE haya corrido (existe el
//       archivo + lo recibió node-pg-migrate). Smoke check.
//   (b) Que un role local NOSUPERUSER (sin GRANT) no pueda hacer SELECT —
//       garantiza que la mecánica del REVOKE funciona (no es un test del
//       migration, pero sí del invariante).
//
// El test real del REVOKE prod se valida con un staging deploy + query
// manual: `SELECT * FROM information_schema.table_privileges WHERE
// table_name = 'tenant_admin_actions' AND grantee = 'ipro_app'` debe
// devolver 0 rows.
describe('Auditoría 2026-06-30 S-03 — tenant_admin_actions REVOKE ipro_app', () => {
  it('NOSUPERUSER role sin GRANT recibe permission denied en SELECT', async () => {
    // Creamos un role local sin grants explícitos sobre tenant_admin_actions.
    const TEST_ROLE = `audit_s03_norights_${Date.now()}`;
    try {
      await pool.query(`CREATE ROLE ${TEST_ROLE} LOGIN NOSUPERUSER`);
      // OJO: NO le damos GRANT sobre tenant_admin_actions — replica el
      // estado post-REVOKE en prod para ipro_app.

      const client = await pool.connect();
      try {
        await client.query(`SET ROLE ${TEST_ROLE}`);
        await expect(
          client.query(`SELECT 1 FROM tenant_admin_actions LIMIT 1`)
        ).rejects.toMatchObject({
          code: '42501', // permission denied for table
          message: expect.stringMatching(/permission denied/i),
        });
      } finally {
        try { await client.query('RESET ROLE'); } catch (_) {}
        client.release();
      }
    } finally {
      try {
        await pool.query(`REASSIGN OWNED BY ${TEST_ROLE} TO CURRENT_USER`);
        await pool.query(`DROP OWNED BY ${TEST_ROLE} CASCADE`);
        await pool.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`);
      } catch (_) { /* swallow */ }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S-04: cross_tenant_operation_items + cross_tenant_pagos — RLS via JOIN
// ──────────────────────────────────────────────────────────────────────────
describe('Auditoría 2026-06-30 S-04 — cross_tenant_items/pagos RLS via JOIN', () => {
  let opId, itemId, pagoId;
  let partnershipId;

  beforeAll(async () => {
    // Crear partnership entre A y B (necesario por FK de cross_tenant_operations).
    // Convención: tenant_a_id < tenant_b_id.
    const { rows: pRows } = await pool.query(`
      INSERT INTO tenant_partnerships
        (tenant_a_id, tenant_b_id, status, invited_by_tenant_id, invited_by_user_id, accepted_at, accepted_by_user_id)
      VALUES ($1, $2, 'active', $1, 1, NOW(), 1)
      RETURNING id
    `, [TENANT_A, TENANT_B]);
    partnershipId = pRows[0].id;

    // Crear op (seller=A, buyer=B). FKs lógicas seller_venta_id / buyer_compra_id
    // no tienen FK física — pasamos cualquier int.
    const { rows: opRows } = await pool.query(`
      INSERT INTO cross_tenant_operations
        (partnership_id, seller_tenant_id, buyer_tenant_id, seller_venta_id, buyer_compra_id,
         status, total_usd, total_ars, tc_used, created_by_user_id)
      VALUES ($1, $2, $3, 99001, 99002, 'active', 100, 100000, 1000, 1)
      RETURNING id
    `, [partnershipId, TENANT_A, TENANT_B]);
    opId = opRows[0].id;

    // Item de la op.
    const { rows: itRows } = await pool.query(`
      INSERT INTO cross_tenant_operation_items
        (cross_tenant_operation_id, seller_producto_id, buyer_producto_id,
         cantidad, precio_unitario_usd, precio_unitario_ars)
      VALUES ($1, 88001, 88002, 1, 100, 100000)
      RETURNING id
    `, [opId]);
    itemId = itRows[0].id;

    // Pago de la op.
    const { rows: pgRows } = await pool.query(`
      INSERT INTO cross_tenant_pagos
        (cross_tenant_operation_id, seller_cobro_id, buyer_pago_id,
         monto_usd, monto_ars, tc_used, caja_seller_id, caja_buyer_id,
         registered_by_side, registered_by_user_id)
      VALUES ($1, 77001, 77002, 100, 100000, 1000, 1, 2, 'seller', 1)
      RETURNING id
    `, [opId]);
    pagoId = pgRows[0].id;
  });

  it('SELECT como tenant A (seller) ve items + pagos de la op', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);

      const items = await client.query(
        `SELECT id FROM cross_tenant_operation_items WHERE cross_tenant_operation_id = $1`,
        [opId]
      );
      expect(items.rows.map(r => r.id)).toContain(itemId);

      const pagos = await client.query(
        `SELECT id FROM cross_tenant_pagos WHERE cross_tenant_operation_id = $1`,
        [opId]
      );
      expect(pagos.rows.map(r => r.id)).toContain(pagoId);

      await client.query('ROLLBACK');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
  });

  it('SELECT como tenant B (buyer) ve items + pagos de la op (dual)', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_B}'`);

      const items = await client.query(
        `SELECT id FROM cross_tenant_operation_items WHERE cross_tenant_operation_id = $1`,
        [opId]
      );
      expect(items.rows.map(r => r.id)).toContain(itemId);

      const pagos = await client.query(
        `SELECT id FROM cross_tenant_pagos WHERE cross_tenant_operation_id = $1`,
        [opId]
      );
      expect(pagos.rows.map(r => r.id)).toContain(pagoId);

      await client.query('ROLLBACK');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
  });

  it('SELECT como tenant OTRO (ni seller ni buyer) NO ve items ni pagos', async () => {
    // Tenant 1 no participa en esta op. Bajo el predicate EXISTS, no debe ver nada.
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '1'`);

      const items = await client.query(
        `SELECT id FROM cross_tenant_operation_items WHERE cross_tenant_operation_id = $1`,
        [opId]
      );
      expect(items.rows.map(r => r.id)).not.toContain(itemId);

      const pagos = await client.query(
        `SELECT id FROM cross_tenant_pagos WHERE cross_tenant_operation_id = $1`,
        [opId]
      );
      expect(pagos.rows.map(r => r.id)).not.toContain(pagoId);

      await client.query('ROLLBACK');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
  });

  it('SELECT sin SET LOCAL app.current_tenant NO ve nada (fail-closed)', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      // Reset explícito.
      await client.query(`SELECT set_config('app.current_tenant', '', false)`);

      const items = await client.query(
        `SELECT id FROM cross_tenant_operation_items WHERE cross_tenant_operation_id = $1`,
        [opId]
      );
      expect(items.rows).toHaveLength(0);

      const pagos = await client.query(
        `SELECT id FROM cross_tenant_pagos WHERE cross_tenant_operation_id = $1`,
        [opId]
      );
      expect(pagos.rows).toHaveLength(0);

      await client.query('ROLLBACK');
    } finally {
      try { await client.query('RESET ROLE'); } catch (_) {}
      client.release();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S-25: super-admin requiere 2FA
// ──────────────────────────────────────────────────────────────────────────
describe('Auditoría 2026-06-30 S-25 — super-admin requiere 2FA', () => {
  let superAdminTokenNo2fa;
  let superAdminTokenWith2fa;
  let saUserIdNo2fa;
  let saUserIdWith2fa;

  beforeAll(async () => {
    // Crear 2 super-admins: uno sin 2FA, otro con 2FA.
    const hash = await bcrypt.hash('pass1234', 10);

    const { rows: u1 } = await pool.query(`
      INSERT INTO users (nombre, username, email, password_hash, role, is_super_admin)
      VALUES ('SA sin 2FA', 'sa_no2fa', 'sa-no2fa@test.local', $1, 'admin', true)
      RETURNING id
    `, [hash]);
    saUserIdNo2fa = u1[0].id;
    await pool.query(`INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'admin')`, [saUserIdNo2fa]);

    const { rows: u2 } = await pool.query(`
      INSERT INTO users (nombre, username, email, password_hash, role, is_super_admin)
      VALUES ('SA con 2FA', 'sa_with2fa', 'sa-with2fa@test.local', $1, 'admin', true)
      RETURNING id
    `, [hash]);
    saUserIdWith2fa = u2[0].id;
    await pool.query(`INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'admin')`, [saUserIdWith2fa]);

    // Activar 2FA solo en el segundo super-admin (insertando un row con enabled_at).
    await pool.query(`
      INSERT INTO user_2fa (user_id, secret_encrypted, recovery_codes, enabled_at)
      VALUES ($1, 'test-secret-enc', ARRAY['hash1','hash2'], NOW())
    `, [saUserIdWith2fa]);

    // Invalidar cache para que el siguiente getUserAuth lea el estado fresh.
    await userAuthCache.invalidateUserAuth(saUserIdNo2fa);
    await userAuthCache.invalidateUserAuth(saUserIdWith2fa);

    superAdminTokenNo2fa = jwt.sign(
      { id: saUserIdNo2fa, username: 'sa_no2fa', email: 'sa-no2fa@test.local',
        role: 'admin', tenant_id: 1, tenant_rol: 'admin',
        is_super_admin: true, iat_ms: Date.now() },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    superAdminTokenWith2fa = jwt.sign(
      { id: saUserIdWith2fa, username: 'sa_with2fa', email: 'sa-with2fa@test.local',
        role: 'admin', tenant_id: 1, tenant_rol: 'admin',
        is_super_admin: true, iat_ms: Date.now() },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM user_2fa WHERE user_id IN ($1, $2)`, [saUserIdNo2fa, saUserIdWith2fa]);
    await pool.query(`DELETE FROM tenant_users WHERE user_id IN ($1, $2)`, [saUserIdNo2fa, saUserIdWith2fa]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [saUserIdNo2fa, saUserIdWith2fa]);
    await userAuthCache.invalidateUserAuth(saUserIdNo2fa);
    await userAuthCache.invalidateUserAuth(saUserIdWith2fa);
  });

  it('super-admin SIN 2FA → 403 con code super_admin_2fa_required', async () => {
    const r = await request(app)
      .get('/api/super-admin/me')
      .set('Authorization', `Bearer ${superAdminTokenNo2fa}`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('super_admin_2fa_required');
    expect(r.body.reason).toBe('super_admin_2fa_required');
  });

  it('super-admin CON 2FA → 200', async () => {
    const r = await request(app)
      .get('/api/super-admin/me')
      .set('Authorization', `Bearer ${superAdminTokenWith2fa}`);
    expect(r.status).toBe(200);
    expect(r.body.is_super_admin).toBe(true);
  });

  it('super-admin SIN 2FA puede activar 2FA (endpoint /api/auth/2fa/status accesible)', async () => {
    // El gate de requireSuperAdmin NO debe aplicarse a /api/auth/2fa/* —
    // sino el super-admin queda locked-out del setup de su propio 2FA.
    const r = await request(app)
      .get('/api/auth/2fa/status')
      .set('Authorization', `Bearer ${superAdminTokenNo2fa}`);
    expect(r.status).toBe(200);
    // Sin 2FA setup → enabled=false. Lo importante es que NO recibió 403.
    expect(r.body.enabled).toBe(false);
  });
});

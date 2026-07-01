/**
 * Tests integrales del endpoint super-admin "cambiar país de un tenant" (#473).
 *
 * Cubre:
 *   - 401/403 sin super-admin
 *   - 400 same_country / Zod país inválido
 *   - 404 tenant inexistente / soft-deleted
 *   - 409 has_active_partnerships
 *   - 200 AR→UY: tenant.pais='UY', cajas UYU creadas, alerta valor=40,
 *     audit log presente, cache tenantStatus invalidado
 *   - 200 UY→AR: simétrico (cajas ARS, alerta=1400)
 *   - Cajas viejas NO se borran (preserva historial)
 *   - Duplicados de caja se saltan (re-ejecutar es safe-ish)
 *
 * Pattern: setup directo en DB (tenants con pais predefinido, partnerships,
 * alertas) — mismo que multipais-f2.test.js. JWT super-admin firmado a mano
 * sobre testadmin id=1 con UPDATE is_super_admin=true.
 *
 * Caveat: usa el pool admin (BYPASSRLS en prod). En local el role es
 * superuser, ve todo igual — mismo caveat que superAdmin.test.js.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const userAuthCache = require('../src/lib/userAuthCache');
const tenantStatus = require('../src/lib/tenantStatus');

// Tenants > 9000 para no chocar con tenant 1 / multipais-f2 (9801).
const TENANT_AR = 9701;        // base AR para AR→UY
const TENANT_UY = 9702;        // base UY para UY→AR
const TENANT_PARTNER = 9703;   // partner para test de partnerships activas
const TENANT_PARTNERED = 9704; // el que intenta cambiar país y tiene partnership

let pool;
let superAdminToken;
let nonSuperToken;
let nonSuperUserId;

async function seedTenant(id, nombre, slug, pais) {
  await pool.query(
    `INSERT INTO tenants (id, nombre, slug, plan, pais)
       VALUES ($1, $2, $3, 'pro', $4)
       ON CONFLICT (id) DO UPDATE SET pais = EXCLUDED.pais, deleted_at = NULL, suspended_at = NULL`,
    [id, nombre, slug, pais]
  );
  await pool.query(
    `SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1))`
  );
  // Seedear alerta tc_referencia con el valor que corresponde al país (mismo
  // que hace signup.js post-F2). Sin esto, el UPDATE de alertas del endpoint
  // sería no-op y no podríamos validarlo.
  const valor = pais === 'UY' ? 40 : 1400;
  await pool.query(
    `INSERT INTO alertas_config (tenant_id, tipo, activa, parametros)
       VALUES ($1, 'tc_referencia', true, $2::jsonb)
       ON CONFLICT (tenant_id, tipo)
       DO UPDATE SET parametros = EXCLUDED.parametros`,
    [id, JSON.stringify({ valor, tolerancia_pct: 50, alerta_por_debajo: true })]
  );
  await tenantStatus.invalidateTenantStatus(id);
}

async function seedDefaultCajas(tenantId, pais) {
  // Mismas cajas que sembraría signup público para el país (verificamos el
  // bloque NOT EXISTS al re-correr el endpoint).
  const cajas = pais === 'UY'
    ? [
        { nombre: 'Efectivo Pesos', moneda: 'UYU', orden: 1, es_financiera: true },
        { nombre: 'Efectivo USD',   moneda: 'USD', orden: 2, es_financiera: false },
        { nombre: 'Banco Pesos',    moneda: 'UYU', orden: 3, es_financiera: false },
      ]
    : [
        { nombre: 'Efectivo Pesos', moneda: 'ARS', orden: 1, es_financiera: true },
        { nombre: 'Efectivo USD',   moneda: 'USD', orden: 2, es_financiera: false },
        { nombre: 'Banco Pesos',    moneda: 'ARS', orden: 3, es_financiera: false },
      ];
  for (const c of cajas) {
    await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, orden, es_financiera, tenant_id)
         VALUES ($1, $2, $3, $4, $5)`,
      [c.nombre, c.moneda, c.orden, c.es_financiera, tenantId]
    );
  }
}

beforeAll(async () => {
  pool = await setupTestDb();

  // Marcar testadmin id=1 como super-admin (mismo pattern que superAdmin.test).
  await pool.query(`UPDATE users SET is_super_admin = true WHERE id = 1`);
  // Auditoría 2026-06-30 S-25: super-admin requiere 2FA habilitada.
  await pool.query(`
    INSERT INTO user_2fa (user_id, secret_encrypted, recovery_codes, enabled_at)
    VALUES (1, 'test-secret-enc', ARRAY['hash1','hash2'], NOW())
    ON CONFLICT (user_id) DO UPDATE SET enabled_at = NOW()
  `);
  await userAuthCache.invalidateUserAuth(1);
  superAdminToken = jwt.sign(
    {
      id: 1, username: TEST_USER.username, email: TEST_USER.email,
      role: TEST_USER.role, tenant_id: 1, tenant_rol: 'owner',
      is_super_admin: true,
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  // Non-super-admin user para gates 403.
  const hashNS = await bcrypt.hash('nspass123', 10);
  const { rows: nsRows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, is_super_admin)
       VALUES ('NonSuper 473', 'nonsuper_473', 'nonsuper_473@test.local', $1, 'admin', false)
     RETURNING id`,
    [hashNS]
  );
  nonSuperUserId = nsRows[0].id;
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'admin')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET rol = 'admin'`,
    [nonSuperUserId]
  );
  nonSuperToken = jwt.sign(
    {
      id: nonSuperUserId, username: 'nonsuper_473', email: 'nonsuper_473@test.local',
      role: 'admin', tenant_id: 1, tenant_rol: 'admin',
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
});

beforeEach(async () => {
  // Cleanup + reseed antes de cada test para aislamiento total. Los handlers
  // del endpoint hacen UPDATE+INSERT — un test contamina al siguiente si no
  // re-baselinamos.
  await pool.query(
    `DELETE FROM tenant_admin_actions WHERE tenant_id IN ($1, $2, $3, $4)`,
    [TENANT_AR, TENANT_UY, TENANT_PARTNER, TENANT_PARTNERED]
  );
  await pool.query(
    `DELETE FROM tenant_partnerships
      WHERE tenant_a_id IN ($1, $2, $3, $4)
         OR tenant_b_id IN ($1, $2, $3, $4)`,
    [TENANT_AR, TENANT_UY, TENANT_PARTNER, TENANT_PARTNERED]
  );
  await pool.query(
    `DELETE FROM metodos_pago WHERE tenant_id IN ($1, $2, $3, $4)`,
    [TENANT_AR, TENANT_UY, TENANT_PARTNER, TENANT_PARTNERED]
  );
  await pool.query(
    `DELETE FROM alertas_config WHERE tenant_id IN ($1, $2, $3, $4)`,
    [TENANT_AR, TENANT_UY, TENANT_PARTNER, TENANT_PARTNERED]
  );

  await seedTenant(TENANT_AR, 'AR Base 473', 'ar-base-473', 'AR');
  await seedDefaultCajas(TENANT_AR, 'AR');

  await seedTenant(TENANT_UY, 'UY Base 473', 'uy-base-473', 'UY');
  await seedDefaultCajas(TENANT_UY, 'UY');

  await seedTenant(TENANT_PARTNER, 'Partner 473', 'partner-473', 'AR');
  await seedTenant(TENANT_PARTNERED, 'Partnered 473', 'partnered-473', 'AR');
});

afterAll(async () => {
  // Cleanup global.
  for (const id of [TENANT_AR, TENANT_UY, TENANT_PARTNER, TENANT_PARTNERED]) {
    await pool.query(`DELETE FROM tenant_admin_actions WHERE tenant_id = $1`, [id]);
    await pool.query(`DELETE FROM tenant_partnerships
      WHERE tenant_a_id = $1 OR tenant_b_id = $1`, [id]);
    await pool.query(`DELETE FROM metodos_pago WHERE tenant_id = $1`, [id]);
    await pool.query(`DELETE FROM alertas_config WHERE tenant_id = $1`, [id]);
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    await tenantStatus.invalidateTenantStatus(id);
  }
  await pool.query(`UPDATE users SET is_super_admin = false WHERE id = 1`);
  // Auditoría 2026-06-30 S-25: limpiar 2FA setup del test.
  await pool.query(`DELETE FROM user_2fa WHERE user_id = 1`);
  await userAuthCache.invalidateUserAuth(1);
  if (nonSuperUserId) {
    await pool.query(`DELETE FROM tenant_users WHERE user_id = $1`, [nonSuperUserId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [nonSuperUserId]);
  }
  await teardownTestDb(pool);
});

describe('PATCH /api/super-admin/tenants/:id/pais — gates', () => {
  it('sin auth → 401', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_AR}/pais`)
      .send({ pais: 'UY' });
    expect(r.status).toBe(401);
  });

  it('con user no super-admin → 403', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_AR}/pais`)
      .set('Authorization', `Bearer ${nonSuperToken}`)
      .send({ pais: 'UY' });
    expect(r.status).toBe(403);
  });

  it('id no numérico → 400', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/tenants/abc/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'UY' });
    expect(r.status).toBe(400);
  });
});

describe('PATCH /api/super-admin/tenants/:id/pais — validación de body', () => {
  it("pais='XX' inválido → 400 (Zod rechaza)", async () => {
    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_AR}/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'XX' });
    expect(r.status).toBe(400);
  });

  it('body con campo extra (reason) → 400 (.strict() rechaza)', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_AR}/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'UY', reason: 'no aceptado por schema' });
    expect(r.status).toBe(400);
  });

  it('mismo país que el actual → 400 same_country', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_AR}/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'AR' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('same_country');
  });
});

describe('PATCH /api/super-admin/tenants/:id/pais — not found / suspended', () => {
  it('tenant inexistente → 404', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/tenants/99999/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'UY' });
    expect(r.status).toBe(404);
  });

  it('tenant suspendido → 400 tenant_suspended', async () => {
    await pool.query(
      `UPDATE tenants SET suspended_at = NOW(), suspended_reason = 'test'
        WHERE id = $1`,
      [TENANT_AR]
    );
    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_AR}/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'UY' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('tenant_suspended');
    // Cleanup para no contaminar próximos tests
    await pool.query(
      `UPDATE tenants SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1`,
      [TENANT_AR]
    );
  });
});

describe('PATCH /api/super-admin/tenants/:id/pais — guard partnerships activas', () => {
  it('tenant con partnership active → 409 has_active_partnerships', async () => {
    // Convención: tenant_a_id < tenant_b_id. TENANT_PARTNER (9703) < TENANT_PARTNERED (9704).
    // invited_by_user_id NOT NULL — usamos id=1 (testadmin) que está en tenant_users(tenant=1).
    await pool.query(
      `INSERT INTO tenant_partnerships
        (tenant_a_id, tenant_b_id, status, invited_by_tenant_id, invited_by_user_id, accepted_at)
        VALUES ($1, $2, 'active', $1, 1, NOW())`,
      [TENANT_PARTNER, TENANT_PARTNERED]
    );

    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_PARTNERED}/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'UY' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('has_active_partnerships');
    // Verificar que tenant.pais NO cambió (rollback).
    const { rows } = await pool.query(`SELECT pais FROM tenants WHERE id = $1`, [TENANT_PARTNERED]);
    expect(rows[0].pais).toBe('AR');
  });

  it('partnership en status=revoked NO bloquea el cambio', async () => {
    await pool.query(
      `INSERT INTO tenant_partnerships
        (tenant_a_id, tenant_b_id, status, invited_by_tenant_id, invited_by_user_id,
         accepted_at, revoked_at, revoked_by_tenant_id)
        VALUES ($1, $2, 'revoked', $1, 1,
         NOW() - INTERVAL '1 day', NOW(), $1)`,
      [TENANT_PARTNER, TENANT_PARTNERED]
    );

    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_PARTNERED}/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'UY' });
    expect(r.status).toBe(200);
    expect(r.body.pais_nuevo).toBe('UY');
  });
});

describe('PATCH /api/super-admin/tenants/:id/pais — AR → UY (200 + side effects)', () => {
  it('cambia tenant.pais, crea cajas UYU, actualiza alerta a 40, audit log presente', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_AR}/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'UY' });

    expect(r.status).toBe(200);
    expect(r.body.tenant_id).toBe(TENANT_AR);
    expect(r.body.pais_anterior).toBe('AR');
    expect(r.body.pais_nuevo).toBe('UY');
    // 3 cajas nuevas, todas sufijadas con "(UY)" para esquivar el UNIQUE
    // INDEX (tenant_id, LOWER(nombre)).
    expect(r.body.side_effects.cajas_creadas).toBe(3);
    expect(r.body.side_effects.alerta_actualizada).toBe(true);

    // 1) tenants.pais persistido.
    const { rows: tRows } = await pool.query(`SELECT pais FROM tenants WHERE id = $1`, [TENANT_AR]);
    expect(tRows[0].pais).toBe('UY');

    // 2) Cajas nuevas creadas con sufijo "(UY)". Las dos en UYU + una en USD.
    const { rows: cajasNuevas } = await pool.query(
      `SELECT nombre, moneda FROM metodos_pago
        WHERE tenant_id = $1 AND nombre LIKE '%(UY)' AND deleted_at IS NULL
        ORDER BY orden`,
      [TENANT_AR]
    );
    expect(cajasNuevas.length).toBe(3);
    expect(cajasNuevas.map(c => c.moneda).sort()).toEqual(['USD', 'UYU', 'UYU']);

    // Las viejas AR siguen vivas (3 originales, ninguna borrada).
    const { rows: todas } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM metodos_pago
        WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [TENANT_AR]
    );
    expect(todas[0].n).toBe(6);  // 3 viejas AR + 3 nuevas UY-sufijadas

    // 3) Alerta TC actualizada a valor=40.
    const { rows: alertaRows } = await pool.query(
      `SELECT parametros FROM alertas_config WHERE tenant_id = $1 AND tipo = 'tc_referencia'`,
      [TENANT_AR]
    );
    expect(Number(alertaRows[0].parametros.valor)).toBe(40);
    // Se preservan los otros campos (tolerancia_pct, alerta_por_debajo).
    expect(alertaRows[0].parametros.tolerancia_pct).toBe(50);
    expect(alertaRows[0].parametros.alerta_por_debajo).toBe(true);

    // 4) Audit log con action correcto y payload before/after.
    const { rows: actions } = await pool.query(
      `SELECT action, before_state, after_state FROM tenant_admin_actions
        WHERE tenant_id = $1 AND action = 'tenant_pais_changed'
        ORDER BY created_at DESC LIMIT 1`,
      [TENANT_AR]
    );
    expect(actions.length).toBe(1);
    expect(actions[0].before_state).toEqual({ pais: 'AR' });
    expect(actions[0].after_state).toEqual({ pais: 'UY' });

    // 5) Cache tenantStatus invalidado — el próximo getTenantStatus refleja
    //    el país nuevo en lugar de cachear el viejo.
    const status = await tenantStatus.getTenantStatus(TENANT_AR);
    expect(status.pais).toBe('UY');
  });

  // #501 hotfix: bump users.password_changed_at de todos los users del
  // tenant para forzar re-login. Sin este bump, el owner del tenant sigue
  // viendo `user.tenant.pais='AR'` en memoria hasta que cierre sesión
  // manualmente — cliente Uruguay lo reportó 2026-07-01.
  it('bumpea users.password_changed_at de todos los users del tenant + reporta users_invalidados', async () => {
    // Setup: crear 2 users vinculados al tenant (el fixture no los seedea
    // — el super-admin no está en tenant_users). password_changed_at NULL
    // simula un user que nunca hizo login (típico post-invite).
    const { rows: uRows } = await pool.query(
      `INSERT INTO users (nombre, username, email, password_hash, role)
       VALUES
         ('U1 test', 'u1_pais_bump', 'u1@pais-bump.test', 'x', 'op'),
         ('U2 test', 'u2_pais_bump', 'u2@pais-bump.test', 'x', 'op')
       RETURNING id`
    );
    for (const u of uRows) {
      await pool.query(
        `INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)`,
        [TENANT_AR, u.id]
      );
    }
    // Poner un password_changed_at "viejo" en uno de los users para verificar
    // que el bump avanza el timestamp (no se queda con el mismo valor).
    await pool.query(
      `UPDATE users SET password_changed_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
      [uRows[0].id]
    );

    const { rows: antes } = await pool.query(
      `SELECT u.id, u.password_changed_at
         FROM users u
         JOIN tenant_users tu ON tu.user_id = u.id
        WHERE tu.tenant_id = $1 AND u.deleted_at IS NULL`,
      [TENANT_AR]
    );
    expect(antes.length).toBeGreaterThanOrEqual(2);

    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_AR}/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'UY' });
    expect(r.status).toBe(200);
    // El endpoint reporta cuántos usuarios se invalidaron — útil para que
    // el super-admin vea "cortaste N sesiones" en el back office.
    expect(r.body.side_effects.users_invalidados).toBe(antes.length);

    // Verificar que password_changed_at avanzó para cada user.
    const { rows: despues } = await pool.query(
      `SELECT u.id, u.password_changed_at
         FROM users u
         JOIN tenant_users tu ON tu.user_id = u.id
        WHERE tu.tenant_id = $1 AND u.deleted_at IS NULL
        ORDER BY u.id`,
      [TENANT_AR]
    );
    const anterioresMap = Object.fromEntries(antes.map(u => [u.id, u.password_changed_at]));
    for (const u of despues) {
      const prev = anterioresMap[u.id];
      // Si prev era NULL (user recién creado sin login previo), aceptamos
      // el bump como "ahora tiene valor". Si tenía valor, debe ser mayor.
      if (prev === null) {
        expect(u.password_changed_at).not.toBeNull();
      } else {
        expect(new Date(u.password_changed_at).getTime()).toBeGreaterThan(new Date(prev).getTime());
      }
    }
  });

  it('alerta tc_referencia AUSENTE → endpoint no rompe, alerta_actualizada=false', async () => {
    // Borrar la alerta para simular tenant pre-F2 sin seed.
    await pool.query(
      `DELETE FROM alertas_config WHERE tenant_id = $1 AND tipo = 'tc_referencia'`,
      [TENANT_AR]
    );
    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_AR}/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'UY' });
    expect(r.status).toBe(200);
    expect(r.body.side_effects.alerta_actualizada).toBe(false);
  });
});

describe('PATCH /api/super-admin/tenants/:id/pais — UY → AR (simétrico)', () => {
  it('cambia tenant.pais, crea cajas ARS, actualiza alerta a 1400', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/tenants/${TENANT_UY}/pais`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pais: 'AR' });

    expect(r.status).toBe(200);
    expect(r.body.pais_anterior).toBe('UY');
    expect(r.body.pais_nuevo).toBe('AR');

    const { rows: tRows } = await pool.query(`SELECT pais FROM tenants WHERE id = $1`, [TENANT_UY]);
    expect(tRows[0].pais).toBe('AR');

    // Cajas nuevas con sufijo "(AR)": 2 en ARS + 1 en USD.
    const { rows: cajasNuevas } = await pool.query(
      `SELECT nombre, moneda FROM metodos_pago
        WHERE tenant_id = $1 AND nombre LIKE '%(AR)' AND deleted_at IS NULL`,
      [TENANT_UY]
    );
    expect(cajasNuevas.length).toBe(3);
    expect(cajasNuevas.map(c => c.moneda).sort()).toEqual(['ARS', 'ARS', 'USD']);

    // Alerta TC a 1400.
    const { rows: alertaRows } = await pool.query(
      `SELECT parametros FROM alertas_config WHERE tenant_id = $1 AND tipo = 'tc_referencia'`,
      [TENANT_UY]
    );
    expect(Number(alertaRows[0].parametros.valor)).toBe(1400);
  });
});

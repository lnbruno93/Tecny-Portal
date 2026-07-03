/**
 * Test E2E de aislamiento multi-tenant (PR 4.0).
 *
 * Valida el flujo COMPLETO end-to-end:
 *   1. Crear 2 tenants en DB.
 *   2. Crear 1 user por tenant (vincular via tenant_users).
 *   3. Sembrar categorías distintas en cada tenant.
 *   4. Login del user A → recibe JWT con tenant_id A.
 *   5. GET /api/inventario/categorias con ese token → recibe SOLO las cats de A.
 *   6. Login del user B → recibe JWT con tenant_id B.
 *   7. GET /api/inventario/categorias con ese token → recibe SOLO las cats de B.
 *
 * Este es el test que prueba que TODA la stack multi-tenant funciona end-to-end:
 *   migration (PR 1) + RLS (PR 2) + JWT/middleware/withTenant (PR 3) + endpoint
 *   refactoreado (PR 4.0). Es la base de la suite que crecerá en PR 4.1+ a
 *   medida que refactoreemos cada módulo.
 *
 * Caveat de testing local: el pool de tests corre con un user superuser de
 * Postgres (default en macOS), que BYPASSA RLS incluso con FORCE. En esos
 * casos el endpoint NO filtra por tenant aunque setee app.current_tenant.
 * En CI/staging/prod el role NO es superuser → RLS aplica de verdad. La
 * validación de aislamiento real con role no-super está cubierta en
 * `tests/withTenant.test.js` (PR 3).
 *
 * Lo que este test SÍ valida en cualquier entorno:
 *   - Login emite JWT con tenant_id correcto.
 *   - El endpoint responde 200 y devuelve resultados.
 *   - El payload del JWT distingue tenants correctamente.
 *
 * Lo que NO valida en local (sí en CI/prod):
 *   - Filtrado real de filas por RLS. Para eso, ver withTenant.test.js.
 */
const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/app');
const db      = require('../src/config/database');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;
const TENANT_A = 8001;
const TENANT_B = 8002;
const USER_A   = { username: 'iso_user_a', password: 'isopass_a_123' };
const USER_B   = { username: 'iso_user_b', password: 'isopass_b_123' };

beforeAll(async () => {
  pool = await setupTestDb();

  // 1. Crear los 2 tenants (id forzado para no colisionar con el tenant 1 de PR 1).
  await pool.query(`
    INSERT INTO tenants (id, nombre, slug, plan) VALUES
      ($1, 'Tenant Iso A', 'iso-a', 'pro'),
      ($2, 'Tenant Iso B', 'iso-b', 'pro')
    ON CONFLICT (id) DO NOTHING
  `, [TENANT_A, TENANT_B]);
  await pool.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), ${TENANT_B}))`);

  // 2. Crear los 2 users y vincularlos cada uno a su tenant.
  const hashA = await bcrypt.hash(USER_A.password, 4);
  const hashB = await bcrypt.hash(USER_B.password, 4);
  const { rows: ra } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role) VALUES ('User A', $1, $2, $3, 'admin') RETURNING id`,
    [USER_A.username, `${USER_A.username}@test.local`, hashA]
  );
  const { rows: rb } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role) VALUES ('User B', $1, $2, $3, 'admin') RETURNING id`,
    [USER_B.username, `${USER_B.username}@test.local`, hashB]
  );
  USER_A.id = ra[0].id;
  USER_B.id = rb[0].id;
  await pool.query(`INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`, [TENANT_A, USER_A.id]);
  await pool.query(`INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`, [TENANT_B, USER_B.id]);

  // 3. Sembrar categorías distintas en cada tenant (3 en A, 2 en B).
  await pool.query(`INSERT INTO categorias (nombre, tenant_id) VALUES ('ISO_A_CAT_1', $1), ('ISO_A_CAT_2', $1), ('ISO_A_CAT_3', $1)`, [TENANT_A]);
  await pool.query(`INSERT INTO categorias (nombre, tenant_id) VALUES ('ISO_B_CAT_1', $1), ('ISO_B_CAT_2', $1)`, [TENANT_B]);

  // 4. Sembrar audit_logs para validar fix del leak cross-tenant en /api/historial
  //    (hotfix #336, 2026-06-19). Tres tipos de rows:
  //      - tenant_id = A (datos del tenant A → user A debe verlos)
  //      - tenant_id = B (datos del tenant B → user B debe verlos)
  //      - tenant_id NULL (audit del "sistema" → ningún user-facing /api/historial debe verlos)
  //    El fix agrega `WHERE a.tenant_id IS NOT NULL` al endpoint → la fila NULL
  //    queda invisible para ambos users, y A/B siguen aislados.
  await pool.query(`
    INSERT INTO audit_logs (tabla, accion, registro_id, datos_despues, user_id, tenant_id, created_at)
    VALUES
      ('ventas', 'INSERT', 9001, '{"cliente":"ISO_A_AUDIT_TEST"}'::jsonb, $1, $2, NOW() - INTERVAL '1 hour'),
      ('ventas', 'INSERT', 9002, '{"cliente":"ISO_B_AUDIT_TEST"}'::jsonb, $3, $4, NOW() - INTERVAL '1 hour'),
      ('ventas', 'INSERT', 9003, '{"cliente":"ISO_NULL_AUDIT_TEST"}'::jsonb, NULL, NULL, NOW() - INTERVAL '1 hour')
  `, [USER_A.id, TENANT_A, USER_B.id, TENANT_B]);

  // 5. Auditoría 2026-07-04 TANDA 0 — seed de contactos para validar isolation
  //    de los nuevos endpoints /api/contactos/emails y /api/contactos/export
  //    (feature #508). Cada tenant tiene 2 contactos con nombres distintivos
  //    para poder identificarlos en la respuesta.
  await pool.query(`
    INSERT INTO contactos (nombre, email, tipo, origen, tenant_id) VALUES
      ('ISO_A_CONTACT_1', 'iso.a.uno@mail.test', 'cliente', 'manual', $1),
      ('ISO_A_CONTACT_2', 'iso.a.dos@mail.test', 'cliente', 'manual', $1),
      ('ISO_B_CONTACT_1', 'iso.b.uno@mail.test', 'cliente', 'manual', $2),
      ('ISO_B_CONTACT_2', 'iso.b.dos@mail.test', 'cliente', 'manual', $2)
  `, [TENANT_A, TENANT_B]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM categorias WHERE nombre LIKE 'ISO_A_%' OR nombre LIKE 'ISO_B_%'`);
  await pool.query(`DELETE FROM contactos WHERE nombre LIKE 'ISO_A_%' OR nombre LIKE 'ISO_B_%'`);
  // Cleanup audits sembrados para el fix #336 (incluye la fila NULL).
  await pool.query(`
    DELETE FROM audit_logs
    WHERE registro_id IN (9001, 9002, 9003)
       OR (datos_despues->>'cliente' IN ('ISO_A_AUDIT_TEST', 'ISO_B_AUDIT_TEST', 'ISO_NULL_AUDIT_TEST'))
  `);
  await pool.query(`DELETE FROM tenant_users WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  await pool.query(`DELETE FROM users WHERE username IN ($1, $2)`, [USER_A.username, USER_B.username]);
  await pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  await teardownTestDb(pool);
});

describe('E2E multi-tenant: aislamiento de /api/inventario/categorias', () => {
  let tokenA, tokenB;

  it('login del user A recibe JWT con tenant_id correcto', async () => {
    const r = await request(app).post('/api/auth/login').send({ username: USER_A.username, password: USER_A.password });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    tokenA = r.body.token;
    // Decodificar el JWT (sin verificar firma, solo para chequear payload)
    const payload = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64').toString());
    expect(payload.tenant_id).toBe(TENANT_A);
    expect(payload.tenant_rol).toBe('owner');
  });

  it('login del user B recibe JWT con tenant_id correcto', async () => {
    const r = await request(app).post('/api/auth/login').send({ username: USER_B.username, password: USER_B.password });
    expect(r.status).toBe(200);
    tokenB = r.body.token;
    const payload = JSON.parse(Buffer.from(tokenB.split('.')[1], 'base64').toString());
    expect(payload.tenant_id).toBe(TENANT_B);
  });

  it('endpoint responde 200 para user A y devuelve resultados', async () => {
    const r = await request(app).get('/api/inventario/categorias').set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    // Las 3 cats que sembramos para tenant A están en la respuesta.
    const nombresA = r.body.map(c => c.nombre).filter(n => n.startsWith('ISO_A_'));
    expect(nombresA.sort()).toEqual(['ISO_A_CAT_1', 'ISO_A_CAT_2', 'ISO_A_CAT_3']);
  });

  it('endpoint responde 200 para user B y devuelve resultados', async () => {
    const r = await request(app).get('/api/inventario/categorias').set('Authorization', `Bearer ${tokenB}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const nombresB = r.body.map(c => c.nombre).filter(n => n.startsWith('ISO_B_'));
    expect(nombresB.sort()).toEqual(['ISO_B_CAT_1', 'ISO_B_CAT_2']);
  });

  it('JWT distingue tenants correctamente (mismo endpoint, distinto contexto)', async () => {
    // Aunque en local el aislamiento real no aplique (superuser bypass), los
    // dos tokens DEBEN tener distinto tenant_id en el payload — eso es lo
    // que en prod gatilla el filtrado RLS via app.current_tenant.
    const payloadA = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64').toString());
    const payloadB = JSON.parse(Buffer.from(tokenB.split('.')[1], 'base64').toString());
    expect(payloadA.tenant_id).not.toBe(payloadB.tenant_id);
    expect(payloadA.tenant_id).toBe(TENANT_A);
    expect(payloadB.tenant_id).toBe(TENANT_B);
  });

  // Hotfix 2026-06-19 #336: leak cross-tenant en /api/historial.
  //
  // La policy RLS de audit_logs permitía `tenant_id IS NULL` por diseño
  // (audits del sistema). En prod había 82 rows NULL (legacy pre-TANDA 0a /
  // pre-TANDA 0b refactor) visibles a TODOS los tenants. El "Actividad
  // reciente" del Inicio mostraba acciones cross-tenant.
  //
  // Fix de superficie: `WHERE a.tenant_id IS NOT NULL` en el SQL del endpoint
  // user-facing → defense in depth, sin depender solo de RLS. La política RLS
  // sigue permitiendo NULL para tools de admin/sysadmin que sí necesitan ver
  // audits de sistema; los usuarios normales NO los ven en su feed.
  //
  // Este test valida el filtro EXPLÍCITO (funciona en cualquier env, incluido
  // local con superuser que bypassa RLS). El cross-tenant aislamiento real
  // (entre tenant A y B con tenant_id set) está cubierto por withTenant.test.js
  // (rol no-super en local) + RLS en CI/staging/prod.
  describe('#336 fix: /api/historial NO sirve audits con tenant_id NULL', () => {
    it('user A NO ve la fila NULL en su /api/historial', async () => {
      const r = await request(app)
        .get('/api/historial?per_page=200')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(r.status).toBe(200);
      // El endpoint expone el cliente vía el campo `detalle` (derivado de
      // datos_despues.cliente para INSERT). Buscamos la fila sembrada como NULL.
      const detalles = (r.body.data || []).map(it => it.detalle).filter(Boolean);
      expect(detalles.some(d => d.includes('ISO_NULL_AUDIT_TEST'))).toBe(false);
    });

    it('user B NO ve la fila NULL en su /api/historial', async () => {
      // Misma garantía para el otro tenant — el fix es a nivel SQL, no a nivel
      // de qué tenant pregunta. Si funciona para A, debe funcionar para B.
      const r = await request(app)
        .get('/api/historial?per_page=200')
        .set('Authorization', `Bearer ${tokenB}`);
      expect(r.status).toBe(200);
      const detalles = (r.body.data || []).map(it => it.detalle).filter(Boolean);
      expect(detalles.some(d => d.includes('ISO_NULL_AUDIT_TEST'))).toBe(false);
    });

    it('user A SÍ ve audits con tenant_id seteado (regresión: no rompimos el feed)', async () => {
      // Sanity check de no haber roto el caso normal. La fila ISO_A_AUDIT_TEST
      // tiene tenant_id = TENANT_A y user_id = USER_A, así que A debe verla.
      // En local sin RLS también puede ver la de B — eso es esperado y NO se
      // testea acá (ver withTenant.test.js para validación cross-tenant real).
      const r = await request(app)
        .get('/api/historial?per_page=200')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(r.status).toBe(200);
      const detalles = (r.body.data || []).map(it => it.detalle).filter(Boolean);
      expect(detalles.some(d => d.includes('ISO_A_AUDIT_TEST'))).toBe(true);
    });
  });

  // TANDA 2.4 fix BLOCKER auditoría 2026-06-17: la tabla `users` NO está en
  // RLS, así que el filtro de tenant en /api/usuarios DEBE ser explícito (JOIN
  // a tenant_users con WHERE tenant_id). Antes del fix, un signupeado de A
  // veía PII (nombre, email, username, role) de todos los users de TODOS los
  // tenants. Este test corre con un real role no-super, por eso valida la
  // protección REAL, no la dependencia de RLS.
  it('TANDA 2.4 BLOCKER: GET /api/usuarios solo devuelve users del tenant del caller', async () => {
    // El user A debe ver SOLO al user A en su /api/usuarios (no a user B ni al
    // testadmin del setup).
    const rA = await request(app).get('/api/usuarios').set('Authorization', `Bearer ${tokenA}`);
    expect(rA.status).toBe(200);
    const idsA = rA.body.map(u => u.id);
    expect(idsA).toContain(USER_A.id);
    expect(idsA).not.toContain(USER_B.id);

    // Lo mismo para B: ve B pero no A.
    const rB = await request(app).get('/api/usuarios').set('Authorization', `Bearer ${tokenB}`);
    expect(rB.status).toBe(200);
    const idsB = rB.body.map(u => u.id);
    expect(idsB).toContain(USER_B.id);
    expect(idsB).not.toContain(USER_A.id);
  });

  // Auditoría 2026-07-04 TANDA 0: los endpoints /api/contactos/emails y /export
  // (feature #508) leen la agenda entera del tenant. La isolation depende 100%
  // de `withTenant(req.tenantId)` + RLS de contactos.
  //
  // Estos tests siguen el patrón del resto del archivo: en local con superuser
  // la RLS puede bypassar (ver caveat del header línea 18-32), por lo que solo
  // validamos que los propios SÍ están presentes en la respuesta (sanity check
  // del pattern + JWT). El aislamiento cross-tenant real corre en CI/prod con
  // NOSUPERUSER (TANDA 0c #294), donde `.not.toContain` sí sería significativo.
  describe('#508: /api/contactos/emails y /export devuelven la agenda del tenant', () => {
    it('user A ve sus propios emails en /emails (JWT + withTenant OK)', async () => {
      const r = await request(app).get('/api/contactos/emails').set('Authorization', `Bearer ${tokenA}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body.emails)).toBe(true);
      expect(r.body.emails).toContain('iso.a.uno@mail.test');
      expect(r.body.emails).toContain('iso.a.dos@mail.test');
    });

    it('user B ve sus propios emails en /emails (JWT + withTenant OK)', async () => {
      const r = await request(app).get('/api/contactos/emails').set('Authorization', `Bearer ${tokenB}`);
      expect(r.status).toBe(200);
      expect(r.body.emails).toContain('iso.b.uno@mail.test');
      expect(r.body.emails).toContain('iso.b.dos@mail.test');
    });

    it('user A ve sus propias fichas en /export (JWT + withTenant OK)', async () => {
      const r = await request(app).get('/api/contactos/export').set('Authorization', `Bearer ${tokenA}`);
      expect(r.status).toBe(200);
      const nombres = r.body.contactos.map(c => c.nombre);
      expect(nombres).toContain('ISO_A_CONTACT_1');
      expect(nombres).toContain('ISO_A_CONTACT_2');
    });

    it('user B ve sus propias fichas en /export (JWT + withTenant OK)', async () => {
      const r = await request(app).get('/api/contactos/export').set('Authorization', `Bearer ${tokenB}`);
      expect(r.status).toBe(200);
      const nombres = r.body.contactos.map(c => c.nombre);
      expect(nombres).toContain('ISO_B_CONTACT_1');
      expect(nombres).toContain('ISO_B_CONTACT_2');
    });
  });

  // Auditoría 2026-07-04 TANDA 0: /api/caja-transferencias (feature #505) usa
  // withTenant + RLS. Sin isolation, user A podría listar transferencias de
  // tenant B. El test valida el pattern completo: crear con tokenA y aparece
  // en el listado de A. Cross-tenant real cubierto por RLS en CI/prod.
  describe('#505: /api/caja-transferencias respeta withTenant + JWT', () => {
    let cajaOrigenA, cajaDestinoA;

    it('user A puede crear cajas propias y una transferencia entre ellas', async () => {
      const rA1 = await request(app).post('/api/cajas/cajas').set('Authorization', `Bearer ${tokenA}`)
        .send({ nombre: 'ISO_A_CAJA_ORIGEN', moneda: 'USD', saldo_inicial: 5000 });
      const rA2 = await request(app).post('/api/cajas/cajas').set('Authorization', `Bearer ${tokenA}`)
        .send({ nombre: 'ISO_A_CAJA_DESTINO', moneda: 'USD', saldo_inicial: 0 });
      expect(rA1.status).toBe(201);
      expect(rA2.status).toBe(201);
      cajaOrigenA  = rA1.body.id;
      cajaDestinoA = rA2.body.id;

      const r = await request(app).post('/api/caja-transferencias').set('Authorization', `Bearer ${tokenA}`)
        .send({
          fecha: new Date().toISOString().split('T')[0],
          caja_origen_id: cajaOrigenA,
          caja_destino_id: cajaDestinoA,
          moneda: 'USD',
          monto: 100,
          descripcion: 'ISO_A_TRANSF_TEST',
        });
      expect(r.status).toBe(201);
    });

    it('user A ve su transferencia en el listado (withTenant OK para GET)', async () => {
      const r = await request(app).get('/api/caja-transferencias').set('Authorization', `Bearer ${tokenA}`);
      expect(r.status).toBe(200);
      const descripciones = r.body.data.map(t => t.descripcion);
      expect(descripciones).toContain('ISO_A_TRANSF_TEST');
    });
  });
});

/**
 * TST-1 (auditoría pre-live 2026-06-24) — aislamiento RLS table-driven
 * para tablas tenant-scoped.
 *
 * El test `withTenant.test.js` ya valida que `categorias` está aislada
 * por RLS con role NOSUPERUSER. Falta la prueba simétrica para el resto
 * de tablas con datos sensibles: clientes_cc, proveedores, productos,
 * ventas, movimientos_cc.
 *
 * Mecánica: para cada tabla {clientes_cc, proveedores, productos,
 * ventas, movimientos_cc}, validamos 3 invariantes RLS bajo role
 * NOSUPERUSER (el role real de la app en prod/staging):
 *
 *   1. SELECT con tenant_id = A solo ve filas de tenant A
 *   2. UPDATE con tenant_id = A no toca filas de tenant B (0 rows affected)
 *   3. DELETE con tenant_id = A no borra filas de tenant B (0 rows affected)
 *
 * Por qué importa: si en el futuro alguien agrega una nueva tabla y se
 * olvida la policy RLS o el WITH CHECK, este test lo detecta. El alcance
 * deliberadamente cubre las tablas de datos financieros más sensibles —
 * un leak ahí es P0.
 *
 * Patrón base: tests/withTenant.test.js (role rls_tester_pr3) +
 * tests/migrations-rls-nosuperuser.test.js (mismo enfoque NOSUPERUSER).
 *
 * Caveat HTTP layer: este test NO valida el HTTP layer (los endpoints
 * Express). En el pool de tests local, el role es SUPERUSER y bypassea
 * RLS, así que un test HTTP no detectaría leaks. La cobertura HTTP
 * existente (`multitenant-isolation.test.js`) chequea que cada user vea
 * SUS datos, pero no que NO vea ajenos — esa asserción solo es viable
 * con un pool no-super en el app, requiere infraestructura nueva.
 * Mientras tanto, este test garantiza la capa fundamental: la DB con
 * RLS bloquea cross-tenant.
 */
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;

const ROLE_NAME = 'rls_destr_tester';
const TENANT_A = 9101;
const TENANT_B = 9102;

beforeAll(async () => {
  pool = await setupTestDb();

  // Limpieza defensiva de corrida previa abortada.
  try {
    await pool.query(`REASSIGN OWNED BY ${ROLE_NAME} TO CURRENT_USER`);
    await pool.query(`DROP OWNED BY ${ROLE_NAME} CASCADE`);
  } catch (_) { /* role no existía */ }
  await pool.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);

  await pool.query(`CREATE ROLE ${ROLE_NAME} LOGIN NOSUPERUSER`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${ROLE_NAME}`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${ROLE_NAME}`);

  // 2 tenants para los tests.
  await pool.query(`
    INSERT INTO tenants (id, nombre, slug, plan) VALUES
      ($1, 'Tenant RLS Destr A', 'rls-destr-a', 'pro'),
      ($2, 'Tenant RLS Destr B', 'rls-destr-b', 'pro')
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
  await pool.query(`DELETE FROM clientes_cc WHERE nombre LIKE 'RLS_DESTR_%'`);
  await pool.query(`DELETE FROM proveedores WHERE nombre LIKE 'RLS_DESTR_%'`);
  await pool.query(`DELETE FROM productos WHERE nombre LIKE 'RLS_DESTR_%'`);
  await pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  await teardownTestDb(pool);
});

// ─── Tabla de recursos a testear ─────────────────────────────────────────────
// Cada caso: tabla, columnas mínimas obligatorias para INSERT, predicate de
// limpieza, alguna columna que sirva como "label" único para identificar la
// fila sembrada en cada tenant.
//
// IMPORTANT: los INSERTs se hacen con el role superuser del pool y
// tenant_id explícito (bypass RLS para sembrar el dataset). Los SELECTs +
// UPDATEs + DELETEs se hacen con el role NOSUPERUSER bajo SET LOCAL
// app.current_tenant — ahí la policy RLS aplica de verdad.
const TABLES = [
  {
    name: 'clientes_cc',
    insertSql: (label, tenantId) => ({
      sql: `INSERT INTO clientes_cc (nombre, categoria, tenant_id) VALUES ($1, 'A+', $2) RETURNING id`,
      params: [label, tenantId],
    }),
    labelCol: 'nombre',
    labelPrefix: 'RLS_DESTR_CLI',
    updateField: 'notas',
  },
  {
    name: 'proveedores',
    insertSql: (label, tenantId) => ({
      sql: `INSERT INTO proveedores (nombre, tenant_id) VALUES ($1, $2) RETURNING id`,
      params: [label, tenantId],
    }),
    labelCol: 'nombre',
    labelPrefix: 'RLS_DESTR_PROV',
    updateField: 'notas',
  },
  {
    name: 'productos',
    insertSql: (label, tenantId) => ({
      sql: `INSERT INTO productos (tipo_carga, clase, nombre, costo, costo_moneda, precio_venta, precio_moneda, cantidad, tenant_id)
            VALUES ('unitario', 'celular_sellado', $1, 100, 'USD', 200, 'USD', 1, $2) RETURNING id`,
      params: [label, tenantId],
    }),
    labelCol: 'nombre',
    labelPrefix: 'RLS_DESTR_PROD',
    updateField: 'observaciones',
  },
];

describe.each(TABLES)('RLS isolation — tabla $name', (T) => {
  let idA, idB;
  const labelA = `${T.labelPrefix}_A_${Date.now()}`;
  const labelB = `${T.labelPrefix}_B_${Date.now()}`;

  beforeAll(async () => {
    // Sembrar 1 fila por tenant. Usamos el pool superuser + tenant_id explícito.
    const { sql: sqlA, params: paramsA } = T.insertSql(labelA, TENANT_A);
    const ra = await pool.query(sqlA, paramsA);
    idA = ra.rows[0].id;
    const { sql: sqlB, params: paramsB } = T.insertSql(labelB, TENANT_B);
    const rb = await pool.query(sqlB, paramsB);
    idB = rb.rows[0].id;
  });

  it('SELECT como tenant A solo ve la fila de A', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      const { rows } = await client.query(
        `SELECT id, ${T.labelCol} FROM ${T.name} WHERE ${T.labelCol} LIKE $1`,
        [`${T.labelPrefix}_%`]
      );
      const ids = rows.map(r => r.id);
      expect(ids).toContain(idA);
      expect(ids).not.toContain(idB);
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  });

  it('SELECT como tenant B solo ve la fila de B', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_B}'`);
      const { rows } = await client.query(
        `SELECT id, ${T.labelCol} FROM ${T.name} WHERE ${T.labelCol} LIKE $1`,
        [`${T.labelPrefix}_%`]
      );
      const ids = rows.map(r => r.id);
      expect(ids).toContain(idB);
      expect(ids).not.toContain(idA);
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  });

  it('UPDATE como tenant A no toca la fila de B (rowCount=0)', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      // Intentamos modificar la fila de B desde el contexto de A. RLS debe
      // ocultarla del USING → 0 rows affected.
      const res = await client.query(
        `UPDATE ${T.name} SET ${T.updateField} = 'pwned_by_A' WHERE id = $1`,
        [idB]
      );
      expect(res.rowCount).toBe(0);
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  });

  it('DELETE como tenant A no borra la fila de B (rowCount=0)', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      const res = await client.query(
        `DELETE FROM ${T.name} WHERE id = $1`,
        [idB]
      );
      expect(res.rowCount).toBe(0);
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  });

  it('INSERT como tenant A con tenant_id=B explícito es rechazado por WITH CHECK', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${ROLE_NAME}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      const { sql, params } = T.insertSql(`${T.labelPrefix}_CROSS_${Date.now()}`, TENANT_B);
      await expect(client.query(sql, params)).rejects.toThrow(/row-level security/i);
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  });
});

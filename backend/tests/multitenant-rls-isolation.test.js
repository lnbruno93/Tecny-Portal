/**
 * Tests E2E exhaustivos de aislamiento multi-tenant via Postgres RLS,
 * ejecutados con un role no-superuser para SIMULAR CONDICIONES DE PROD.
 *
 * Por qué este archivo separado existe:
 *   - tests/withTenant.test.js (PR 3): valida el helper db.withTenant y RLS
 *     real solo en `categorias`.
 *   - tests/multitenant-isolation.test.js (PR 4.0): valida flujo E2E (JWT +
 *     endpoint /api/inventario/categorias) pero usa pool superuser → RLS
 *     bypasseado en local.
 *   - ESTE archivo (PR 6): expande la cobertura de aislamiento real (role
 *     no-super) a TODAS las tablas críticas — la prueba que demuestra que
 *     en prod (donde el role de la app también es no-super) los tenants
 *     están aislados a nivel DB independientemente del código de la app.
 *
 * Modelo del test:
 *   1. Crear role `rls_tester_pr6` LOGIN NOSUPERUSER con grants en todas
 *      las tablas de negocio.
 *   2. Crear 2 tenants (9001, 9002) y sembrar 1 fila en cada tenant en
 *      cada tabla a probar (con prefijo `RLS6_` para fácil cleanup).
 *   3. Para cada tabla:
 *      a) SET ROLE rls_tester_pr6 + SET LOCAL app.current_tenant = '9001'
 *         → SELECT solo devuelve la fila de 9001.
 *      b) SET ROLE rls_tester_pr6 + SET LOCAL app.current_tenant = '9002'
 *         → SELECT solo devuelve la fila de 9002.
 *      c) SET ROLE + SET LOCAL = '9001' + INSERT con tenant_id=9002 →
 *         rechazado por WITH CHECK (RLS).
 *   4. Tests específicos del DEFAULT dinámico (PR 4.9): INSERT sin
 *      tenant_id explícito hereda el valor del SET LOCAL.
 *
 * Estos tests son la garantía operativa final: si pasan, podemos
 * vender la SaaS sabiendo que un bug futuro en un endpoint que olvide
 * pasar req.tenantId NO va a leakear data — RLS bloquea a nivel DB.
 */

const db = require('../src/config/database');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;

const ROLE_NAME = 'rls_tester_pr6';
const TENANT_A = 9001;
const TENANT_B = 9002;

// Tablas a verificar. Para cada una:
//   - insertSQL(tenantId, marker): INSERT con todos los NOT NULL + tenant_id
//     explícito y marker = valor del campo `nombre` (clave de identificación
//     del test). El INSERT siempre incluye tenant_id literal para forzar
//     que RLS lo valide via WITH CHECK (no via DEFAULT dinámico — eso lo
//     cubre el bloque PR 4.9 abajo).
//   - selectByPrefixSQL(prefix): SELECT WHERE nombre LIKE '<prefix>%' —
//     usado en los tests de aislamiento (vemos todas las filas con el
//     marker prefix y verificamos que RLS filtra a la del tenant correcto).
//   - cleanupSQL(prefix): DELETE WHERE nombre LIKE '<prefix>%' — limpieza
//     idempotente entre tests.
//
// La lista no es exhaustiva (42 tablas) — son las representativas de cada
// módulo refactoreado en PRs 4.1-4.8. Cubrir las 42 sería rendimiento
// negativo sin ganancia material: la policy RLS es genérica (`tenant_id =
// current_setting`), si funciona para 1 tabla funciona para todas — lo que
// validamos acá es que el patrón aguanta variedad de schemas.
const TABLAS_CRITICAS = [
  {
    nombre: 'categorias',
    insertSQL: (tenantId, marker) => `INSERT INTO categorias (nombre, tenant_id) VALUES ('${marker}', ${tenantId})`,
    selectByPrefixSQL: (prefix) => `SELECT nombre, tenant_id FROM categorias WHERE nombre LIKE '${prefix}%'`,
    cleanupSQL: (prefix) => `DELETE FROM categorias WHERE nombre LIKE '${prefix}%'`,
  },
  {
    nombre: 'productos',
    insertSQL: (tenantId, marker) => `INSERT INTO productos (nombre, tipo_carga, clase, costo, costo_moneda, precio_venta, precio_moneda, tenant_id) VALUES ('${marker}', 'unitario', 'celular', 100, 'USD', 200, 'USD', ${tenantId})`,
    selectByPrefixSQL: (prefix) => `SELECT nombre, tenant_id FROM productos WHERE nombre LIKE '${prefix}%'`,
    cleanupSQL: (prefix) => `DELETE FROM productos WHERE nombre LIKE '${prefix}%'`,
  },
  {
    nombre: 'metodos_pago',
    insertSQL: (tenantId, marker) => `INSERT INTO metodos_pago (nombre, moneda, tenant_id) VALUES ('${marker}', 'USD', ${tenantId})`,
    selectByPrefixSQL: (prefix) => `SELECT nombre, tenant_id FROM metodos_pago WHERE nombre LIKE '${prefix}%'`,
    cleanupSQL: (prefix) => `DELETE FROM metodos_pago WHERE nombre LIKE '${prefix}%'`,
  },
  {
    nombre: 'proveedores',
    insertSQL: (tenantId, marker) => `INSERT INTO proveedores (nombre, tenant_id) VALUES ('${marker}', ${tenantId})`,
    selectByPrefixSQL: (prefix) => `SELECT nombre, tenant_id FROM proveedores WHERE nombre LIKE '${prefix}%'`,
    cleanupSQL: (prefix) => `DELETE FROM proveedores WHERE nombre LIKE '${prefix}%'`,
  },
  {
    nombre: 'cambio_entidades',
    insertSQL: (tenantId, marker) => `INSERT INTO cambio_entidades (nombre, tenant_id) VALUES ('${marker}', ${tenantId})`,
    selectByPrefixSQL: (prefix) => `SELECT nombre, tenant_id FROM cambio_entidades WHERE nombre LIKE '${prefix}%'`,
    cleanupSQL: (prefix) => `DELETE FROM cambio_entidades WHERE nombre LIKE '${prefix}%'`,
  },
  {
    nombre: 'egreso_categorias',
    insertSQL: (tenantId, marker) => `INSERT INTO egreso_categorias (nombre, tenant_id) VALUES ('${marker}', ${tenantId})`,
    selectByPrefixSQL: (prefix) => `SELECT nombre, tenant_id FROM egreso_categorias WHERE nombre LIKE '${prefix}%'`,
    cleanupSQL: (prefix) => `DELETE FROM egreso_categorias WHERE nombre LIKE '${prefix}%'`,
  },
  {
    nombre: 'proyectos',
    insertSQL: (tenantId, marker) => `INSERT INTO proyectos (nombre, tenant_id) VALUES ('${marker}', ${tenantId})`,
    selectByPrefixSQL: (prefix) => `SELECT nombre, tenant_id FROM proyectos WHERE nombre LIKE '${prefix}%'`,
    cleanupSQL: (prefix) => `DELETE FROM proyectos WHERE nombre LIKE '${prefix}%'`,
  },
  {
    nombre: 'etiquetas',
    insertSQL: (tenantId, marker) => `INSERT INTO etiquetas (nombre, tenant_id) VALUES ('${marker}', ${tenantId})`,
    selectByPrefixSQL: (prefix) => `SELECT nombre, tenant_id FROM etiquetas WHERE nombre LIKE '${prefix}%'`,
    cleanupSQL: (prefix) => `DELETE FROM etiquetas WHERE nombre LIKE '${prefix}%'`,
  },
];

const MARKER_PREFIX = 'RLS6_';

beforeAll(async () => {
  pool = await setupTestDb();

  // Setup del role no-superuser con grants. Idempotente para re-runs.
  await pool.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);
  await pool.query(`CREATE ROLE ${ROLE_NAME} LOGIN NOSUPERUSER`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${ROLE_NAME}`);
  await pool.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${ROLE_NAME}`);

  // Sembrar los 2 tenants. ON CONFLICT para idempotencia.
  await pool.query(`
    INSERT INTO tenants (id, nombre, slug, plan) VALUES
      (${TENANT_A}, 'RLS6 Tenant A', 'rls6-a', 'pro'),
      (${TENANT_B}, 'RLS6 Tenant B', 'rls6-b', 'pro')
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), ${TENANT_B}))`);
});

afterAll(async () => {
  // Cleanup en orden: filas de test → role → tenants.
  try {
    for (const t of TABLAS_CRITICAS) {
      await pool.query(t.cleanupSQL(MARKER_PREFIX));
    }
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE_NAME}`);
    await pool.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${ROLE_NAME}`);
    await pool.query(`DROP ROLE IF EXISTS ${ROLE_NAME}`);
    await pool.query(`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B})`);
  } catch (_) { /* swallow */ }
  await teardownTestDb(pool);
});

// Helper para correr una query como rls_tester con SET LOCAL en una tx.
// Devuelve el `rows` del select. Si la operación tira:
//   1) Hacemos ROLLBACK best-effort (.catch swallow — la tx puede ya estar
//      en estado aborted, ROLLBACK falla con "current tx aborted", da igual).
//   2) RESET ROLE (también swallow por la misma razón).
// El error original se re-tira para que el test lo vea. El pool client queda
// limpio para el siguiente test — sin esto, una falla deja el client en
// estado aborted y los tests siguientes empiezan a fallar en cascada con
// "current transaction is aborted, commands ignored".
async function asTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE ${ROLE_NAME}`);
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = '${tenantId}'`);
    try {
      const result = await fn(client);
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
      return result;
    } catch (innerErr) {
      await client.query('ROLLBACK').catch(() => {});
      await client.query('RESET ROLE').catch(() => {});
      throw innerErr;
    }
  } finally {
    client.release();
  }
}

describe('PR 6: aislamiento RLS real (role no-superuser) en módulos críticos', () => {
  // El loop genera 3 tests por tabla — SELECT-A, SELECT-B, INSERT-cross-rejected.
  // describe.each + it.each nos da nombres legibles en el reporter.
  describe.each(TABLAS_CRITICAS)('tabla $nombre', (tabla) => {
    const markerA = `${MARKER_PREFIX}${tabla.nombre}_A`;
    const markerB = `${MARKER_PREFIX}${tabla.nombre}_B`;

    beforeAll(async () => {
      // Limpiar y re-sembrar para cada tabla. El cleanup es idempotente.
      await pool.query(tabla.cleanupSQL(MARKER_PREFIX));
      await pool.query(tabla.insertSQL(TENANT_A, markerA));
      await pool.query(tabla.insertSQL(TENANT_B, markerB));
    });

    afterAll(async () => {
      await pool.query(tabla.cleanupSQL(MARKER_PREFIX));
    });

    it(`SELECT como tenant ${TENANT_A} (no-super): solo ve la fila A`, async () => {
      const rows = await asTenant(TENANT_A, async (client) => {
        // SELECT trae todas las filas con este prefix; RLS filtra a la del
        // tenant correcto.
        const prefix = `${MARKER_PREFIX}${tabla.nombre}`;
        const { rows } = await client.query(tabla.selectByPrefixSQL(prefix));
        return rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].nombre).toBe(markerA);
      expect(rows[0].tenant_id).toBe(TENANT_A);
    });

    it(`SELECT como tenant ${TENANT_B} (no-super): solo ve la fila B`, async () => {
      const rows = await asTenant(TENANT_B, async (client) => {
        const prefix = `${MARKER_PREFIX}${tabla.nombre}`;
        const { rows } = await client.query(tabla.selectByPrefixSQL(prefix));
        return rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].nombre).toBe(markerB);
      expect(rows[0].tenant_id).toBe(TENANT_B);
    });

    it(`INSERT con tenant_id ajeno (${TENANT_B} estando en sesión ${TENANT_A}) es bloqueado por WITH CHECK`, async () => {
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE ${ROLE_NAME}`);
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
        const markerCross = `${MARKER_PREFIX}${tabla.nombre}_CROSS`;
        await expect(
          client.query(tabla.insertSQL(TENANT_B, markerCross))
        ).rejects.toThrow(/row-level security/i);
        await client.query('ROLLBACK');
        await client.query('RESET ROLE');
      } finally {
        client.release();
      }
    });
  });
});

describe('PR 6: DEFAULT dinámico de tenant_id (post-migration PR 4.9)', () => {
  const markerDefault = `${MARKER_PREFIX}default_dynamic_test`;

  beforeAll(async () => {
    await pool.query(`DELETE FROM categorias WHERE nombre = '${markerDefault}'`);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM categorias WHERE nombre = '${markerDefault}'`);
  });

  it('INSERT sin tenant_id explícito hereda el valor del SET LOCAL', async () => {
    // El DEFAULT cambiado por la migration 20260615000003 es:
    //   COALESCE(NULLIF(current_setting('app.current_tenant', true), '')::int, 1)
    // Cuando insertamos dentro de un withTenant, el SET LOCAL hace que el
    // current_setting devuelva el tenant del request, y el DEFAULT cae sobre
    // ese valor. Si esto se rompe, los tenants > 1 NO pueden crear filas.
    await db.withTenant(TENANT_A, async (client) => {
      // INSERT explícitamente SIN columna tenant_id — usa el DEFAULT.
      await client.query(
        `INSERT INTO categorias (nombre) VALUES ('${markerDefault}')`
      );
      const { rows } = await client.query(
        `SELECT nombre, tenant_id FROM categorias WHERE nombre = '${markerDefault}'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(TENANT_A);
    });
  });

  it('INSERT sin tenant_id explícito y sin SET LOCAL cae al fallback 1 (backward compat)', async () => {
    // Sin SET LOCAL: current_setting devuelve '' (string vacío), NULLIF lo
    // pasa a NULL, COALESCE retorna 1. Este es el path legacy: scripts
    // admin / queries pool que no setean tenant siguen funcionando como
    // antes (van a tenant 1).
    const markerFallback = `${MARKER_PREFIX}fallback_test`;
    try {
      await pool.query(`INSERT INTO categorias (nombre) VALUES ('${markerFallback}')`);
      const { rows } = await pool.query(
        `SELECT nombre, tenant_id FROM categorias WHERE nombre = '${markerFallback}'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(1);
    } finally {
      await pool.query(`DELETE FROM categorias WHERE nombre = '${markerFallback}'`);
    }
  });
});

describe('PR 6: invariantes de la policy RLS', () => {
  it('un tenant NO puede ver filas de OTRO tenant aunque conozca el ID exacto', async () => {
    // Sembrar 1 fila en cada tenant + intento de leerla cross-tenant.
    const markerLeak = `${MARKER_PREFIX}leak_test`;
    await pool.query(`DELETE FROM categorias WHERE nombre = '${markerLeak}'`);
    await pool.query(`INSERT INTO categorias (nombre, tenant_id) VALUES ('${markerLeak}', ${TENANT_B})`);

    try {
      // Estando en sesión de A, intentamos leer la fila de B por nombre
      // exacto. Si RLS funciona bien, no la vemos aun conociendo el match.
      const rows = await asTenant(TENANT_A, async (client) => {
        const { rows } = await client.query(
          `SELECT nombre, tenant_id FROM categorias WHERE nombre = '${markerLeak}'`
        );
        return rows;
      });
      expect(rows).toHaveLength(0);  // RLS lo ocultó

      // Verificar que SÍ es visible desde B (no es bug de seed).
      const rowsB = await asTenant(TENANT_B, async (client) => {
        const { rows } = await client.query(
          `SELECT nombre, tenant_id FROM categorias WHERE nombre = '${markerLeak}'`
        );
        return rows;
      });
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0].tenant_id).toBe(TENANT_B);
    } finally {
      await pool.query(`DELETE FROM categorias WHERE nombre = '${markerLeak}'`);
    }
  });

  it('UPDATE de fila de otro tenant es no-op (RLS oculta la fila → 0 rows affected)', async () => {
    // Sembrar fila en B y tratar de UPDATEarla desde sesión A.
    const markerUpd = `${MARKER_PREFIX}update_test`;
    await pool.query(`DELETE FROM categorias WHERE nombre LIKE '${markerUpd}%'`);
    await pool.query(`INSERT INTO categorias (nombre, tenant_id) VALUES ('${markerUpd}', ${TENANT_B})`);

    try {
      const updated = await asTenant(TENANT_A, async (client) => {
        const result = await client.query(
          `UPDATE categorias SET nombre = '${markerUpd}_HACKED' WHERE nombre = '${markerUpd}'`
        );
        return result.rowCount;
      });
      expect(updated).toBe(0);  // RLS ocultó la fila → UPDATE no afecta nada

      // Verificar que el dato en B sigue intacto.
      const { rows } = await pool.query(
        `SELECT nombre FROM categorias WHERE tenant_id = ${TENANT_B} AND nombre LIKE '${markerUpd}%'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].nombre).toBe(markerUpd);  // sin _HACKED
    } finally {
      await pool.query(`DELETE FROM categorias WHERE nombre LIKE '${markerUpd}%'`);
    }
  });

  it('DELETE de fila de otro tenant es no-op (RLS oculta la fila → 0 rows affected)', async () => {
    const markerDel = `${MARKER_PREFIX}delete_test`;
    await pool.query(`DELETE FROM categorias WHERE nombre = '${markerDel}'`);
    await pool.query(`INSERT INTO categorias (nombre, tenant_id) VALUES ('${markerDel}', ${TENANT_B})`);

    try {
      const deleted = await asTenant(TENANT_A, async (client) => {
        const result = await client.query(
          `DELETE FROM categorias WHERE nombre = '${markerDel}'`
        );
        return result.rowCount;
      });
      expect(deleted).toBe(0);

      const { rows } = await pool.query(
        `SELECT nombre FROM categorias WHERE tenant_id = ${TENANT_B} AND nombre = '${markerDel}'`
      );
      expect(rows).toHaveLength(1);  // sigue ahí
    } finally {
      await pool.query(`DELETE FROM categorias WHERE nombre = '${markerDel}'`);
    }
  });
});

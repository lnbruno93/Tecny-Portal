/**
 * Helpers compartidos para los tests de integración.
 *
 * setupTestDb()  — corre las migraciones, limpia datos y crea usuario admin de prueba.
 *                  Devuelve el pool para que los tests puedan usarlo si necesitan
 *                  insertar datos directamente.
 *
 * teardownTestDb(pool) — cierra la conexión al terminar la suite.
 */
// Las variables de entorno ya fueron cargadas por tests/helpers/setEnv.js (jest setupFiles)
// No recargar dotenv aquí para evitar sobreescribir con .env de desarrollo
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');
const { execSync } = require('child_process');
// 2026-06-23 F4: TOOLS array murió en el cutover capability-based.
// El test admin (role='admin' global) bypassa todos los gates en el
// middleware nuevo, así que no necesitamos seedear capabilities.
// Tests que necesiten user no-admin con caps deben insertar filas en
// tenant_user_roles + user_capabilities ellos mismos.

const TEST_USER = {
  nombre:   'Test Admin',
  username: 'testadmin',
  // 2026-06-16 TANDA 1: email obligatorio (NOT NULL). Cualquier valor único
  // sirve para tests; usamos `@test.local` para no chocar con dominios reales.
  email:    'testadmin@test.local',
  password: 'testpass123',
  role:     'admin',
};

async function setupTestDb() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Correr migraciones via CLI (mismo path que producción, evita conflictos ESM/CJS)
  execSync('npm run migrate', {
    cwd:   path.join(__dirname, '../..'),
    env:   { ...process.env },
    stdio: 'pipe', // silenciar output en tests
  });

  // 2026-06-12 fix(flake): el TRUNCATE de abajo toma AccessExclusiveLock sobre
  // audit_logs particionado (cascade a todas las partitions). Si quedó vivo en
  // PG cualquier backend ajeno con un INSERT recién hecho sobre la partition
  // del mes corriente — el child process de `npm run migrate` que acaba de
  // salir, una corrida previa de Jest matada bruscamente, etc. — el orden de
  // adquisición de locks de partitioned tables genera deadlock determinístico
  // (https://www.postgresql.org/docs/current/sql-truncate.html). Cortarlos
  // ANTES del TRUNCATE elimina la race; no afecta al pool del propio test
  // (pg_backend_pid() es el current). No-op cuando no hay zombies.
  await pool.query(`
    SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
  `);

  // Limpiar todas las tablas de datos y reiniciar secuencias
  // 2026-06-20 #340: chat_messages + chat_conversations + chat_rate_limits
  // agregados para que tests del bot arranquen siempre limpios.
  // 2026-06-25 Bug #2 (post-mortem del PR de financiera): `config` agregada al
  // TRUNCATE porque la migration 20260615000001 cambió la tabla de singleton
  // a 1 row por tenant. Tests que usan signup público crean tenants nuevos +
  // (con el seed nuevo en signup.js) cada signup persiste una fila en config.
  // Después de varios runs locales, la tabla tenía 50+ filas residuales de
  // tenants viejos. La query `SELECT pct_financiera FROM config LIMIT 1` del
  // endpoint POST /comprobantes/manuales era no-determinística en presencia
  // de múltiples filas — devolvía una fila random (pct=0 de algún tenant
  // viejo) en vez de la del tenant del request. Tests asumían pct=5 y
  // recibían 0, fallando en local + CI. El TRUNCATE acá garantiza DB limpia
  // entre suites; el re-seed inmediato abajo (línea 92) restaura la fila
  // singleton que la migration inicial creó (id=1, tenant_id=1, pct=0).
  await pool.query(`
    TRUNCATE TABLE
      audit_logs, audit_queue,
      caja_movimientos,
      cambio_movimientos, cambio_entidades,
      tarjeta_movimientos,
      egresos, egresos_recurrentes, egreso_categorias, ventas_rapidas, canjes, venta_comprobantes, venta_pagos, venta_items, ventas, etiquetas, metodos_pago, plantillas_garantia,
      productos, categorias, depositos,
      proveedor_movimiento_items, proveedor_movimientos, proveedores,
      proyecto_movimientos, proyecto_participantes, proyectos,
      items_movimiento_cc, movimientos_cc, clientes_cc,
      envio_items, envios,
      movimientos_inversiones, movimientos_deudas, contactos,
      comprobantes, pagos, vendedores,
      chat_messages, chat_conversations, chat_rate_limits,
      feature_flags, config,
      users
    RESTART IDENTITY CASCADE
  `);

  // 2026-06-25 Bug #2: re-seed de config con la fila singleton del tenant 1.
  // Réplica del INSERT de la migration inicial 20260521000001 + el tenant_id=1
  // que la migration 20260615000001_multitenant_schema le agregó (línea 220).
  // Sin esto, el TRUNCATE de arriba deja la tabla vacía y todos los endpoints
  // que leen pct_financiera caen al fallback 0 — rompe tests de comprobantes
  // manuales, ventas con financiera, caja-ledger.
  //
  // NOTA: `tenants` deliberadamente NO está en el TRUNCATE. Truncarla con
  // CASCADE arrastra todas las tablas que FK a tenants (~30 tablas) y rompe
  // RLS y assumptions de muchos suites. Los tests del superAdmin que asumen
  // tenant=1 fallan por acumulación de tenants de runs viejos — eso queda
  // como follow-up (task #437) en un PR separado con migration de cleanup
  // o estrategia distinta.
  await pool.query(`
    INSERT INTO config (id, tenant_id, pct_financiera) VALUES (1, 1, 0)
    ON CONFLICT (tenant_id, id) DO NOTHING
  `);

  // M-08 feature flags: re-seed del demo_flag para que los tests que asumen
  // ese row preexistente (replicando el estado post-migración en prod) tengan
  // un estado determinístico aún después del TRUNCATE.
  await pool.query(`
    INSERT INTO feature_flags (name, enabled, description) VALUES
      ('demo_flag', false, 'Flag de demostración — borrar cuando se use el primero real')
    ON CONFLICT (name) DO NOTHING
  `);

  // P-07: el flag audit_async_enabled NO se re-seedea acá. El bifurcador en
  // audit.js usa `_testOverride` (module-local) en NODE_ENV=test, NO consulta
  // la DB. Así NO importa que el TRUNCATE borre el flag — el path sync sigue
  // siendo el default (override=false). Los tests del async setean el override
  // explícito en su `beforeEach`. La tabla `audit_queue` ya está en el TRUNCATE
  // list arriba — no necesitamos TRUNCATE adicional.

  // Re-seed de metodos_pago (cajas) — se truncó arriba; replica el seed de la migración 002
  // para que cada test arranque con un estado determinístico de cajas.
  await pool.query(`
    INSERT INTO metodos_pago (nombre, moneda, orden) VALUES
      ('USD | Efectivo',      'USD',  1),
      ('Pesos Ars | Efectivo','ARS',  2),
      ('Pesos Ars | BBVA GL', 'ARS',  3),
      ('Pesos Ars | BBVA LB', 'ARS',  4),
      ('USD | BBVA GL',       'USD',  5),
      ('Binance | GL',        'USDT', 6)
    ON CONFLICT DO NOTHING
  `);

  // Marcar una caja como Financiera (es_financiera=true) — desde junio 2026
  // los flujos POST /api/comprobantes y POST /api/pagos REQUIEREN una caja FV
  // para postear el caja_movimiento de trazabilidad. Si no hay ninguna, todos
  // esos endpoints rebotan con 400. Tests que crean su propia caja FV vía
  // POST /api/cajas/cajas la sobreescriben (constraint UNIQUE).
  await pool.query(`
    UPDATE metodos_pago SET es_financiera = true WHERE nombre = 'Pesos Ars | Efectivo'
  `);

  // C.1.1 #353: re-seed de plan_prices. El TRUNCATE de users CASCADE arriba
  // arrastra plan_prices porque la columna updated_by es FK a users(id) — PG
  // TRUNCATE ... CASCADE vacía tablas referenciadas incluso si la FK es
  // ON DELETE SET NULL (semántica distinta a DELETE). Sin este re-seed, los
  // endpoints /api/super-admin/plan-prices y /api/public/pricing y el cache
  // de planPricing quedarían con tabla vacía. Los valores matchean el seed
  // de migration 20260622153000_plan_prices_table.
  await pool.query(`
    INSERT INTO plan_prices (plan, price_usd, notes) VALUES
      ('trial',      0,    'Trial siempre gratis. NO editar desde admin (la UI lo deshabilita).'),
      ('starter',    39,   'Plan inicial. Precio mock del handoff de Claude Design.'),
      ('pro',        189,  'Plan medio. Precio mock del handoff de Claude Design.'),
      ('enterprise', NULL, 'Custom per-tenant en tenants.custom_mrr_usd. Esta fila es marker.')
    ON CONFLICT (plan) DO UPDATE
      SET price_usd = EXCLUDED.price_usd, notes = EXCLUDED.notes, updated_by = NULL
  `);

  // 2026-06-29 Multi-país F1: re-seed de tc_defaults_pais por la misma razón
  // que plan_prices (FK updated_by → users.id). Sin este re-seed el helper
  // `getTcDefaultPais` devolvería null en cualquier test, rompiendo las
  // ventas/cotizadores futuros que pre-rellenan el TC. Valores matchean el
  // seed de migration 20260629100003_tc_defaults_pais.
  await pool.query(`
    INSERT INTO tc_defaults_pais (pais, par, valor) VALUES
      ('AR', 'ARS/USD', 1400.00),
      ('UY', 'UYU/USD',   40.00)
    ON CONFLICT (pais, par) DO UPDATE
      SET valor = EXCLUDED.valor, updated_by = NULL
  `);

  // Crear usuario admin de prueba
  const hash = await bcrypt.hash(TEST_USER.password, 10);
  const { rows } = await pool.query(
    'INSERT INTO users (nombre, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [TEST_USER.nombre, TEST_USER.username, TEST_USER.email, hash, TEST_USER.role]
  );
  const userId = rows[0].id;
  // Vincular al tenant 1 (default desde migration PR 1) con rol='admin'. El
  // TRUNCATE de `users` con CASCADE borró el row de tenant_users que la
  // migration había backfilleado. Sin esto, login emite JWT con
  // tenant_rol='member' (fallback) y los endpoints adminOnly (validados por
  // tenant_rol post 2026-06-16) fallan con 403.
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'admin')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET rol = 'admin'`,
    [userId]
  );

  // 2026-06-23 F4: seedear rol del sistema nuevo (capability-based).
  // El test admin tiene users.role='admin' global → bypassa middleware.
  // Pero algunas pantallas leen tenant_user_roles para mostrar el rol —
  // dejamos una fila explícita 'admin' para que GET /capabilities/users lo
  // muestre con rol coherente.
  //
  // tenant_user_roles tiene FORCE RLS, así que necesitamos setear el
  // tenant context dentro de una tx (igual que las migrations).
  const setupClient = await pool.connect();
  try {
    await setupClient.query('BEGIN');
    await setupClient.query(`SET LOCAL app.current_tenant = 1`);
    await setupClient.query(
      `INSERT INTO tenant_user_roles (tenant_id, user_id, rol) VALUES (1, $1, 'admin')
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET rol = 'admin'`,
      [userId]
    );
    await setupClient.query('COMMIT');
  } finally {
    setupClient.release();
  }

  return pool;
}

/**
 * Helper para crear un user de test con tenant_users + tenant_user_roles
 * — los 3 INSERTs que el endpoint POST /api/usuarios hace en una sola tx,
 * pero accesible desde tests que necesitan crear users non-admin.
 *
 * 2026-06-24 SEG-2 (audit pre-live): antes los tests podían hacer
 * `INSERT INTO users` sin tenant_users y el login funcionaba (fallback
 * silencioso a tenant 1). Ahora resolveUserTenant tira NO_TENANT si no
 * hay row → el login devuelve 401 y los tests fallan.
 *
 * @param {Pool} pool — el pool devuelto por setupTestDb.
 * @param {object} opts
 * @param {string} opts.nombre
 * @param {string} opts.username
 * @param {string} opts.email
 * @param {string} opts.password — plaintext, se hashea con bcrypt aquí.
 * @param {string} [opts.role='op'] — 'admin' o 'op' (global).
 * @param {number} [opts.tenantId=1] — tenant a vincular.
 * @param {string} [opts.tenantRol='member'] — rol de tenant (member/admin/owner).
 * @param {string} [opts.capRol='custom'] — rol capability (custom/vendedor/admin/owner...).
 * @returns {Promise<{id: number}>}
 */
async function createTestUser(pool, opts) {
  const bcrypt = require('bcrypt');
  const {
    nombre, username, email, password,
    role = 'op',
    tenantId = 1,
    tenantRol = 'member',
    capRol = 'custom',
  } = opts;

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [nombre, username, email, hash, role]
  );
  const userId = rows[0].id;

  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, $3)`,
    [tenantId, userId, tenantRol]
  );
  await pool.query(
    `INSERT INTO tenant_user_roles (tenant_id, user_id, rol) VALUES ($1, $2, $3)`,
    [tenantId, userId, capRol]
  );

  return { id: userId };
}

async function teardownTestDb(pool) {
  if (!pool) return;
  // Limpiar datos al finalizar para que el próximo `jest` arranque con DB vacía,
  // incluso si el proceso terminó sin correr setupTestDb (crash, SIGINT, etc.)
  try {
    await pool.query(`
      TRUNCATE TABLE
        audit_logs,
        caja_movimientos,
        cambio_movimientos, cambio_entidades,
        tarjeta_movimientos,
        egresos, egresos_recurrentes, egreso_categorias, metodos_pago,
        proveedor_movimiento_items, proveedor_movimientos, proveedores,
        items_movimiento_cc, movimientos_cc, clientes_cc,
        envio_items, envios,
        movimientos_inversiones, movimientos_deudas, contactos,
        comprobantes, pagos, vendedores,
        users
      RESTART IDENTITY CASCADE
    `);
  } catch { /* ignorar si la tabla no existe aún (migraciones no corridas) */ }
  await pool.end();
}

module.exports = { setupTestDb, teardownTestDb, TEST_USER, createTestUser };

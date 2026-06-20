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
const { TOOLS } = require('../../src/lib/tools');

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
      feature_flags,
      user_permissions, users
    RESTART IDENTITY CASCADE
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

  for (const tool of TOOLS) {
    await pool.query(
      'INSERT INTO user_permissions (user_id, tool, enabled) VALUES ($1,$2,$3)',
      [userId, tool, true]
    );
  }

  return pool;
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
        user_permissions, users
      RESTART IDENTITY CASCADE
    `);
  } catch { /* ignorar si la tabla no existe aún (migraciones no corridas) */ }
  await pool.end();
}

module.exports = { setupTestDb, teardownTestDb, TEST_USER };

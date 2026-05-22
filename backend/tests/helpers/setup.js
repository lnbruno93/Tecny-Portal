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

const TOOLS = ['cotizador', 'financiera', 'cajas', 'envios', 'usuarios', 'cuentas', 'usados'];

const TEST_USER = {
  nombre:   'Test Admin',
  username: 'testadmin',
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

  // Limpiar todas las tablas de datos y reiniciar secuencias
  await pool.query(`
    TRUNCATE TABLE
      audit_logs,
      items_movimiento_cc, movimientos_cc, clientes_cc,
      envio_items, envios,
      movimientos_inversiones, movimientos_deudas, contactos,
      comprobantes, pagos, vendedores,
      user_permissions, users
    RESTART IDENTITY CASCADE
  `);

  // Crear usuario admin de prueba
  const hash = await bcrypt.hash(TEST_USER.password, 10);
  const { rows } = await pool.query(
    'INSERT INTO users (nombre, username, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
    [TEST_USER.nombre, TEST_USER.username, hash, TEST_USER.role]
  );
  const userId = rows[0].id;

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

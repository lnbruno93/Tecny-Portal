/**
 * Helpers compartidos para los tests de integración.
 *
 * setupTestDb()  — corre las migraciones, limpia datos y crea usuario admin de prueba.
 *                  Devuelve el pool para que los tests puedan usarlo si necesitan
 *                  insertar datos directamente.
 *
 * teardownTestDb(pool) — cierra la conexión al terminar la suite.
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
const { runner: migrate } = require('node-pg-migrate');

const TOOLS = ['cotizador', 'financiera', 'cajas', 'envios', 'usuarios'];

const TEST_USER = {
  nombre:   'Test Admin',
  username: 'testadmin',
  password: 'testpass123',
  role:     'admin',
};

async function setupTestDb() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Correr migraciones (idempotente — igual que producción)
  await migrate({
    databaseUrl: process.env.DATABASE_URL,
    migrationsTable: 'pgmigrations',
    dir: path.join(__dirname, '../../migrations'),
    direction: 'up',
    log: () => {}, // silenciar output en tests
  });

  // Limpiar todas las tablas y reiniciar secuencias
  await pool.query(`
    TRUNCATE TABLE
      audit_logs, historial,
      envio_items, envios,
      movimientos_inversiones, movimientos_deudas, contactos,
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
  if (pool) await pool.end();
}

module.exports = { setupTestDb, teardownTestDb, TEST_USER };

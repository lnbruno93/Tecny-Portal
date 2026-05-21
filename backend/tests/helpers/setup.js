/**
 * Helpers compartidos para los tests de integración.
 *
 * setupTestDb()  — aplica el schema, limpia datos y crea usuario admin de prueba.
 *                  Devuelve el pool para que los tests puedan usarlo si necesitan
 *                  insertar datos directamente.
 *
 * teardownTestDb(pool) — cierra la conexión al terminar la suite.
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const TOOLS = ['cotizador', 'financiera', 'cajas', 'envios', 'usuarios'];

const TEST_USER = {
  nombre:   'Test Admin',
  username: 'testadmin',
  password: 'testpass123',
  role:     'admin',
};

async function setupTestDb() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Aplicar schema (CREATE TABLE IF NOT EXISTS → idempotente)
  const schema = fs.readFileSync(
    path.join(__dirname, '../../src/config/schema.sql'),
    'utf8'
  );
  await pool.query(schema);

  // Limpiar todas las tablas de una sola vez y reiniciar secuencias
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

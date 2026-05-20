/**
 * Inicializa la base de datos: crea tablas y usuario admin inicial.
 * Uso: node scripts/init-db.js
 * Variables requeridas: DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL || null;
const ADMIN_NOMBRE   = process.env.ADMIN_NOMBRE || 'Administrador';

if (!ADMIN_PASSWORD) {
  console.error('ERROR: ADMIN_PASSWORD es requerido');
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log('Conectando a la base de datos...');
    await pool.query('SELECT 1');
    console.log('Conexión OK');

    // Correr schema.sql
    const schema = fs.readFileSync(
      path.join(__dirname, '../src/config/schema.sql'),
      'utf8'
    );
    console.log('Aplicando schema...');
    await pool.query(schema);
    console.log('Schema aplicado');

    // Crear usuario admin si no existe
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [ADMIN_USERNAME]
    );

    if (rows.length > 0) {
      console.log(`Usuario "${ADMIN_USERNAME}" ya existe — sin cambios`);
    } else {
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
      const { rows: newUser } = await pool.query(
        'INSERT INTO users (nombre, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [ADMIN_NOMBRE, ADMIN_USERNAME, ADMIN_EMAIL, hash, 'admin']
      );

      const TOOLS = ['cotizador','financiera','cajas','envios','usuarios'];
      for (const tool of TOOLS) {
        await pool.query(
          'INSERT INTO user_permissions (user_id, tool, enabled) VALUES ($1,$2,$3)',
          [newUser[0].id, tool, true]
        );
      }
      console.log(`Usuario admin "${ADMIN_USERNAME}" creado con todos los permisos`);
    }

    console.log('\nBase de datos inicializada correctamente.');
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();

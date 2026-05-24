/**
 * Crea (o actualiza) un usuario demo con todos los permisos.
 * Pensado para entornos de staging/testing — NO toca el schema, solo inserta filas.
 * Idempotente: si el usuario ya existe, refresca su password y permisos.
 *
 * Uso:
 *   DATABASE_URL="<connection-string>" node scripts/seed-demo-user.js
 *
 * Variables opcionales:
 *   DEMO_USERNAME (default: demo)
 *   DEMO_PASSWORD (default: demo12345)
 *   DEMO_NOMBRE   (default: Demo)
 */
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const USERNAME = process.env.DEMO_USERNAME || 'demo';
const PASSWORD = process.env.DEMO_PASSWORD || 'demo12345';
const NOMBRE   = process.env.DEMO_NOMBRE   || 'Demo';

const TOOLS = [
  'cotizador', 'financiera', 'cajas', 'envios',
  'usuarios', 'cuentas', 'usados', 'inventario', 'ventas',
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: definí DATABASE_URL');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query('SELECT 1');
    const hash = await bcrypt.hash(PASSWORD, 10);

    // Upsert del usuario por username
    const { rows } = await pool.query(
      `INSERT INTO users (nombre, username, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (username)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, nombre = EXCLUDED.nombre
       RETURNING id`,
      [NOMBRE, USERNAME, hash]
    );
    const userId = rows[0].id;

    // Permisos: insertar los que falten (idempotente)
    for (const tool of TOOLS) {
      await pool.query(
        `INSERT INTO user_permissions (user_id, tool, enabled)
         VALUES ($1, $2, true)
         ON CONFLICT (user_id, tool) DO UPDATE SET enabled = true`,
        [userId, tool]
      );
    }

    console.log(`OK — usuario "${USERNAME}" (id ${userId}) listo con ${TOOLS.length} permisos.`);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();

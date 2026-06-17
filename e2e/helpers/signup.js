// Helpers de signup para tests E2E.
//
// Diseño:
//   - `getVerificationToken(email)` lee el token activo desde DB. En NODE_ENV=test
//     el backend también devuelve `_verification_token` en la response del
//     signup, pero leemos desde DB para ejercitar el path fiel a producción
//     (donde el token llega al user por email, no en JSON).
//   - No hay helper de cleanup: cada test usa un email único (timestamp +
//     random), y el globalSetup hace TRUNCATE solo una vez al arrancar la
//     suite. Esto es consistente con cómo el resto de los specs E2E manejan
//     estado (acumulativo dentro de un run).

const { Pool } = require('pg');

let _pool;
function getPool() {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

// Devuelve el token de verificación más reciente, NO usado, del user con
// el email indicado.
async function getVerificationToken(email) {
  const { rows } = await getPool().query(
    `SELECT t.token
       FROM email_verification_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE LOWER(u.email) = LOWER($1)
        AND t.used_at IS NULL
        AND t.expires_at > NOW()
      ORDER BY t.created_at DESC
      LIMIT 1`,
    [email]
  );
  if (rows.length === 0) {
    throw new Error(`No hay verification token activo para ${email}`);
  }
  return rows[0].token;
}

// Cuenta cuántos users hay con un email dado (case-insensitive). Útil para
// chequear que el caso "email duplicado" NO crea filas nuevas.
async function countUsersByEmail(email) {
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS c FROM users
      WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL`,
    [email]
  );
  return rows[0].c;
}

module.exports = { getVerificationToken, countUsersByEmail };

const db     = require('../config/database');
const logger = require('./logger');

async function audit(tabla, accion, registro_id, { antes = null, despues = null, user_id = null } = {}) {
  try {
    await db.query(
      `INSERT INTO audit_logs (tabla, accion, registro_id, datos_antes, datos_despues, user_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tabla, accion, registro_id, antes ? JSON.stringify(antes) : null, despues ? JSON.stringify(despues) : null, user_id || null]
    );
  } catch (err) {
    logger.error({ err, tabla, accion, registro_id }, 'audit log failed');
  }
}

module.exports = audit;

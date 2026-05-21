const { Pool } = require('pg');
const logger   = require('../lib/logger');

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  max:                     parseInt(process.env.DB_POOL_MAX)  || 10,
  connectionTimeoutMillis: parseInt(process.env.DB_CONN_TIMEOUT) || 5_000,   // falla rápido si el DB no responde
  idleTimeoutMillis:       parseInt(process.env.DB_IDLE_TIMEOUT)  || 30_000,  // libera conexiones ociosas
  allowExitOnIdle:         true,  // permite que el proceso termine sin clientes colgados
});

pool.on('error', (err) => {
  logger.error({ err }, 'PostgreSQL pool error');
});

module.exports = pool;

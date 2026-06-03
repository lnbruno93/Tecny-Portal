const { Pool, types } = require('pg');
const logger   = require('../lib/logger');

// PostgreSQL `DATE` (OID 1082) no tiene zona horaria — es una fecha calendario
// pura. Por default node-pg lo parsea como `Date` JS en la zona del servidor
// (Railway corre en UTC), y luego `JSON.stringify` lo emite como UTC ISO
// ("2026-05-29T00:00:00.000Z"). En el browser (Argentina, UTC-3) eso se
// interpreta como 2026-05-28 21:00 → la fecha se muestra UN DÍA ANTES de la
// que el usuario tipeó. Lo arreglamos devolviendo el string crudo "YYYY-MM-DD"
// que es exactamente lo que la columna guarda. TIMESTAMP/TIMESTAMPTZ no se
// tocan (esos sí necesitan conversión de zona).
types.setTypeParser(types.builtins.DATE, (val) => val);

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  max:                     parseInt(process.env.DB_POOL_MAX)  || 20,   // headroom para endpoints que lanzan varias queries en paralelo (tuneable por env)
  connectionTimeoutMillis: parseInt(process.env.DB_CONN_TIMEOUT) || 5_000,   // falla rápido si el DB no responde
  idleTimeoutMillis:       parseInt(process.env.DB_IDLE_TIMEOUT)  || 30_000,  // libera conexiones ociosas
  allowExitOnIdle:         true,  // permite que el proceso termine sin clientes colgados

  // Cortafuegos contra queries colgadas: una query lenta NO debe ocupar una
  // de las pocas conexiones del pool indefinidamente (agotaría el pool y tumbaría la API).
  statement_timeout:                   parseInt(process.env.DB_STATEMENT_TIMEOUT) || 15_000, // mata la query en el server
  query_timeout:                       parseInt(process.env.DB_QUERY_TIMEOUT)     || 15_000, // corta del lado del cliente
  idle_in_transaction_session_timeout: parseInt(process.env.DB_IDLE_TX_TIMEOUT)   || 10_000, // libera tx abandonadas
});

pool.on('error', (err) => {
  logger.error({ err }, 'PostgreSQL pool error');
});

module.exports = pool;

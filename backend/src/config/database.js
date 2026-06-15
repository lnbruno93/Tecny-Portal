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

/**
 * 2026-06-15 multi-tenant PR 3 — helper para queries con contexto de tenant.
 *
 * Saca un client del pool, abre una tx implícita, setea `app.current_tenant`
 * vía `SET LOCAL`, ejecuta el callback, commitea (o rollback si throw), y
 * libera el client. `SET LOCAL` solo aplica dentro de la tx — al commitear,
 * el client vuelve al pool con `app.current_tenant` reseteado, evitando que
 * otro request herede el contexto (issue clásico con connection pooling + RLS).
 *
 * Mientras Postgres tiene RLS activo (PR 2), las queries dentro del callback
 * filtran automáticamente al tenant especificado. Los endpoints actuales NO
 * usan este helper todavía (siguen vía db.query con RLS allow-all). PR 4
 * refactorea endpoints para usar withTenant.
 *
 * Uso:
 *   const ventas = await db.withTenant(req.tenantId, async (client) => {
 *     const { rows } = await client.query('SELECT * FROM ventas WHERE id = $1', [id]);
 *     return rows;
 *   });
 *
 * @param {number} tenantId — id del tenant de la sesión actual
 * @param {function(client): Promise<*>} callback — recibe el client tx-scoped
 * @returns {Promise<*>} — lo que devuelva el callback
 * @throws {Error} si el callback lanza (la tx se rollbackea antes de propagar)
 */
pool.withTenant = async function withTenant(tenantId, callback) {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`withTenant: tenantId inválido (${tenantId})`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL: válido SOLO dentro de la tx en curso. Al COMMIT, la setting
    // se descarta — el client vuelve al pool limpio. Crítico para evitar leak
    // de contexto entre requests.
    //
    // Nota: Postgres NO acepta bind parameters en SET. Interpolamos `tenantId`
    // directo en el SQL. Seguro porque arriba validamos que es Number.isInteger
    // > 0 (Number to string es trivial, sin SQL injection posible).
    await client.query(`SET LOCAL app.current_tenant = ${tenantId}`);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow — propaga el error original */ }
    throw err;
  } finally {
    client.release();
  }
};

module.exports = pool;

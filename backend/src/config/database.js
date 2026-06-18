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

// ── Instrumentación defensiva: int-cast errors ───────────────────────────
//
// Bug latente reportado en staging 2026-06-17 22:21:14: un POST /api/auth/login
// devolvió 500 con:
//   err.message: 'invalid input syntax for type integer: ""'
//   err.routine: 'pg_strtoint32_safe'
//
// La investigación del login path no encontró ninguna query que reciba input
// del request en una columna int — todas usan user.id (DB row). El sporadic
// 1-de-2 probablemente fue:
//   (a) un endpoint adyacente cuyo error fue mal-atribuido a /login por el
//       logger (request_id bleeding), o
//   (b) un payload edge-case que evadió las defensas existentes.
//
// Sin más evidencia no se puede apuntar al call site exacto. Esta capa
// instrumenta `pool.query` para que la PRÓXIMA vez que ocurra un error
// de cast int (pg_strtoint16/32/64), loguee el SQL + params + stack abreviado
// — convirtiendo el sporadic en evidencia procesable inmediatamente.
//
// Trade-off: agregamos un try/catch + check de routine en cada query del
// backend. El cost es ~µs por query (overhead despreciable vs el round-trip
// a Postgres). El upside es ENORME: la próxima recurrencia del bug tiene
// stack trace + SQL en el log, no toca debugger.
//
// Decisión de scope: solo logueamos errores con `routine` en INT_CAST_ROUTINES
// (no todos los DatabaseError). Esto evita ruido — solo logueamos lo que es
// específicamente el bug que estamos cazando.
const INT_CAST_ROUTINES = new Set([
  'pg_strtoint16',        // int2 (smallint) — Postgres 16+
  'pg_strtoint16_safe',   // int2 — Postgres 17+
  'pg_strtoint32',        // int4 (integer) — Postgres 16
  'pg_strtoint32_safe',   // int4 — Postgres 17+ — el que vimos en staging
  'pg_strtoint64',        // int8 (bigint) — Postgres 16
  'pg_strtoint64_safe',   // int8 — Postgres 17+
]);

// Logging compartido entre el wrapper de pool.query y el de client.query.
// Captura el call site preservando el stack capturado en el wrapper (sin
// node_modules/pg) — clave para identificar qué línea de nuestro código
// emitió la query.
function _logIntCastErrorIfMatch(err, args, capturedStack) {
  if (!err || !INT_CAST_ROUTINES.has(err.routine)) return;
  // Best-effort extract de SQL + params para el log. El primer arg puede ser:
  //   - string: `query('SELECT ...', [params])`
  //   - objeto: `query({ text: 'SELECT ...', values: [params] })`
  const first = args[0];
  const sql = typeof first === 'string' ? first
            : (first && typeof first.text === 'string') ? first.text
            : '<unknown>';
  const params = Array.isArray(args[1]) ? args[1]
               : (first && Array.isArray(first.values)) ? first.values
               : null;
  logger.error({
    err: { message: err.message, routine: err.routine, position: err.position, code: err.code },
    sql: typeof sql === 'string' ? sql.slice(0, 500) : sql,
    // Sanitize params: stringify y truncar. NO loggeamos secrets — los
    // params típicos del bug son int ids, no passwords. Si por alguna razón
    // un password caía acá, se truncaría también. Riesgo aceptable vs valor
    // de debug.
    params_preview: params ? JSON.stringify(params).slice(0, 500) : null,
    stack_short: capturedStack,
  }, 'int_cast_error — query con int cast inválido (debug bug pg_strtoint)');
}

// Captura stack del call site del wrapper. Skipea las primeras 3 frames
// (Error header + esta función + el wrapper que la llama) y se queda con
// 6 frames userland.
function _captureCallerStack() {
  return new Error().stack
    .split('\n')
    .slice(3, 9)
    .join('\n');
}

const _originalQuery = pool.query.bind(pool);
pool.query = async function instrumentedQuery(...args) {
  const callerStack = _captureCallerStack();
  try {
    return await _originalQuery(...args);
  } catch (err) {
    _logIntCastErrorIfMatch(err, args, callerStack);
    throw err;
  }
};

// Extensión: instrumentamos también `client.query` para los call sites que
// usan `pool.connect()` + `client.query()` directamente (ej. transacciones
// manuales: `change-password`, `withTenant`, scripts admin). Sin esto, el
// wrapper de `pool.query` deja una zona ciega — el bug pg_strtoint del login
// puede vivir en una query de tx que use client.query y nunca lo cazaríamos.
//
// Implementación: wrappeamos pool.connect → al devolver el client, parchamos
// su .query in-place (idempotente vía flag `__intCastInstrumented`). El client
// devuelve al pool con el patch — cuando otro request lo saque, ya está
// instrumentado.
//
// Importante: pool.connect tiene 2 firmas:
//   (1) `pool.connect()` → returns Promise<Client>          (usamos esta)
//   (2) `pool.connect(cb)` → calls cb(err, client, done)    (uso INTERNO de pg-pool!)
//
// pg-pool internamente usa la firma callback en `pool.query` (porque el pool
// saca un client, corre la query, lo libera todo via callback). Si nuestro
// wrapper hiciera `await _originalConnect(cb)`, el await resuelve a undefined
// (pg pasa el client al callback, no via promise) → rompe pool.query
// con "Cannot read properties of undefined".
//
// Solución: si el último arg es función (callback-style), interceptamos el
// callback para instrumentar el client antes de devolverlo. Si no, wrappeamos
// la promesa.
function _instrumentClient(client) {
  if (!client || client.__intCastInstrumented) return client;
  const _originalClientQuery = client.query.bind(client);
  client.query = function instrumentedClientQuery(...queryArgs) {
    const callerStack = _captureCallerStack();
    // client.query también soporta callback-style. Si el último arg es
    // función, devolvemos tal cual (el callback recibirá err/result).
    const last = queryArgs[queryArgs.length - 1];
    if (typeof last === 'function') {
      return _originalClientQuery(...queryArgs);
    }
    const result = _originalClientQuery(...queryArgs);
    if (result && typeof result.then === 'function') {
      return result.catch(err => {
        _logIntCastErrorIfMatch(err, queryArgs, callerStack);
        throw err;
      });
    }
    return result;
  };
  client.__intCastInstrumented = true;
  return client;
}

const _originalConnect = pool.connect.bind(pool);
pool.connect = function instrumentedConnect(...args) {
  const last = args[args.length - 1];
  if (typeof last === 'function') {
    // Callback-style: interceptamos el cb para instrumentar el client antes
    // de pasárselo al caller original (probablemente el pool.query interno
    // de pg-pool). El client queda con .query patched para todo su lifetime.
    const userCb = last;
    const newArgs = args.slice(0, -1);
    return _originalConnect(...newArgs, (err, client, done) => {
      if (!err) _instrumentClient(client);
      userCb(err, client, done);
    });
  }
  // Promise-style: wrappeamos la promesa para instrumentar al client antes
  // de devolverlo al caller.
  return _originalConnect(...args).then(_instrumentClient);
};

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

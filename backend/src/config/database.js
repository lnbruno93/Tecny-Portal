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
    // 2026-07-12 (auditoría TOTAL P0-1 Plataforma): usar `set_config()` con
    // bind param en vez de interpolar `tenantId` en el SQL.
    //
    // Antes: `SET LOCAL app.current_tenant = ${tenantId}` con nota "Postgres
    // no acepta bind en SET". La nota es correcta para el comando `SET`,
    // pero `set_config()` SÍ acepta bind — es una función SQL normal. Ya
    // usábamos ese patrón en migrations (ej.
    // `20260624000001_capability_roles_owner_admin_backfill.js:65`).
    //
    // Ventajas:
    //   1. Parametrización real — inmune a regressions futuras si algún
    //      caller pasa un valor sin validar.
    //   2. Consistente con el pattern de las migrations.
    //   3. El guard `Number.isInteger` arriba se mantiene como defense-in-
    //      depth. El bind param es defensa adicional.
    //
    // `SET LOCAL` = `set_config(..., is_local=true)` (3er arg=true).
    // Documentación:
    //   https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(tenantId)]
    );
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

// ────────────────────────────────────────────────────────────────────────────
// 2026-06-21 #353 Fase 1 — Admin pool (BYPASSRLS)
//
// Pool separado con role `tecny_admin` que tiene BYPASSRLS attribute en
// Postgres. Permite a los endpoints `/api/admin/*` ver TODOS los tenants
// sin importar la policy RLS — necesario para el dashboard super-admin
// que opera cross-tenant.
//
// Lazy init: solo abre el pool cuando se llama por PRIMERA vez. Razón: en
// tests + dev local NO existe el role tecny_admin (no corremos el
// CREATE ROLE en migrations — es operación de infra, no de schema). Tests
// que necesitan adminQuery deben mockear este pool o tolerar el throw.
// En prod/staging, ADMIN_DATABASE_URL viene de Railway env.
//
// Si ADMIN_DATABASE_URL no está seteado, devolvemos pool normal — los
// endpoints admin entonces ven solo lo que RLS deja pasar (filtrado por
// tenant del super-admin). En prod NUNCA debería pasar — el deploy debe
// fallar antes (validar en server.js startup checks).
//
// Mismo connection settings que el pool principal (timeout, max, etc).
let _adminPool = null;
function getAdminPool() {
  if (_adminPool) return _adminPool;
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    // No ADMIN_DATABASE_URL → fallback al pool principal. Esto es seguro
    // porque requireSuperAdmin sigue bloqueando acceso no-autorizado; lo
    // que perdemos es el bypass de RLS (las queries admin filtran por
    // tenant del super-admin, mostrando solo el tenant 1). Tests + dev
    // local usan esto.
    logger.warn(
      '[db.adminQuery] ADMIN_DATABASE_URL no configurado — usando pool principal (RLS aplicará). En prod esto debería estar seteado.'
    );
    return pool;
  }
  _adminPool = new Pool({
    connectionString:        adminUrl,
    max:                     parseInt(process.env.ADMIN_DB_POOL_MAX) || 5,  // mucho menos tráfico que app pool
    connectionTimeoutMillis: parseInt(process.env.DB_CONN_TIMEOUT)   || 5_000,
    idleTimeoutMillis:       parseInt(process.env.DB_IDLE_TIMEOUT)   || 30_000,
    allowExitOnIdle:         true,
    statement_timeout:                   parseInt(process.env.DB_STATEMENT_TIMEOUT) || 15_000,
    query_timeout:                       parseInt(process.env.DB_QUERY_TIMEOUT)     || 15_000,
    idle_in_transaction_session_timeout: parseInt(process.env.DB_IDLE_TX_TIMEOUT)   || 10_000,
  });
  _adminPool.on('error', (err) => {
    logger.error({ err }, 'Admin PostgreSQL pool error');
  });
  return _adminPool;
}

/**
 * Ejecuta callback con un client del pool admin (BYPASSRLS). Para uso
 * EXCLUSIVO de endpoints /api/admin/* que operan cross-tenant.
 *
 * NO usar desde rutas tenant-scoped — eso violaría RLS y leakaría data.
 * El linter de CI debería rechazar `db.adminQuery` fuera de
 * `backend/src/routes/admin/`.
 *
 * Sin tx auto (a diferencia de withTenant) — el caller decide si abre tx.
 * Razón: las queries admin son mayormente reads agregados (cross-tenant
 * SELECTs), no requieren tx para ser correctos. Mutations (PATCH tenant)
 * sí abren tx manualmente con `client.query('BEGIN')`.
 *
 * @param {function(client): Promise<*>} callback — recibe un pg.Client.
 * @returns {Promise<*>} lo que devuelva el callback.
 */
pool.adminQuery = async function adminQuery(callback) {
  const client = await getAdminPool().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
};

// Cleanup del pool admin en shutdown.
pool.endAdmin = async function endAdmin() {
  if (_adminPool) {
    try { await _adminPool.end(); } catch (_) { /* swallow */ }
    _adminPool = null;
  }
};

module.exports = pool;

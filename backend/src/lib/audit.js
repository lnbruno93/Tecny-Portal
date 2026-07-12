const db     = require('../config/database');
const logger = require('./logger');
const withAdvisoryLock = require('./withAdvisoryLock');
const { createCachedFetcherRedis } = require('./cacheTtl');

// ──────────────────────── P-07 async toggle ───────────────────────
// `isAsyncEnabled()` lee el feature flag `audit_async_enabled` de la tabla
// `feature_flags`. Acoplado directamente acá (no via feature-flags.js) para
// evitar dependencia circular: `feature-flags.js` hace `require('audit')`
// para auditar sus propias mutations. Si audit.js requiriera feature-flags.js,
// formaría ciclo.
//
// 2026-06-12 P-04 Fase 3: el cache pasó de in-memory (60s TTL local) a Redis
// cross-instance. Cuando admin cambia el flag via PATCH /api/feature-flags/:name,
// el endpoint llama `audit._clearAsyncCache()` que ahora hace `redis.del(key)`
// — las 2+ réplicas ven el cambio en <100ms en lugar de hasta 60s TTL natural.
// Si Redis está down, el wrapper hace fetch directo a Postgres cada vez (sin
// cachear) — preserva consistency cross-instance a costo de throughput.
//
// Fail-safe: si la tabla `feature_flags` no existe o la query falla, el
// fetcher devuelve false (path síncrono sigue). NO se cachea ese false con
// error — la próxima call vuelve a intentar.
//
// En NODE_ENV=test el wrapper bypasea Redis (createCachedFetcherRedis lo
// desactiva), pero igualmente hacemos short-circuit ANTES para evitar incluso
// el round-trip a DB. Razón: audit() se llama decenas de veces por test
// integración, y aún sin cache cada llamada agregaría una query a feature_flags
// que satura el pool y genera flakiness (invariants/race-conditions/tarjetas-
// export fallaban con timeouts).
const ASYNC_FLAG_TTL_MS = 60_000;
const ASYNC_FLAG_REDIS_KEY = 'cache:flag:audit_async_enabled';

async function _fetchFlagFromDb() {
  try {
    const { rows } = await db.query(
      `SELECT enabled FROM feature_flags WHERE name = 'audit_async_enabled'`
    );
    return rows[0]?.enabled === true;
  } catch (err) {
    // Tabla feature_flags no existe (DB pre-M-08), flag no existe, conexión rota:
    // fail-safe a path síncrono. NO propagar el error al wrapper (sino el
    // cache quedaría sin populating y next call también falla).
    logger.warn({ err: err?.message }, 'audit: isAsyncEnabled fallback a sync (flag no disponible)');
    return false;
  }
}

const _getAsyncFlag = createCachedFetcherRedis(
  ASYNC_FLAG_REDIS_KEY,
  ASYNC_FLAG_TTL_MS,
  _fetchFlagFromDb
);

async function isAsyncEnabled() {
  // Test bypass: no tocar DB ni Redis. Ver razón en el header arriba.
  if (process.env.NODE_ENV === 'test') return _testOverride === true;
  return _getAsyncFlag();
}

let _testOverride = false;
function _clearAsyncCache() {
  // Wrapper devuelve una Promise (es async porque puede llamar redis.del).
  // Caller debe await si quiere garantía de invalidación pre-response.
  return _getAsyncFlag.invalidate();
}
function _setAsyncEnabledForTest(value) { _testOverride = value === true; }

// ──────────────────────── Redacción de PII ────────────────────────
// Los `audit_logs` persisten `antes`/`despues` completos de las filas afectadas
// para trazabilidad. Sin redacción, eso incluye PII (teléfono, dirección, IMEI,
// nombres de clientes) — un riesgo bajo Ley 25.326 y GDPR si algún cliente pide
// el derecho al olvido. Redactamos las claves sensibles ANTES de persistir.
//
// Reglas:
//   · telefono / direccion / barrio / notas / observaciones → '(redactado)'
//   · imei / serie / nroserie → '***' + últimos 4 chars (útil para identificar
//     sin exponer la cadena completa).
//   · cliente_nombre / cliente / nombre_cliente → primer nombre + inicial del
//     apellido (mantiene utilidad operativa para revisar el historial).
//   · email / whatsapp → primeras 3 letras + '***'
//   · password / token / api_key → siempre eliminadas (defensa en profundidad).
//
// Las columnas de catálogo (categoria, deposito, proveedor, estado, fecha,
// montos) NO se redactan: no son PII y son las que dan utilidad al audit.

// ALWAYS_REMOVE — campos que se borran completamente. Auditoría 2026-06-06
// Sec M2: agregamos campos de 2FA (`secret_encrypted` cifrado AES-GCM,
// `recovery_codes` hashes bcrypt, `recovery_codes_hash`) por defensa en
// profundidad. Hoy las llamadas a audit() pasan objetos curados, pero el
// día que alguien haga audit('user_2fa', 'UPDATE', id, { antes: row }) con
// el row completo, estos campos terminaban en audit_logs sin protección.
const ALWAYS_REMOVE = new Set([
  'password', 'password_hash', 'token', 'api_key', 'secret', 'jwt',
  'secret_encrypted', 'recovery_codes', 'recovery_codes_hash',
  'code', 'totp_code', 'recovery_code',
]);
const FULL_REDACT   = new Set(['telefono', 'direccion', 'barrio', 'notas', 'observaciones', 'whatsapp']);
const PARTIAL_IMEI  = new Set(['imei', 'serie', 'nroserie', 'numero_serie']);
const PARTIAL_NAME  = new Set(['cliente_nombre', 'cliente', 'nombre_cliente', 'contacto_nombre', 'contacto_apellido']);
const PARTIAL_MAIL  = new Set(['email']);

function maskTail(s, keep = 4) {
  const v = String(s ?? '');
  if (v.length <= keep) return '***';
  return '***' + v.slice(-keep);
}
function maskName(s) {
  const parts = String(s ?? '').trim().split(/\s+/);
  if (parts.length <= 1) return parts[0] || '';
  return parts[0] + ' ' + (parts[parts.length - 1][0] || '') + '.';
}
function maskEmail(s) {
  const m = String(s ?? '').match(/^([^@]+)(@.+)?$/);
  if (!m) return '***';
  return (m[1].slice(0, 3) || '***') + '***' + (m[2] || '');
}

function redactPII(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactPII);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (ALWAYS_REMOVE.has(k)) continue; // password/token/api_key: se omite el campo
    // Si el valor es objeto/array, recursar primero (las reglas de redacción asumen escalar).
    if (v && typeof v === 'object') { out[k] = redactPII(v); continue; }
    if (FULL_REDACT.has(k))       out[k] = v ? '(redactado)' : v;
    else if (PARTIAL_IMEI.has(k)) out[k] = v ? maskTail(v) : v;
    else if (PARTIAL_NAME.has(k)) out[k] = v ? maskName(v) : v;
    else if (PARTIAL_MAIL.has(k)) out[k] = v ? maskEmail(v) : v;
    else out[k] = v;
  }
  return out;
}

// audit() acepta opcionalmente un client de pg como primer arg:
//   audit(client, 'tabla', 'INSERT', id, { ... })  → atómico dentro de la tx
//   audit('tabla', 'INSERT', id, { ... })          → pool global (compat)
//
// Cuando se llama dentro de una tx, persistir el audit en la MISMA tx evita el
// caso "el cambio se commiteó pero el audit no" (proceso muere entre COMMIT y
// audit, error de red, latencia, etc.).
//
// Detección por arg type: si el primer arg tiene `.query()` y NO es un string,
// es un pg client; sino es el `tabla` (firma vieja).
function isPgClient(x) {
  return x != null && typeof x === 'object' && typeof x.query === 'function';
}

async function audit(...args) {
  let client = db;          // pool global por default
  let useSavepoint = false; // si vino client de tx, isolamos con SAVEPOINT
  if (isPgClient(args[0])) {
    client = args.shift();
    useSavepoint = true;
  }
  const [tabla, accion, registro_id, opts = {}] = args;
  const { antes = null, despues = null, user_id = null, req = null, ...extra } = opts;
  // Permitimos pasar metadata extra (ej. `_origen`) — la mergeamos en `despues` y la redactamos.
  const desp = (despues || Object.keys(extra).length) ? { ...(despues || {}), ...extra } : null;
  // 2026-06-11 SE-05: si el caller pasa `req`, extraemos IP, User-Agent y
  // request_id para forense + compliance (Ley 25.326 art. 9). Capacidad
  // best-effort: si req no viene (audits programáticos desde jobs, crons),
  // los 3 campos quedan NULL — comportamiento idéntico al previo.
  const ip = req?.ip || null;
  const userAgent = req?.headers?.['user-agent']?.slice(0, 512) || null;
  const requestId = req?.id || null;
  // 2026-06-16 TANDA 0a hardening multi-tenant: hasta hoy `audit_logs.tenant_id`
  // se quedaba siempre NULL (la columna existía desde PR 1 pero el INSERT no la
  // pasaba), y la policy RLS los hacía visibles solo gracias al fallback
  // permisivo "OR current_setting IS NULL". Eso significa que cualquier endpoint
  // que listara audit_logs (ej. /api/historial) leía audits cross-tenant.
  //
  // Estrategia de resolución del tenant (orden):
  //   1. `opts.tenant_id` explícito (mejor performance, sin query extra).
  //   2. `req.tenantId` decorado por el middleware requireAuth (próximo en perf).
  //   3. SHOW app.current_tenant del client — fallback robusto para audits
  //      programáticos sin req (jobs, crons, lib internos). Si el client
  //      hizo SET LOCAL en su tx, retorna el tenant correcto. Si no, retorna
  //      '' y dejamos tenant_id NULL — apropiado para audits de sistema.
  let tenantId = opts.tenant_id ?? req?.tenantId ?? null;
  if (tenantId == null) {
    try {
      // current_setting(name, missing_ok=true) retorna NULL si la GUC nunca
      // se seteó, en vez de lanzar error (que abortaría la tx exterior).
      // SHOW no acepta missing_ok, por eso usamos current_setting().
      const r = await client.query("SELECT current_setting('app.current_tenant', true) AS t");
      const n = Number(r.rows[0]?.t);
      if (Number.isFinite(n) && n > 0) tenantId = n;
    } catch { /* defensive: dejamos NULL — audit del sistema */ }
  }
  const params = [
    tabla, accion, registro_id,
    antes ? JSON.stringify(redactPII(antes)) : null,
    desp  ? JSON.stringify(redactPII(desp))  : null,
    user_id || null,
    ip,
    userAgent,
    requestId,
    tenantId,
  ];

  // P-07 bifurcación: si el flag `audit_async_enabled` está ON, encolamos en
  // audit_queue (un worker en background mueve a audit_logs en batches). Sino,
  // path sync legacy a audit_logs. Default OFF en todos los entornos hasta que
  // un admin lo active. Los 5 tests integración existentes de read-after-write
  // siguen viendo el path síncrono.
  //
  // El SAVEPOINT pattern se preserva intacto en ambos paths: si el caller hizo
  // BEGIN y luego ROLLBACK, el audit (sea sync o async) se revierte con la tx.
  // Esto cumple req #9 del doc — el audit NO se procesa si la tx fallo.
  const asyncEnabled = await isAsyncEnabled();
  const sql = asyncEnabled
    ? `INSERT INTO audit_queue (tabla, accion, registro_id, datos_antes, datos_despues, user_id, ip, user_agent, request_id, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`
    : `INSERT INTO audit_logs (tabla, accion, registro_id, datos_antes, datos_despues, user_id, ip, user_agent, request_id, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
  try {
    if (useSavepoint) {
      // SAVEPOINT aísla el INSERT: si falla, NO contamina la tx exterior.
      // El INSERT sigue siendo atómico con el resto de la tx si todo va bien.
      await client.query('SAVEPOINT audit_sp');
      try {
        await client.query(sql, params);
        await client.query('RELEASE SAVEPOINT audit_sp');
      } catch (innerErr) {
        try { await client.query('ROLLBACK TO SAVEPOINT audit_sp'); } catch { /* ignore */ }
        throw innerErr;
      }
    } else {
      await client.query(sql, params);
    }
  } catch (err) {
    logger.error({ err, tabla, accion, registro_id }, 'audit log failed');
    // Reportar a Sentry si está configurado — audit failure es crítico (pérdida de trazabilidad)
    try {
      const Sentry = require('@sentry/node');
      if (process.env.SENTRY_DSN) {
        Sentry.captureException(err, {
          tags:  { tabla, accion },
          extra: { registro_id, user_id },
        });
      }
    } catch { /* Sentry no disponible — no propagar el error */ }
  }
}

// 2026-07-12 (auditoría TOTAL Plataforma P1-1): borradas
// `purgarAuditLogsViejos` + `startPurgaJob` (~40 líneas).
//
// Motivación: audit_logs está particionado por mes desde la migration
// 20260611000004_audit_logs_partitioned. El job `auditPartitionsJob` en
// server.js:64 corre `drop_old_audit_partitions(retention_months)` —
// path eficiente: dropea la partition entera en milisegundos, sin locks
// row-by-row y sin escaneo.
//
// El DELETE row-by-row de purgarAuditLogsViejos era:
//   · Redundante con drop_old_audit_partitions (ambos borran lo mismo)
//   · Peligroso: bajo statement_timeout=15s + tabla con 1M+ rows por
//     partition timeout-eaba silenciosamente y el withAdvisoryLock ya
//     había registrado el "run" del día → inconsistencia
//   · Inútil: la retención efectiva la mantenía SOLO el partition drop,
//     el DELETE era no-op (ya no había filas viejas en las partitions
//     activas después del drop)
//
// Si el futuro requiere purga row-by-row para `audit_queue` (tabla plana
// sin partitioning), crear un helper nuevo `purgarAuditQueueViejos` con
// nombre distinto — NO reactivar este código muerto.

module.exports = audit;
module.exports.redactPII = redactPII;
// 2026-07-12 (auditoría TOTAL Plataforma P1-1): removido export de
// startPurgaJob (borrado junto con purgarAuditLogsViejos).
// P-07: exposed for the worker (auditQueueWorker.js) and tests.
module.exports.isAsyncEnabled = isAsyncEnabled;
module.exports._clearAsyncCache = _clearAsyncCache;
module.exports._setAsyncEnabledForTest = _setAsyncEnabledForTest;

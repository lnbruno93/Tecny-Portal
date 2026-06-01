const db     = require('../config/database');
const logger = require('./logger');

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

const ALWAYS_REMOVE = new Set(['password', 'password_hash', 'token', 'api_key', 'secret', 'jwt']);
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
  const { antes = null, despues = null, user_id = null, ...extra } = opts;
  // Permitimos pasar metadata extra (ej. `_origen`) — la mergeamos en `despues` y la redactamos.
  const desp = (despues || Object.keys(extra).length) ? { ...(despues || {}), ...extra } : null;
  const params = [
    tabla, accion, registro_id,
    antes ? JSON.stringify(redactPII(antes)) : null,
    desp  ? JSON.stringify(redactPII(desp))  : null,
    user_id || null,
  ];
  const sql = `INSERT INTO audit_logs (tabla, accion, registro_id, datos_antes, datos_despues, user_id)
               VALUES ($1,$2,$3,$4,$5,$6)`;
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

// Purga audit_logs viejos: por defecto conserva 365 días. Idempotente.
// Útil para cumplir el "derecho al olvido" y mantener la tabla acotada.
async function purgarAuditLogsViejos(diasRetencion = 365) {
  const dias = Math.max(30, Number(diasRetencion) || 365); // mínimo 30 días por seguridad
  const { rowCount } = await db.query(
    `DELETE FROM audit_logs WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [dias]
  );
  logger.info({ dias, rowCount }, 'audit_logs purga ejecutada');
  return rowCount;
}

// Job interno de purga periódica. Se invoca desde `server.js` al arrancar
// y dispara purgarAuditLogsViejos() cada `intervalHours` horas (default 24).
//
// Por qué un setInterval interno y no pg_cron / Railway Scheduler:
//   - Cero infra extra. Una instancia → un job.
//   - Cuando escalemos a múltiples workers, esto se debe migrar a un
//     scheduler externo (PG advisory lock entre workers, o cron de Railway)
//     porque cada worker dispararía el DELETE simultáneamente.
//
// Devuelve el handle del intervalo (para test/shutdown).
//
// Multi-instance safe: con N replicas, todas disparan el setInterval, pero el
// advisory lock garantiza que SOLO UNA ejecuta la purga real. Las demás
// logean "skipped".
function startPurgaJob({ diasRetencion = 365, intervalHours = 24, runOnStartup = false } = {}) {
  // No se programa en tests para no contaminar la DB de test ni dejar timers vivos
  // entre suites (Jest --runInBand detecta open handles).
  if (process.env.NODE_ENV === 'test') return null;

  // Require lazy para evitar circular dep (withAdvisoryLock importa logger desde
  // este mismo módulo en cadena vía database config).
  const { withAdvisoryLock } = require('./withAdvisoryLock');

  const intervalMs = intervalHours * 60 * 60 * 1000;
  const runOnce = async () => {
    try {
      await withAdvisoryLock('ipro-job-audit-purga', () => purgarAuditLogsViejos(diasRetencion));
    } catch (err) {
      logger.error({ err }, 'audit_logs purga falló — reintenta mañana');
    }
  };

  if (runOnStartup) runOnce(); // útil en dev / al deployar después de mucho tiempo

  const handle = setInterval(runOnce, intervalMs);
  // .unref() evita que el timer mantenga vivo el proceso durante shutdown.
  if (typeof handle.unref === 'function') handle.unref();
  logger.info({ diasRetencion, intervalHours }, 'audit_logs purga job programado');
  return handle;
}

module.exports = audit;
module.exports.redactPII = redactPII;
module.exports.purgarAuditLogsViejos = purgarAuditLogsViejos;
module.exports.startPurgaJob = startPurgaJob;

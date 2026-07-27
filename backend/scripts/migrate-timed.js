#!/usr/bin/env node
/**
 * migrate-timed.js — wrapper de `npm run migrate` con timing + Sentry alert.
 *
 * 2026-07-27 (audit 07-25 Track E P1-8):
 *
 * ── Problema original ──────────────────────────────────────────────────
 *
 * `railway.json` corre `npm run migrate && node server.js` como startCommand.
 * Si el migrate demora > healthcheckTimeout (300s), Railway marca el deploy
 * FAILED y reintenta 3× (restartPolicyMaxRetries). Sin telemetría de la
 * duración, es imposible saber cuánto queda del budget de 300s cuando un
 * migration pesado (ej. bulk backfill del PR #876 con 41 categorías huérfanas)
 * ya lleva 3-4 minutos.
 *
 * ── Fix ────────────────────────────────────────────────────────────────
 *
 * Este script:
 *   1. Corre `node-pg-migrate` como child process (mismo binario del
 *      `npm run migrate` original).
 *   2. Mide duración total con `performance.now()`.
 *   3. Loggea al stdout como JSON estructurado (Railway logs indexan por keys).
 *   4. Si duración > MIGRATE_WARN_SECONDS (default 60s), reporta Sentry
 *      captureMessage warning con `duration_ms` + `migration_names` (si
 *      podemos extraerlo del stdout).
 *   5. Si duración > MIGRATE_FATAL_SECONDS (default 240s = 80% de 300s),
 *      reporta Sentry error — deploy inminente a fallar healthcheck.
 *
 * Sale con exit code 0 en success (para no romper el `&&` con server.js).
 * Si el migrate falla (exit code != 0), replica el mismo exit code y
 * emite Sentry error automáticamente.
 *
 * ── Cómo usar ──────────────────────────────────────────────────────────
 *
 * En `railway.json`:
 *   "startCommand": "node scripts/migrate-timed.js && node server.js"
 *
 * Local:
 *   node scripts/migrate-timed.js
 *
 * Env vars opcionales:
 *   MIGRATE_WARN_SECONDS  — default 60. Duración desde la cual se alerta warn.
 *   MIGRATE_FATAL_SECONDS — default 240. Duración desde la cual se alerta error.
 *   SENTRY_DSN            — si no está, no reporta pero sigue funcionando.
 */

const { spawn } = require('child_process');
const path = require('path');

const WARN_SECONDS  = Number(process.env.MIGRATE_WARN_SECONDS)  || 60;
const FATAL_SECONDS = Number(process.env.MIGRATE_FATAL_SECONDS) || 240;

// Cargamos Sentry lazy — silent-fail si no está configurado. Mismo pattern
// que los handlers de app.js y database.js (fast-path exit) para no explotar
// en dev local sin SENTRY_DSN.
function reportSentry(level, message, extra) {
  if (!process.env.SENTRY_DSN) return;
  try {
    const Sentry = require('@sentry/node');
    if (!Sentry.getClient?.()) {
      // Sentry no fue init-eado por server.js todavía (corremos ANTES). Init
      // mínimo acá — el server.js lo re-inicia después con la config completa.
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'production',
        release: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'unknown',
      });
    }
    Sentry.captureMessage(message, {
      level, // 'warning' | 'error'
      tags: {
        source: 'migrate-timed',
        service: 'tecny-backend',
      },
      extra,
    });
    // Flush best-effort — el proceso termina inmediatamente después.
    Sentry.flush(2000).catch(() => {});
  } catch { /* dev sin Sentry, o Sentry crash — no rompemos el startup */ }
}

const start = process.hrtime.bigint();
const migrationsSeen = [];

// Corremos node-pg-migrate exactamente como el script npm original:
//   node-pg-migrate -m migrations up
// Path relativo al backend/ (donde corre en Railway).
//
// 2026-07-27 hotfix: stderr también en 'pipe' (era 'inherit'). node-pg-migrate
// emite un warning por cada migration file con timestamp no-Unix ("Can't
// determine timestamp for 20260527000002") — nuestras 100+ migrations usan
// el formato YYYYMMDDhhmmss que ese lib no reconoce como timestamp. En
// 'inherit', los ~150 warnings se cuelan directo a Railway logs y hitean
// el rate limit de 500 logs/sec, matando el container ("Stopping Container")
// antes de que la migration siquiera empiece. Los 3 deploys anteriores en
// staging fallaron por esto (48fc66da, fb128bbc, 928d1970 — email a Lucas).
//
// Fix: capturar stderr, filtrar los warnings inocuos línea por línea, y
// escribir solo lo que NO es noise. Cualquier stderr no filtrado pasa
// intacto (queremos ver errores reales).
const child = spawn(
  path.resolve(__dirname, '..', 'node_modules', '.bin', 'node-pg-migrate'),
  ['-m', 'migrations', 'up'],
  { stdio: ['inherit', 'pipe', 'pipe'], env: process.env }
);

// Passthrough stdout + capturar nombres de migrations aplicadas para incluir
// en el Sentry payload si demora. node-pg-migrate emite líneas como:
//   ### MIGRATION 20260712060000_canjes_soft_delete (UP) ###
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  const text = String(chunk);
  const re = /### MIGRATION\s+([\w-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    migrationsSeen.push(m[1]);
  }
});

// Filtrar stderr para eliminar los warnings inocuos de node-pg-migrate.
// Buffer partial-lines para manejar chunks que cortan en medio de una línea.
let stderrBuffer = '';
let filteredWarningsCount = 0;
const NOISE_PATTERNS = [
  // node-pg-migrate escanea migrations/*.js y warns por cada file cuyo
  // filename no matchea Unix timestamp o ISO. Nuestros filenames usan
  // formato YYYYMMDDhhmmss_name.js — inocuo, ordenamiento cronológico funciona.
  /^Can't determine timestamp for \d+/,
];
function isNoise(line) {
  return NOISE_PATTERNS.some((re) => re.test(line));
}
child.stderr.on('data', (chunk) => {
  stderrBuffer += String(chunk);
  const lines = stderrBuffer.split('\n');
  // La última entry puede ser una línea parcial (no termina en \n). La
  // dejamos en el buffer para procesarla cuando llegue el resto.
  stderrBuffer = lines.pop() || '';
  for (const line of lines) {
    if (isNoise(line)) {
      filteredWarningsCount += 1;
      continue;
    }
    process.stderr.write(line + '\n');
  }
});
// Al cerrar el process, flush cualquier partial-line que quede en el buffer.
child.stderr.on('end', () => {
  if (stderrBuffer && !isNoise(stderrBuffer)) {
    process.stderr.write(stderrBuffer);
  }
});

child.on('close', (code) => {
  const durationMs = Number((process.hrtime.bigint() - start) / 1000000n);
  const durationSec = durationMs / 1000;

  // Log estructurado para Railway logs / grep.
  const structured = {
    event: 'migrate_timed',
    duration_ms: durationMs,
    duration_sec: Number(durationSec.toFixed(2)),
    exit_code: code,
    migrations_applied: migrationsSeen.length,
    migration_names: migrationsSeen,
    filtered_stderr_warnings: filteredWarningsCount,
  };
  console.log(JSON.stringify(structured));

  if (code !== 0) {
    // Migrate falló — Sentry alert error + salir con el mismo code.
    reportSentry('error', `migrate failed with exit code ${code}`, structured);
    process.exit(code);
  }

  if (durationSec >= FATAL_SECONDS) {
    reportSentry('error',
      `migrate demoró ${durationSec.toFixed(1)}s (>= ${FATAL_SECONDS}s). ` +
      `Healthcheck a 300s va a fallar — deploy en riesgo.`,
      structured);
  } else if (durationSec >= WARN_SECONDS) {
    reportSentry('warning',
      `migrate demoró ${durationSec.toFixed(1)}s (>= ${WARN_SECONDS}s). ` +
      `Revisar qué migrations fueron pesadas.`,
      structured);
  }

  process.exit(0);
});

child.on('error', (err) => {
  // Spawn error (binario no existe, permisos, etc.).
  const durationMs = Number((process.hrtime.bigint() - start) / 1000000n);
  console.error(JSON.stringify({
    event: 'migrate_timed_spawn_error',
    duration_ms: durationMs,
    error: err.message,
  }));
  reportSentry('error', `migrate spawn error: ${err.message}`, {
    duration_ms: durationMs,
    error: err.message,
  });
  process.exit(1);
});

#!/usr/bin/env node
/**
 * backend-anti-regression-check.mjs — CI check anti-regression para patterns
 * peligrosos en el backend.
 *
 * Contexto (2026-07-24):
 *   Dos Sentry issues (TECNY-PORTAL-BACKEND-16 y #17) revelaron un pattern
 *   común: bugs latentes que sobrevivieron auditorías porque no había un
 *   grep automatizado que los detectara. Especificamente:
 *
 *     - #17: `redB2bEmail.js:74` tenía `SET LOCAL app.current_tenant =
 *       ${Number(tenantId)}` (string interpolation en SQL). Un tenantId
 *       garbage generaba `SET LOCAL app.current_tenant = NaN` → syntax
 *       error → conexión envenenada → "Connection terminated" al próximo
 *       consumer.
 *
 *       En el audit del 2026-07-12 (Plataforma P0-1) migramos `database.js`
 *       al pattern `set_config(..., $1::text, true)` con bind param, pero
 *       `redB2bEmail.js` quedó atrás — nadie lo notó hasta que Sentry lo
 *       cazó ~5 semanas después.
 *
 *   Este script previene la regresión: cualquier PR nuevo que introduzca
 *   el pattern `SET LOCAL app.current_tenant = ${...}` (interpolación
 *   directa) va a fallar CI. Los patterns seguros (bind param, o LOCAL
 *   sin variables) pasan.
 *
 * ── Uso ────────────────────────────────────────────────────────────────
 *
 *   node scripts/security/backend-anti-regression-check.mjs
 *     → escanea backend/src/ y sale con exit 0 si todo limpio, exit 1 si
 *     encuentra al menos un match. Imprime file:line:pattern.
 *
 *   Modo verbose (más contexto):
 *     node scripts/security/backend-anti-regression-check.mjs --verbose
 *
 * ── Patterns detectados ────────────────────────────────────────────────
 *
 * 1. SET_LOCAL_INTERPOLATION:
 *    Match: `SET LOCAL <var> = ${...}` en un template literal.
 *    Bug: string interpolation en SQL → SQL injection potencial +
 *    conexión envenenada si el input es garbage (Sentry #17).
 *    Fix: usar `set_config('<var>', $1::text, true)` con bind param.
 *
 * 2. EVAL_USAGE:
 *    Match: `eval(` o `new Function(` (excepto en tests).
 *    Bug: superficie RCE si el input viene del cliente. En el backend
 *    no debería haber uso legítimo.
 *
 * 3. RAW_STRING_CAST_INT_FROM_SETTING:
 *    Match: `current_setting('app.current_tenant'...)::int` sin NULLIF
 *    envolvente en el código backend (queries JS, no en pg_policies).
 *    Bug: si algún query dinámico usa este pattern y la GUC está vacía,
 *    revienta con pg_strtoint32_safe (Sentry #16 pero desde el código).
 *
 * ── Diseño ─────────────────────────────────────────────────────────────
 *
 * Sin dependencias externas (Node built-in fs + path). Corre en cualquier
 * runner Node 20+. No requiere npm install. Match line-by-line con regex.
 *
 * Cada pattern tiene su rationale explicado inline y una lista de
 * `ALLOWLIST` para excepciones documentadas (ej. comments que mencionan
 * el pattern pero no lo usan). Si tenés que agregar una excepción,
 * documentala en el PR body con la razón.
 *
 * Este archivo es análogo a `scripts/csp-inline-styles-check.mjs` pero
 * para el backend, y a `scripts/security/csp-invariants.test.js` (tests
 * de invariantes CSP). Juntos forman la línea de defensa "shift-left":
 * los patterns peligrosos se detectan en CI antes de deploy.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src');
const BASELINE_PATH = join(__dirname, 'backend-anti-regression-baseline.json');

const VERBOSE = process.argv.includes('--verbose');
const MODE = process.argv[2] === 'update' ? 'update' : 'check';

// ── Patterns ─────────────────────────────────────────────────────────────

const PATTERNS = [
  {
    name: 'SET_LOCAL_UNSAFE_INTERPOLATION',
    // Match: `SET LOCAL <algo> = ${...}` en línea (comentario o SQL) donde el
    // interpolado NO es exactamente `req.tenantId`.
    //
    // Rationale del allowlist de `${req.tenantId}` específicamente:
    //   El middleware `auth.js:132` valida `Number.isInteger(tenant_id) > 0`
    //   ANTES de setear `req.tenantId`. Cualquier request que llega a un
    //   endpoint tiene el shape garantizado — la interpolación es tan segura
    //   como un bind param. Migrar los ~100 sites a `set_config` sería
    //   ceremonia sin ganancia real (y agregaría 100 líneas de churn).
    //
    // Lo que SÍ queremos cazar (Sentry #17):
    //   - `${Number(tenantId)}`  → si `tenantId` viene de otro lado y no
    //     está guardado en middleware, `Number(garbage)` = NaN → SQL syntax
    //     error → connection poisoning.
    //   - `${tenantId}`          → variable arbitraria de un helper, no
    //     validada.
    //   - `${something.tenantId}` → propiedad de un objeto sin guard.
    //   - Cualquier variante que no sea literalmente `${req.tenantId}`.
    regex: /SET\s+LOCAL\s+[a-zA-Z_.]+\s*=\s*\$\{/i,
    rationale:
      'SQL injection + connection poisoning (Sentry TECNY-PORTAL-BACKEND-17). ' +
      'Solo `${req.tenantId}` está permitido (validado en middleware auth.js:132). ' +
      'Cualquier otra interpolación: usar `set_config(\'<var>\', $1::text, true)` ' +
      'con bind param, como redB2bEmail.js:87.',
    isAllowlisted: (line) => {
      const trimmed = line.trim();
      // Comments no ejecutan SQL.
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      ) return true;
      // Allowlist: exactamente `${req.tenantId}` — validado en middleware.
      // El regex es estricto: no matchea `${Number(req.tenantId)}` u otras
      // envolturas (que serían sospechosas — el guard de middleware ya
      // devuelve number, no hace falta re-wrappear).
      if (/SET\s+LOCAL\s+[a-zA-Z_.]+\s*=\s*\$\{\s*req\.tenantId\s*\}/i.test(line)) {
        return true;
      }
      return false;
    },
  },
  {
    name: 'EVAL_USAGE',
    // Match: eval( o new Function( — excepto en tests y scripts de dev.
    regex: /\b(eval\s*\(|new\s+Function\s*\()/,
    rationale:
      'eval() y new Function() son vector RCE. Ningún caso legítimo en el ' +
      'backend actual. Si necesitás ejecución dinámica: buscá alternativa ' +
      '(switch, lookup table, parser específico).',
    isAllowlisted: (line) => {
      const trimmed = line.trim();
      return (
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      );
    },
  },
  {
    name: 'RAW_STRING_CAST_INT_FROM_SETTING',
    // Match: `current_setting('app.current_tenant', true)::int` (sin NULLIF).
    // Usa negative lookbehind: current_setting( sin NULLIF( antes.
    regex: /(?<!NULLIF\s*\(\s*)current_setting\s*\(\s*'app\.current_tenant'\s*,\s*true\s*\)\s*::\s*int/i,
    rationale:
      'Cast \'\'::int throwea pg_strtoint32_safe si la GUC no está seteada ' +
      '(Sentry TECNY-PORTAL-BACKEND-16). Usar NULLIF(current_setting(...), \'\')::int ' +
      'o el helper PREDICATE_CLOSED de lib/rlsCanonical.js.',
    isAllowlisted: (line) => {
      const trimmed = line.trim();
      return (
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      );
    },
  },
];

// ── File walking ─────────────────────────────────────────────────────────

// Extensiones a escanear.
const EXTS = ['.js', '.mjs', '.cjs'];

// Directorios a excluir totalmente.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

// Archivos a excluir por sufijo (tests, mocks, etc.). En backend/src/ no
// deberían existir .test.js, pero por consistencia con otros checks.
const SKIP_FILE_PATTERNS = [
  /\.test\.[cm]?js$/,
  /\.spec\.[cm]?js$/,
];

function walkDir(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walkDir(full, out);
    } else if (EXTS.some((ext) => entry.endsWith(ext))) {
      if (SKIP_FILE_PATTERNS.some((re) => re.test(entry))) continue;
      out.push(full);
    }
  }
  return out;
}

// ── Scanning ─────────────────────────────────────────────────────────────

function scanFile(path) {
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) {
        if (pattern.isAllowlisted && pattern.isAllowlisted(line)) continue;
        hits.push({
          pattern: pattern.name,
          rationale: pattern.rationale,
          line: i + 1,
          text: line.trim(),
        });
      }
    }
  }
  return hits;
}

// ── Baseline comparison ──────────────────────────────────────────────────

function loadBaseline() {
  try {
    const raw = readFileSync(BASELINE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const files = walkDir(BACKEND_SRC);
  if (VERBOSE) {
    console.log(`[backend-anti-regression] scanning ${files.length} files under backend/src/`);
  }

  // countsByPattern[patternName][relFile] = count
  const countsByPattern = {};
  const hitsByPattern = {}; // para logging detallado
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    const hits = scanFile(file);
    for (const hit of hits) {
      countsByPattern[hit.pattern] ||= {};
      countsByPattern[hit.pattern][rel] = (countsByPattern[hit.pattern][rel] || 0) + 1;
      hitsByPattern[hit.pattern] ||= [];
      hitsByPattern[hit.pattern].push({ file: rel, ...hit });
    }
  }

  if (MODE === 'update') {
    // Reescribir baseline con counts actuales. Preservar _meta si existe.
    const existing = loadBaseline();
    const meta = existing._meta || {
      generated_at: new Date().toISOString().slice(0, 10),
      generated_by: 'scripts/security/backend-anti-regression-check.mjs update',
      purpose: 'Baseline generado automáticamente. Ver script para contexto.',
    };
    // Regenerar timestamp.
    meta.generated_at = new Date().toISOString().slice(0, 10);
    const out = { _meta: meta, ...countsByPattern };
    writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + '\n');
    console.log(`[backend-anti-regression] baseline actualizado en ${relative(REPO_ROOT, BASELINE_PATH)}`);
    for (const [pat, files] of Object.entries(countsByPattern)) {
      const total = Object.values(files).reduce((a, b) => a + b, 0);
      console.log(`  ${pat}: ${total} matches en ${Object.keys(files).length} archivos`);
    }
    process.exit(0);
  }

  // MODE === 'check' — comparar contra baseline.
  const baseline = loadBaseline();
  const regressions = [];
  const patternsWithMatches = new Set([
    ...Object.keys(countsByPattern),
    ...Object.keys(baseline).filter((k) => !k.startsWith('_')),
  ]);

  for (const pat of patternsWithMatches) {
    const current = countsByPattern[pat] || {};
    const baseFiles = baseline[pat] || {};
    // Check regresiones: cualquier archivo donde current > baseline.
    for (const [file, count] of Object.entries(current)) {
      const baseCount = baseFiles[file] || 0;
      if (count > baseCount) {
        regressions.push({
          pattern: pat,
          file,
          baseline: baseCount,
          current: count,
          delta: count - baseCount,
        });
      }
    }
    // Check archivos NUEVOS que aparecen en current sin estar en baseline.
    // (Ya cubierto por el loop de arriba — baseCount será 0.)
  }

  // Log reducción bienvenida (archivos donde bajaste el count).
  const improvements = [];
  for (const pat of patternsWithMatches) {
    const current = countsByPattern[pat] || {};
    const baseFiles = baseline[pat] || {};
    for (const [file, baseCount] of Object.entries(baseFiles)) {
      const curCount = current[file] || 0;
      if (curCount < baseCount) {
        improvements.push({ pattern: pat, file, baseline: baseCount, current: curCount });
      }
    }
  }

  if (improvements.length > 0) {
    console.log('[backend-anti-regression] mejoras detectadas (baseline puede bajar):');
    for (const imp of improvements) {
      console.log(`  ${imp.file}: ${imp.pattern} ${imp.baseline} → ${imp.current}`);
    }
    console.log(
      '  → correr `node scripts/security/backend-anti-regression-check.mjs update` ' +
      'para actualizar baseline y consolidar la mejora.\n'
    );
  }

  if (regressions.length === 0) {
    const totalMatches = Object.values(countsByPattern).reduce(
      (acc, files) => acc + Object.values(files).reduce((a, b) => a + b, 0),
      0
    );
    console.log(
      `[backend-anti-regression] ✓ OK — sin regresiones. ` +
      `${totalMatches} match(es) legacy dentro del baseline.`
    );
    process.exit(0);
  }

  // Regresión detectada — fallar CI.
  console.error(`[backend-anti-regression] ✗ REGRESIÓN detectada — ${regressions.length} caso(s):\n`);
  for (const reg of regressions) {
    console.error(`─── ${reg.pattern} ───`);
    console.error(`  ${reg.file}: baseline=${reg.baseline}, actual=${reg.current} (+${reg.delta})`);
    // Mostrar los hits específicos que superan el baseline.
    const hits = (hitsByPattern[reg.pattern] || []).filter((h) => h.file === reg.file);
    for (const hit of hits) {
      console.error(`    L${hit.line}: ${hit.text}`);
    }
    console.error(`  Rationale: ${(hitsByPattern[reg.pattern]?.[0]?.rationale) || 'n/a'}\n`);
  }

  console.error(
    'El baseline en scripts/security/backend-anti-regression-baseline.json ' +
    'documenta los casos legacy aceptados. Este PR agrega casos nuevos.\n\n' +
    'Opciones:\n' +
    '  1. Fixear el/los caso(s) nuevo(s) usando `set_config(<var>, $1::text, true)` ' +
    'con bind param (ver backend/src/lib/redB2bEmail.js:87 como referencia).\n' +
    '  2. Si el pattern es intencional y seguro (raro): actualizar baseline con\n' +
    '     `node scripts/security/backend-anti-regression-check.mjs update`\n' +
    '     y justificar en el PR body por qué es aceptable.\n'
  );

  process.exit(1);
}

main();

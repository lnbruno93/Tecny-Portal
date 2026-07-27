#!/usr/bin/env node
/**
 * refactor-set-local-to-set-config.mjs — one-shot script.
 *
 * Migra el pattern legacy:
 *   await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
 *
 * a la forma canónica con bind param:
 *   await client.query(
 *     `SELECT set_config('app.current_tenant', $1::text, true)`,
 *     [String(req.tenantId)]
 *   );
 *
 * Contexto:
 *   - Sentry #17 (audit 07-24) fue causada por interpolación NO validada en
 *     redB2bEmail.js. El middleware `auth.js` YA valida `req.tenantId` como
 *     INT positivo, así que técnicamente la interpolación es segura hoy.
 *     Pero:
 *       1. Silent breakage risk: cualquier code path que llegue con
 *          `tenantId` no validado (nueva branch, refactor) recrea la vuln.
 *       2. Pattern inconsistente: ~30 sitios ya usan set_config (canónico),
 *          72 usan SET LOCAL (legacy). Consolidar.
 *       3. Menor overhead de mental model: bind params son la única forma
 *          "correcta" en toda la codebase.
 *
 * Este script:
 *   1. Escanea `backend/src/**\/*.js` buscando el pattern legacy en una sola línea.
 *   2. Reemplaza la línea COMPLETA por el bloque canónico multi-línea,
 *      preservando la indentación.
 *   3. Reporta cuántos archivos + cuántas ocurrencias mutó.
 *
 * Uso:
 *   node scripts/refactor-set-local-to-set-config.mjs [--dry-run]
 *
 * Con `--dry-run` no escribe, solo lista los cambios.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src');
const DRY_RUN = process.argv.includes('--dry-run');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'tests']);

function walkDir(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walkDir(full, out);
    } else if (entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// Matchea:
//   <indent>await client.query(`SET LOCAL app.current_tenant = ${<var>}`);
// Grupos:
//   1: leading whitespace
//   2: la expresión que va dentro de ${...} (típico: req.tenantId)
const PATTERN = /^(\s*)await client\.query\(`SET LOCAL app\.current_tenant = \$\{([^}]+)\}`\);\s*$/;

function replaceLine(line) {
  const m = line.match(PATTERN);
  if (!m) return null;
  const indent = m[1];
  const expr = m[2].trim();
  // Producimos 4 líneas con la indentación original preservada.
  // Nota: el `String(expr)` es una salvaguarda defensiva — si el `expr`
  // ya es string, es no-op; si viene numérico, `set_config` requiere
  // text-typed y $1::text lo castea igual, pero `String(...)` en JS
  // asegura consistencia con el resto del codebase que ya usa ese pattern.
  return [
    `${indent}await client.query(`,
    `${indent}  \`SELECT set_config('app.current_tenant', $1::text, true)\`,`,
    `${indent}  [String(${expr})]`,
    `${indent});`,
  ].join('\n');
}

function processFile(file) {
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const out = [];
  let count = 0;

  for (const line of lines) {
    const replaced = replaceLine(line);
    if (replaced != null) {
      out.push(replaced);
      count += 1;
    } else {
      out.push(line);
    }
  }

  if (count === 0) return { count: 0 };

  const newContent = out.join('\n');
  if (!DRY_RUN) writeFileSync(file, newContent);
  return { count };
}

function main() {
  const files = walkDir(BACKEND_SRC);
  let totalFiles = 0;
  let totalOccurrences = 0;

  console.log(`[refactor-set-local] modo: ${DRY_RUN ? 'DRY-RUN (no escribe)' : 'APPLY'}`);
  console.log('');

  for (const file of files) {
    const { count } = processFile(file);
    if (count > 0) {
      const rel = relative(REPO_ROOT, file);
      console.log(`  ${rel}: ${count} occurrence${count === 1 ? '' : 's'}`);
      totalFiles += 1;
      totalOccurrences += count;
    }
  }

  console.log('');
  console.log(`[refactor-set-local] ${totalOccurrences} occurrences across ${totalFiles} files`);
  if (DRY_RUN && totalOccurrences > 0) {
    console.log('[refactor-set-local] re-run without --dry-run to apply');
  }
}

main();

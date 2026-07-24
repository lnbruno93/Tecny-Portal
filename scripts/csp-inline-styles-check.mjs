#!/usr/bin/env node
/**
 * csp-inline-styles-check.mjs — CI check anti-regression para inline styles.
 *
 * Contexto (Rec #6, 2026-07-20):
 *   El CSP actual (netlify.toml) tiene `style-src 'self' 'unsafe-inline' ...`.
 *   Idealmente sacaríamos `'unsafe-inline'` — pero hoy hay ~3500 inline
 *   `style={}` attrs distribuidos entre frontend/, admin-frontend/, y la
 *   landing (frontend/src/screens/Landing.jsx). Migrarlos todos son semanas.
 *
 * Este script es la Fase 1 del plan CSP tightening: en vez de migrar todo
 * upfront, congelamos el count actual como baseline y prevenimos que suba
 * (anti-regression). Fase 2 (semanas, futuro) migra los existentes en
 * batches manageable. Cuando el count llegue a 0, remover `'unsafe-inline'`
 * del CSP se vuelve factible.
 *
 * ── Uso ────────────────────────────────────────────────────────────────
 *
 *   node scripts/csp-inline-styles-check.mjs count
 *     → imprime el count actual por workspace (sin cambiar nada)
 *
 *   node scripts/csp-inline-styles-check.mjs check
 *     → compara contra baseline. Exit 0 si count <= baseline, exit 1 sino.
 *     Este es el modo usado en CI.
 *
 *   node scripts/csp-inline-styles-check.mjs update
 *     → sobrescribe el baseline con el count actual. Uso: cuando un PR
 *     intencional REDUCE inline styles (bienvenido) o los aumenta con
 *     razón (comment explicito en el PR). El PR incluye el JSON actualizado
 *     en el mismo commit.
 *
 * ── Detección ──────────────────────────────────────────────────────────
 *
 * Solo cuenta `style={...}` en JSX/TSX (attribute JSX). NO cuenta:
 *   · `style: {...}` en objetos JS puros (no aplica a DOM)
 *   · `<style>` tags con contenido (esto SÍ afecta CSP pero es tan raro
 *      en este repo que un match manual no vale — grep separado si aparece)
 *   · CSS-in-JS libraries (styled-components, emotion) — no las usamos
 *
 * Tolerance: el check es EXACTO. Si intentás mergear un PR con +1 style
 * inline nuevo, falla. Para pasar: (a) evitar el inline (usar className)
 * o (b) actualizar baseline con justificación en el PR body.
 *
 * ── Diseño ─────────────────────────────────────────────────────────────
 *
 * Sin dependencias externas (Node built-in fs + path). Corre en cualquier
 * runner Node 20+. No requiere npm install. Match line-by-line (regex
 * simple) es suficiente — no necesitamos un parser AST completo.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const BASELINE_PATH = join(__dirname, 'csp-inline-styles-baseline.json');

// Workspaces a escanear. Cada uno tiene su propio count independiente para
// que el baseline sea legible y una regresión en admin no oculte progreso
// en frontend.
const WORKSPACES = [
  { name: 'frontend',        root: 'frontend/src'        },
  { name: 'admin-frontend',  root: 'admin-frontend/src'  },
];

// Extensiones que pueden contener JSX. Excluimos .test/.spec por design:
// tests suelen tener styles inline "throwaway" que no afectan el CSP real
// (nunca llegan al bundle final). Si querés incluirlos, quitá el filter
// abajo — el count subiría en ~500 pero la señal de regresión seguiría
// funcionando.
const JSX_EXTS = ['.jsx', '.tsx'];

// Regexes: matcheamos DOS patterns que ambos violan `style-src 'unsafe-inline'`:
//   1. `style={...}` attribute JSX — inline style attr en un DOM element.
//   2. `<style>` tag JSX — inline stylesheet block.
//
// Sprint 104 (2026-07-24) agregó el 2do — hasta entonces solo trackeábamos
// attributes. Los `<style>` blocks son igual de graves para CSP: cualquier
// contenido dinámico (template literal con variables) es un XSS injection
// vector si esas variables incluyen user input sin sanitizar. Migrados los
// 4 blocks que existían (PublicoUsados x3 + PorCategoriaBreakdownModal x1)
// a stylesheets externos o clases utility con variants.
//
// Ambos regexes cuentan hacia el mismo total — el anti-regression check
// cubre las 2 categorías con una sola métrica.
const STYLE_ATTR_RE  = /\bstyle\s*=\s*\{/g;
const STYLE_BLOCK_RE = /<style[\s>]/g;

function walkDir(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      // Skip node_modules, build outputs, coverage.
      if (entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === 'coverage') {
        continue;
      }
      walkDir(full, out);
    } else if (JSX_EXTS.some((ext) => entry.endsWith(ext))) {
      // Skip test files — ver comment arriba.
      if (entry.includes('.test.') || entry.includes('.spec.')) continue;
      out.push(full);
    }
  }
  return out;
}

function countInFile(path) {
  const content = readFileSync(path, 'utf8');
  const attrMatches  = content.match(STYLE_ATTR_RE)  || [];
  const blockMatches = content.match(STYLE_BLOCK_RE) || [];
  return attrMatches.length + blockMatches.length;
}

function countWorkspace(workspace) {
  const root = join(REPO_ROOT, workspace.root);
  const files = walkDir(root);
  let total = 0;
  const perFile = [];
  for (const file of files) {
    const n = countInFile(file);
    if (n > 0) {
      total += n;
      perFile.push({ file: relative(REPO_ROOT, file), count: n });
    }
  }
  perFile.sort((a, b) => b.count - a.count);
  return { total, filesWithStyles: perFile.length, topFiles: perFile.slice(0, 10) };
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return { workspaces: {} };
  }
}

function saveBaseline(data) {
  writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n');
}

// ── Commands ───────────────────────────────────────────────────────────

function cmdCount() {
  console.log('CSP inline styles count por workspace:');
  console.log('');
  for (const ws of WORKSPACES) {
    const res = countWorkspace(ws);
    console.log(`  ${ws.name.padEnd(20)} ${String(res.total).padStart(6)} matches en ${res.filesWithStyles} archivos`);
    console.log(`  ${''.padEnd(20)} top 5:`);
    for (const f of res.topFiles.slice(0, 5)) {
      console.log(`  ${''.padEnd(22)} ${String(f.count).padStart(4)}  ${f.file}`);
    }
    console.log('');
  }
}

function cmdCheck() {
  const baseline = loadBaseline();
  let failed = false;
  console.log('CSP inline styles anti-regression check:');
  console.log('');
  for (const ws of WORKSPACES) {
    const res = countWorkspace(ws);
    const base = baseline.workspaces[ws.name] || 0;
    const delta = res.total - base;
    const status = delta <= 0 ? '✓' : '✗';
    const arrow = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '0';
    console.log(`  ${status} ${ws.name.padEnd(20)} ${String(res.total).padStart(6)} / baseline ${String(base).padStart(6)}  (${arrow})`);
    if (delta > 0) {
      failed = true;
      console.log('');
      console.log(`    ✗ ${ws.name}: +${delta} inline styles nuevos vs baseline.`);
      console.log('      Top archivos con más matches (para investigar dónde):');
      for (const f of res.topFiles.slice(0, 5)) {
        console.log(`        ${String(f.count).padStart(4)}  ${f.file}`);
      }
      console.log('');
      console.log('    Opciones para desbloquear el PR:');
      console.log('      1. Migrar el/los nuevos inline styles a una clase CSS (recomendado).');
      console.log('      2. Si el aumento es intencional y justificado (ej. componente nuevo');
      console.log('         que replaza uno más grande — net negativo eventual), actualizá');
      console.log('         el baseline con: `node scripts/csp-inline-styles-check.mjs update`');
      console.log('         Incluí el JSON actualizado en el mismo commit + explicación en el PR.');
      console.log('');
    }
  }

  if (failed) {
    console.log('');
    console.log('CSP anti-regression check FAILED.');
    console.log('');
    console.log('Contexto: Rec #6 audit 2026-07-20. El baseline congela el nivel actual de');
    console.log('inline styles para prevenir que suba. Fase 2 (futuro) migra los existentes');
    console.log('en batches; cuando llegue a 0, se remueve `unsafe-inline` del CSP.');
    console.log('Ver docs/CSP.md para detalles.');
    process.exit(1);
  }

  console.log('');
  console.log('✓ Todos los workspaces dentro del baseline.');
  process.exit(0);
}

function cmdUpdate() {
  const baseline = loadBaseline();
  console.log('Actualizando baseline con los counts actuales:');
  console.log('');
  for (const ws of WORKSPACES) {
    const res = countWorkspace(ws);
    const prev = baseline.workspaces[ws.name] || 0;
    baseline.workspaces[ws.name] = res.total;
    const delta = res.total - prev;
    const arrow = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '0';
    console.log(`  ${ws.name.padEnd(20)} ${String(prev).padStart(6)} → ${String(res.total).padStart(6)}  (${arrow})`);
  }
  baseline.updated_at = new Date().toISOString();
  saveBaseline(baseline);
  console.log('');
  console.log(`Baseline actualizado en: ${relative(REPO_ROOT, BASELINE_PATH)}`);
  console.log('Recordá incluir el JSON en el commit + explicar el cambio en el PR body.');
}

// ── Entry ──────────────────────────────────────────────────────────────

const cmd = process.argv[2];

if (cmd === 'count')       cmdCount();
else if (cmd === 'check')  cmdCheck();
else if (cmd === 'update') cmdUpdate();
else {
  console.error('Uso: node scripts/csp-inline-styles-check.mjs <count|check|update>');
  console.error('');
  console.error('  count   Imprime el count actual (no modifica nada).');
  console.error('  check   Compara vs baseline. Exit 1 si aumentó. Usado en CI.');
  console.error('  update  Sobrescribe el baseline con el count actual.');
  process.exit(2);
}

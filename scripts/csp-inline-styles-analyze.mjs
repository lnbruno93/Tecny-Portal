#!/usr/bin/env node
/**
 * csp-inline-styles-analyze.mjs — análisis de patterns para planificar Fase 2.
 *
 * Contexto (Rec #6 CSP tightening, 2026-07-20):
 *   El baseline de Fase 1 (ver `csp-inline-styles-check.mjs`) congela 3544
 *   inline styles. Migrarlos 1 archivo por PR es lento (~1h/file). Este
 *   script identifica patterns REPETIDOS cross-file para decidir si vale
 *   la pena crear componentes primitivos (`<Stack>`, `<Row>`, `<Center>`)
 *   que absorben los patterns más comunes.
 *
 * ── Uso ────────────────────────────────────────────────────────────────
 *
 *   node scripts/csp-inline-styles-analyze.mjs
 *     → imprime:
 *       · Top 20 patterns COMPLETOS (objeto entero) más repetidos.
 *       · Top 20 propiedades INDIVIDUALES más frecuentes.
 *       · Recomendaciones de primitivos si hay patterns claros (>15 hits).
 *
 * ── Método ─────────────────────────────────────────────────────────────
 *
 * Regex-based (sin AST). Match `style={{ ... }}` con balanceo simple de
 * braces. Parse las propiedades key:value dentro. Skip cualquier bloque
 * que contenga expression interpolation (`${...}` o `?:` o `||`) porque
 * esos son styles dinámicos que NO se pueden convertir a CSS class.
 *
 * Coverage esperado: ~40-60% de los styles son estáticos (analizables).
 * El resto son dinámicos y quedan como inline forever (o migran a CSS
 * custom properties, fuera de scope).
 *
 * ── Diseño output ──────────────────────────────────────────────────────
 *
 * Patterns se serializan con las props ORDENADAS alfabéticamente. Esto
 * agrupa `{ color: 'red', padding: 8 }` con `{ padding: 8, color: 'red' }`
 * como el mismo pattern — normalmente los devs los escriben en orden
 * distinto pero semánticamente son iguales.
 *
 * Los valores se preservan como string literal (no se normalizan colors
 * hex vs named, ni unidades). Trade-off: patterns con `padding: 8` vs
 * `padding: '8px'` se cuentan separados. Aceptable — casi todo el codebase
 * usa numeric (Vite convierte a px automáticamente).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const WORKSPACES = [
  { name: 'frontend',       root: 'frontend/src'       },
  { name: 'admin-frontend', root: 'admin-frontend/src' },
];

const JSX_EXTS = ['.jsx', '.tsx'];

function walkDir(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (['node_modules', 'dist', 'build', 'coverage'].includes(entry)) continue;
      walkDir(full, out);
    } else if (JSX_EXTS.some((ext) => entry.endsWith(ext))) {
      if (entry.includes('.test.') || entry.includes('.spec.')) continue;
      out.push(full);
    }
  }
  return out;
}

// Match `style={{ ... }}` con balanceo simple. El outer `{{` marca el
// inicio; contamos aperturas/cierres hasta encontrar el matching close.
// Retorna el CONTENIDO del objeto (entre `{{` y `}}`), no el objeto entero.
function extractStyleBlocks(content) {
  const blocks = [];
  const re = /\bstyle\s*=\s*\{\{/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const start = match.index + match[0].length;
    // Balance braces: partimos con depth=1 (ya consumimos `{{`, el outer
    // JSX `{` cerrará afuera del bloque de objeto). Buscamos el `}` que
    // cierra el objeto interno.
    let depth = 1;
    let i = start;
    while (i < content.length && depth > 0) {
      const c = content[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    if (depth === 0) {
      // content[i-1] es el `}` de cierre del objeto. Sumamos el text hasta i-1.
      blocks.push(content.slice(start, i - 1).trim());
    }
  }
  return blocks;
}

// Parse un bloque como `{ padding: 8, color: 'var(--text)' }` a un map
// {padding: '8', color: "'var(--text)'"}. Best-effort:
//   · Skip bloques con `${` (template literal dynamic).
//   · Skip bloques con `?:` en el valor (conditional).
//   · Skip bloques con `||` o `??` en el valor.
//   · Skip bloques que contienen funciones (`() =>`).
// Retorna null si el bloque no es analizable (dinámico).
function parseStyleObject(block) {
  if (block.includes('${')) return null;
  if (block.includes('=>')) return null;
  if (/[?:]\s*\S/.test(block) && !block.match(/^[a-zA-Z-]+:/)) return null;
  if (block.includes('||') || block.includes('??')) return null;

  const props = {};
  // Split por comas fuera de parens/braces/quotes. Simplificamos con
  // regex por comas seguidas de word: pattern. Perfect no será, pero
  // cubrimos el 90% del código real.
  //
  // Sanity: reemplazamos comas dentro de () o [] o "" o '' con placeholder
  // temporal para hacer el split seguro.
  let safe = '';
  let depth = 0;
  let inStr = null;
  for (const c of block) {
    if (inStr) {
      if (c === inStr && safe[safe.length - 1] !== '\\') inStr = null;
      safe += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; safe += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) safe += ''; // sentinel
    else safe += c;
  }

  const parts = safe.split('').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    // key: value. Key puede ser identifier, 'identifier', o "identifier".
    const m = part.match(/^\s*(?:['"]?)([a-zA-Z][a-zA-Z0-9_-]*)(?:['"]?)\s*:\s*(.+?)\s*$/);
    if (!m) return null; // No parseable
    const key = m[1];
    const value = m[2];
    // Si el value contiene otra property (nested object), skip.
    if (value.includes(':') && !value.startsWith("'") && !value.startsWith('"') && !value.startsWith('var(')) {
      return null;
    }
    props[key] = value;
  }
  return props;
}

// Serializa el objeto a canonical form (keys ordenadas alfabético).
function canonicalize(obj) {
  return Object.keys(obj).sort().map((k) => `${k}: ${obj[k]}`).join(', ');
}

function suggestPrimitiveFor(canonical) {
  const s = canonical;
  // Patterns simples que sugieren primitivos comunes.
  if (s === 'display: flex, flexDirection: column, gap: 8') return '<Stack gap="sm">';
  if (s === 'display: flex, flexDirection: column, gap: 12') return '<Stack gap="md">';
  if (s === 'display: flex, flexDirection: column, gap: 16') return '<Stack gap="lg">';
  if (s === 'alignItems: center, display: flex, gap: 8') return '<Row gap="sm">';
  if (s === 'alignItems: center, display: flex, gap: 12') return '<Row gap="md">';
  if (s === 'display: grid, placeItems: center') return '<Center>';
  if (s.match(/^color: var\(--text[a-z-]*\), fontSize: \d+$/)) return '<Text muted>';
  if (s.match(/^color: var\(--neg\), fontSize: \d+$/)) return '<Text error>';
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────

const allBlocks = [];
let totalStyles = 0;
let dynamicSkipped = 0;

for (const ws of WORKSPACES) {
  const root = join(REPO_ROOT, ws.root);
  const files = walkDir(root);
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const blocks = extractStyleBlocks(content);
    for (const block of blocks) {
      totalStyles++;
      const parsed = parseStyleObject(block);
      if (parsed === null) {
        dynamicSkipped++;
      } else {
        allBlocks.push({
          file: relative(REPO_ROOT, file),
          canonical: canonicalize(parsed),
          props: Object.keys(parsed),
        });
      }
    }
  }
}

const pctAnalyzable = ((allBlocks.length / totalStyles) * 100).toFixed(1);
console.log(`Análisis de inline styles — ${totalStyles} total, ${allBlocks.length} analizables (${pctAnalyzable}%), ${dynamicSkipped} dinámicos.\n`);

// ── Top patterns completos ─────────────────────────────────────────────

const patternCount = new Map();
const patternFiles = new Map(); // pattern → Set de files
for (const b of allBlocks) {
  patternCount.set(b.canonical, (patternCount.get(b.canonical) || 0) + 1);
  if (!patternFiles.has(b.canonical)) patternFiles.set(b.canonical, new Set());
  patternFiles.get(b.canonical).add(b.file);
}

const sortedPatterns = [...patternCount.entries()].sort((a, b) => b[1] - a[1]);
const topPatterns = sortedPatterns.slice(0, 20);

console.log('══ Top 20 patterns completos (objeto entero repetido) ══\n');
for (const [pat, count] of topPatterns) {
  const files = patternFiles.get(pat).size;
  const suggestion = suggestPrimitiveFor(pat);
  const suggestionStr = suggestion ? `  → sugerencia: ${suggestion}` : '';
  console.log(`  ${String(count).padStart(4)}×  (${files} archivos)  { ${pat} }${suggestionStr}`);
}
console.log('');

// ── Top propiedades individuales ───────────────────────────────────────

const propCount = new Map();
for (const b of allBlocks) {
  for (const p of b.props) {
    propCount.set(p, (propCount.get(p) || 0) + 1);
  }
}

const sortedProps = [...propCount.entries()].sort((a, b) => b[1] - a[1]);
const topProps = sortedProps.slice(0, 15);

console.log('══ Top 15 propiedades individuales (frecuencia) ══\n');
for (const [prop, count] of topProps) {
  console.log(`  ${String(count).padStart(5)}×  ${prop}`);
}
console.log('');

// ── Recomendaciones ────────────────────────────────────────────────────

const highValuePatterns = sortedPatterns.filter(([_, c]) => c >= 15);
console.log('══ Recomendaciones de primitivos ══\n');
if (highValuePatterns.length === 0) {
  console.log('  Sin patterns claros (≥15 hits). Cada inline style es en gran parte único —');
  console.log('  no vale la pena crear primitivos por ahora. Migrar archivo por archivo.');
} else {
  console.log(`  ${highValuePatterns.length} patterns con ≥15 hits — vale primitivos:\n`);
  let totalHitsByPrimitives = 0;
  for (const [pat, count] of highValuePatterns) {
    totalHitsByPrimitives += count;
    const suggestion = suggestPrimitiveFor(pat);
    const suggestionStr = suggestion ? ` → ${suggestion}` : ' (sin sugerencia auto — evaluar)';
    console.log(`    ${String(count).padStart(4)}×  { ${pat.slice(0, 80)}${pat.length > 80 ? '...' : ''} }${suggestionStr}`);
  }
  const pctOfAnalyzable = ((totalHitsByPrimitives / allBlocks.length) * 100).toFixed(1);
  const pctOfTotal = ((totalHitsByPrimitives / totalStyles) * 100).toFixed(1);
  console.log(`\n  Con estos primitivos migrarías ${totalHitsByPrimitives} styles = ${pctOfAnalyzable}% de analizables, ${pctOfTotal}% del total.`);
}

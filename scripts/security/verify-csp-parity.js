#!/usr/bin/env node
/**
 * scripts/security/verify-csp-parity.js — asserta paridad de CSP entre los 2
 * netlify.toml (portal + admin) y los 3 contextos (production, branch-deploy,
 * deploy-preview).
 *
 * Sprint 3 L1 del roadmap post-auditoría. Ver csp-spec.js para el contexto
 * completo del problema (bug del 2026-07-19).
 *
 * ── Cómo corre ────────────────────────────────────────────────────────
 *
 *   $ node scripts/security/verify-csp-parity.js
 *
 * Exit 0 → todo alineado con `csp-spec.js`.
 * Exit 1 → hay drift; el output muestra por site + context qué directivas
 *          divergen (agregadas, faltantes, tokens fuera de orden).
 *
 * ── Integración CI ────────────────────────────────────────────────────
 *
 *   .github/workflows/ci.yml → job `csp-parity` (~2s, sin services).
 *
 * ── Diseño del parser ─────────────────────────────────────────────────
 *
 * No usamos librería TOML full: el header CSP tiene un shape fijo y estable
 * (una línea `Content-Security-Policy = "..."` dentro de un block
 * `[[headers]]` o `[[context.X.headers]]`). Barremos línea a línea llevando
 * el context actual como state. Es más simple que agregar dependency de
 * @iarna/toml y suficientemente robusto para nuestro uso (los 2 files
 * tienen shape controlada por nosotros).
 */

const fs = require('fs');
const path = require('path');
const {
  REQUIRED_CONTEXTS,
  SITES,
  expectedCspFor,
} = require('./csp-spec');

const REPO_ROOT = path.resolve(__dirname, '../..');

// ── Parser ─────────────────────────────────────────────────────────────

/**
 * Descubre si un TOML block header CAMBIA el context, lo PRESERVA (es una
 * subsección del block actual) o RESETEA (block no relacionado a headers).
 *
 *   [[headers]]                              → set 'production'
 *   [[context.branch-deploy.headers]]        → set 'branch-deploy'
 *   [[context.deploy-preview.headers]]       → set 'deploy-preview'
 *   [headers.values]                         → keep (subsección del [[headers]] previo)
 *   [context.branch-deploy.headers.values]   → keep (subsección del context block)
 *   [build] / [[redirects]] / [build.environment] / etc. → reset a null
 *
 * Devuelve:
 *   { action: 'set',   context: 'production' | 'branch-deploy' | ... }
 *   { action: 'keep'  }   ← preservar el context previo
 *   { action: 'reset' }   ← salir del scope de un CSP block
 */
function classifyBlockHeader(header) {
  if (header === '[[headers]]') return { action: 'set', context: 'production' };
  const arrayMatch = header.match(/^\[\[context\.([\w-]+)\.headers\]\]$/);
  if (arrayMatch) return { action: 'set', context: arrayMatch[1] };
  // Subsecciones .values del block actual — preservan el context.
  if (header === '[headers.values]') return { action: 'keep' };
  if (/^\[context\.[\w-]+\.headers\.values\]$/.test(header)) return { action: 'keep' };
  // Cualquier otro top-level block resetea.
  return { action: 'reset' };
}

/**
 * Parsea un value CSP como string ("default-src 'self'; script-src ...; ...")
 * a un map { directive: [tokens] }.
 *
 * Tolera espacios múltiples y trailing semicolon. Ignora directivas vacías.
 * Preserva el ORDEN de aparición de los tokens para que el diff sea claro
 * si alguien reordena manualmente (no es semánticamente incorrecto pero
 * queremos consistencia).
 */
function parseCspHeaderValue(value) {
  const map = {};
  for (const rawDirective of value.split(';')) {
    const directive = rawDirective.trim();
    if (!directive) continue;
    const parts = directive.split(/\s+/);
    const name = parts[0];
    const tokens = parts.slice(1);
    map[name] = tokens;
  }
  return map;
}

/**
 * Parsea un netlify.toml y devuelve { context: cspDirectiveMap } para cada
 * context que tenga un CSP header definido.
 *
 * Contract: cada context requerido en REQUIRED_CONTEXTS debe aparecer con
 * su CSP; el verify() de abajo asserta esa exhaustividad.
 */
function parseNetlifyToml(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8');
  const lines = contents.split('\n');
  const byContext = {};

  // context actual — cambia cuando cruzamos un block header `[[...]]`.
  // null = fuera de un block [[headers]] o context.X.headers.
  let currentContext = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Salta comentarios y líneas vacías — no rompen tracking del context.
    if (!line || line.startsWith('#')) continue;

    // ¿Empezó un block nuevo? Clasificar: set nuevo context, keep (subsección),
    // o reset (salimos del scope de headers).
    if (line.startsWith('[')) {
      const result = classifyBlockHeader(line);
      if (result.action === 'set') currentContext = result.context;
      else if (result.action === 'reset') currentContext = null;
      // 'keep' → no cambia currentContext.
      continue;
    }

    // Solo captamos CSP mientras estemos dentro de un block relevante.
    if (currentContext === null) continue;

    // El header CSP es una línea `Content-Security-Policy = "..."`. Tolera
    // capitalización estándar; no debería aparecer en minúsculas pero por
    // las dudas usamos case-insensitive en el nombre.
    const m = line.match(/^Content-Security-Policy\s*=\s*"([^"]+)"$/i);
    if (m) {
      byContext[currentContext] = parseCspHeaderValue(m[1]);
    }
  }

  return byContext;
}

// ── Verifier ───────────────────────────────────────────────────────────

/**
 * Compara dos directive maps (actual vs expected) y devuelve una lista de
 * discrepancias human-readable. Vacía si son iguales.
 */
function diffCspMaps(actual, expected) {
  const problems = [];
  const actualKeys = new Set(Object.keys(actual));
  const expectedKeys = new Set(Object.keys(expected));

  // Directivas de MÁS: aparecen en el TOML pero no en el spec.
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) {
      problems.push(`  ✗ directiva no esperada por el spec: "${key}" con tokens ${JSON.stringify(actual[key])}`);
    }
  }

  // Directivas de MENOS: en el spec pero faltan en el TOML.
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) {
      problems.push(`  ✗ directiva faltante: "${key}" — se esperaba ${JSON.stringify(expected[key])}`);
    }
  }

  // Directivas presentes en ambos: comparar tokens (misma cantidad + mismo orden).
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) continue; // ya reportado
    const a = actual[key];
    const e = expected[key];
    if (a.length !== e.length || a.some((t, i) => t !== e[i])) {
      problems.push(
        `  ✗ directiva "${key}" difiere:\n` +
        `      actual:   ${JSON.stringify(a)}\n` +
        `      esperado: ${JSON.stringify(e)}`
      );
    }
  }

  return problems;
}

function main() {
  let anyFailure = false;

  console.log('=== CSP parity check ===');
  console.log('Spec canónica: scripts/security/csp-spec.js\n');

  for (const [siteKey, siteMeta] of Object.entries(SITES)) {
    const absPath = path.join(REPO_ROOT, siteMeta.path);
    console.log(`▸ ${siteMeta.label}`);
    console.log(`  ${siteMeta.path}`);

    if (!fs.existsSync(absPath)) {
      console.error(`  ✗ ARCHIVO NO ENCONTRADO`);
      anyFailure = true;
      continue;
    }

    const parsed = parseNetlifyToml(absPath);

    for (const context of REQUIRED_CONTEXTS) {
      const actual = parsed[context];
      if (!actual) {
        console.error(`  ✗ context "${context}": no se encontró Content-Security-Policy`);
        anyFailure = true;
        continue;
      }
      const expected = expectedCspFor(siteKey, context);
      const problems = diffCspMaps(actual, expected);
      if (problems.length === 0) {
        console.log(`  ✓ context "${context}": OK`);
      } else {
        console.error(`  ✗ context "${context}": ${problems.length} diferencia(s)`);
        for (const p of problems) console.error(p);
        anyFailure = true;
      }
    }
    console.log('');
  }

  if (anyFailure) {
    console.error('✗ CSP parity FAILED. Actualizá netlify.toml o scripts/security/csp-spec.js según corresponda.');
    process.exit(1);
  }
  console.log('✓ Todos los CSPs matchean la spec canónica.');
}

// Ejecutable directo (`node scripts/security/verify-csp-parity.js`).
// Guardamos el shape modular para poder testearlo/importarlo desde otro script.
if (require.main === module) {
  main();
}

module.exports = {
  parseNetlifyToml,
  parseCspHeaderValue,
  classifyBlockHeader,
  diffCspMaps,
};

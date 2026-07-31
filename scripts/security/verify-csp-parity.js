#!/usr/bin/env node
/**
 * scripts/security/verify-csp-parity.js
 *
 * Task #259 (2026-07-31): reescrito post-descubrimiento empírico de que
 * Netlify `[[headers]]` toml GANA sobre `dist/_headers` para el mismo
 * header name. Antes este script comparaba el CSP del toml contra la
 * spec canónica (tenía sentido cuando el CSP vivía en el toml). Ahora
 * el CSP vive SOLO en `dist/_headers` generado por
 * `frontend/scripts/generate-headers.mjs` y `admin-frontend/scripts/
 * generate-headers.mjs` — el toml no debe contenerlo.
 *
 * Este check ahora asegura DOS invariantes:
 *
 *   1. **Toml no tiene CSP**: `netlify.toml` y `admin-frontend/netlify.toml`
 *      NO deben contener `Content-Security-Policy` ni
 *      `Content-Security-Policy-Report-Only` en ningún `[[headers]]` block.
 *      Si aparece, la precedencia Netlify hace que gane sobre `_headers`
 *      → regresión al problema pre-#259.
 *
 *   2. **Generators producen CSP match con spec**: correr cada generator
 *      con cada backend URL válido y verificar que el `dist/_headers`
 *      resultante tenga el CSP esperado por `cspForSiteAndBackend()`.
 *
 * Corre en CI (`.github/workflows/ci.yml` → job `csp-parity`).
 *
 *   Exit 0 → ambos invariantes OK.
 *   Exit 1 → toml tiene CSP OR generator produce CSP no esperado.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  KNOWN_BACKEND_URLS,
  cspForSiteAndBackend,
  formatCsp,
  trustedTypesReportOnlyFor,
} = require('./csp-spec');

const REPO_ROOT = path.resolve(__dirname, '../..');

// ── Sites y generators cubiertos ──────────────────────────────────────
// Nota: el shape es distinto al viejo `SITES` (csp-spec.js) porque
// el runbook agrega paths de generator + tomlPath que antes no existían.
const TARGETS = [
  {
    key: 'root',
    label: 'root (frontend/tecnyapp.com)',
    tomlPath: 'netlify.toml',
    generator: 'frontend/scripts/generate-headers.mjs',
    distDir: 'frontend/dist',
  },
  {
    key: 'admin',
    label: 'admin (admin-frontend/admin.tecnyapp.com)',
    tomlPath: 'admin-frontend/netlify.toml',
    generator: 'admin-frontend/scripts/generate-headers.mjs',
    distDir: 'admin-frontend/dist',
  },
];

// ── Invariante 1: toml no debe contener CSP ────────────────────────────

/**
 * Escanea el toml buscando `Content-Security-Policy` o
 * `Content-Security-Policy-Report-Only`. Devuelve las líneas offending
 * (o array vacío si limpio).
 */
function findCspInToml(tomlPath) {
  const contents = fs.readFileSync(tomlPath, 'utf8');
  const lines = contents.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Ignorar comentarios — el runbook menciona el nombre del header en
    // texto explicativo; solo importa si es una config real.
    if (line.trimStart().startsWith('#')) continue;
    if (/Content-Security-Policy(-Report-Only)?\s*=/i.test(line)) {
      found.push({ lineNumber: i + 1, text: line.trim() });
    }
  }
  return found;
}

// ── Invariante 2: generator output matchea spec ────────────────────────

/**
 * Parsea un `dist/_headers` file y extrae el CSP + CSP-Report-Only del
 * bloque `/*`. Devuelve `{ csp, reportOnly }` o throw si no encuentra.
 */
function parseHeadersFile(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8');
  const lines = contents.split('\n');
  let inBlock = false;
  let csp = null;
  let reportOnly = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '/*') { inBlock = true; continue; }
    if (inBlock && trimmed === '') { inBlock = false; continue; }
    if (!inBlock) continue;
    const cspMatch = line.match(/^\s+Content-Security-Policy:\s*(.+)$/);
    if (cspMatch) csp = cspMatch[1].trim();
    const rMatch = line.match(/^\s+Content-Security-Policy-Report-Only:\s*(.+)$/);
    if (rMatch) reportOnly = rMatch[1].trim();
  }
  if (!csp) throw new Error(`no Content-Security-Policy en block /* de ${filePath}`);
  if (!reportOnly) throw new Error(`no Content-Security-Policy-Report-Only en block /* de ${filePath}`);
  return { csp, reportOnly };
}

/**
 * Corre el generator con `VITE_API_URL=backendUrl` en un temp dist, y
 * devuelve `{ csp, reportOnly }` parseado.
 */
function runGeneratorAndParse(target, backendUrl) {
  const absDistDir = path.join(REPO_ROOT, target.distDir);
  const absGenerator = path.join(REPO_ROOT, target.generator);
  // Asegurar dist/ existe (mkdir -p). El generator no lo crea porque
  // asume que vite build lo hizo.
  fs.mkdirSync(absDistDir, { recursive: true });
  try {
    execFileSync('node', [absGenerator], {
      env: { ...process.env, VITE_API_URL: backendUrl },
      cwd: path.dirname(absGenerator),
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(`generator falló: ${err.stderr?.toString() || err.message}`);
  }
  return parseHeadersFile(path.join(absDistDir, '_headers'));
}

function main() {
  let anyFailure = false;

  console.log('=== CSP parity check (post-#259) ===\n');

  // ── Invariante 1: toml sin CSP ──────────────────────────────────────
  console.log('▸ Invariante 1: toml no debe declarar Content-Security-Policy');
  for (const target of TARGETS) {
    const absToml = path.join(REPO_ROOT, target.tomlPath);
    if (!fs.existsSync(absToml)) {
      console.error(`  ✗ ${target.tomlPath}: ARCHIVO NO ENCONTRADO`);
      anyFailure = true;
      continue;
    }
    const violations = findCspInToml(absToml);
    if (violations.length === 0) {
      console.log(`  ✓ ${target.tomlPath}`);
    } else {
      console.error(`  ✗ ${target.tomlPath}: ${violations.length} línea(s) violan la invariante`);
      for (const v of violations) {
        console.error(`      línea ${v.lineNumber}: ${v.text.substring(0, 100)}...`);
      }
      console.error(`      → El CSP en toml GANA sobre dist/_headers (precedencia Netlify).`);
      console.error(`      → Remover estas líneas — el CSP viene de scripts/generate-headers.mjs.`);
      anyFailure = true;
    }
  }
  console.log('');

  // ── Invariante 2: generator output matchea spec ────────────────────
  console.log('▸ Invariante 2: generators producen CSP esperado por spec');
  for (const target of TARGETS) {
    console.log(`  ${target.label}`);
    for (const backendUrl of KNOWN_BACKEND_URLS) {
      const tag = backendUrl.includes('staging') ? 'staging' : 'production';
      try {
        const { csp, reportOnly } = runGeneratorAndParse(target, backendUrl);
        const expectedCsp = formatCsp(cspForSiteAndBackend(target.key, backendUrl));
        const expectedReportOnly = trustedTypesReportOnlyFor(backendUrl);
        if (csp !== expectedCsp) {
          console.error(`    ✗ backend ${tag}: CSP no matchea spec`);
          console.error(`        esperado: ${expectedCsp.substring(0, 120)}...`);
          console.error(`        actual:   ${csp.substring(0, 120)}...`);
          anyFailure = true;
        } else if (reportOnly !== expectedReportOnly) {
          console.error(`    ✗ backend ${tag}: CSP-Report-Only no matchea spec`);
          console.error(`        esperado: ${expectedReportOnly}`);
          console.error(`        actual:   ${reportOnly}`);
          anyFailure = true;
        } else {
          console.log(`    ✓ backend ${tag}: OK`);
        }
      } catch (err) {
        console.error(`    ✗ backend ${tag}: ${err.message}`);
        anyFailure = true;
      }
    }
    // Cleanup del _headers temp — no queremos ensuciar el workspace.
    const headersOut = path.join(REPO_ROOT, target.distDir, '_headers');
    if (fs.existsSync(headersOut)) fs.unlinkSync(headersOut);
  }
  console.log('');

  if (anyFailure) {
    console.error('✗ CSP parity FAILED. Ver output arriba.');
    process.exit(1);
  }
  console.log('✓ Todos los invariantes OK.');
}

// Ejecutable directo. Guardamos shape modular para tests.
if (require.main === module) {
  main();
}

module.exports = {
  findCspInToml,
  parseHeadersFile,
  runGeneratorAndParse,
  TARGETS,
};

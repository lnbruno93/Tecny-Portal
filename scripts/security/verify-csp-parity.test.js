/**
 * Tests unitarios para verify-csp-parity.js (refactor #259).
 *
 * Antes esto testeaba el parser CSP del toml. Con task #259 el CSP se movió
 * afuera del toml → los tests viejos ya no aplican. Nuevos tests cubren:
 *
 *   - findCspInToml: detecta violaciones de la invariante "toml sin CSP"
 *   - parseHeadersFile: parsea el `_headers` generado
 *
 * Los tests end-to-end (invariantes 1 y 2 en tandem) los da el propio
 * verify-csp-parity.js corriendo en CI. Ver `.github/workflows/ci.yml`
 * → job `csp-parity`.
 *
 * Corre con:
 *
 *   $ node --test scripts/security/verify-csp-parity.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  findCspInToml,
  parseHeadersFile,
} = require('./verify-csp-parity');

// ── findCspInToml ──────────────────────────────────────────────

test('findCspInToml: toml limpio devuelve array vacío', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-parity-test-'));
  const toml = path.join(dir, 'netlify.toml');
  fs.writeFileSync(toml, `
[build]
  publish = "dist"

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    Strict-Transport-Security = "max-age=63072000"
`);
  const violations = findCspInToml(toml);
  assert.deepEqual(violations, []);
});

test('findCspInToml: detecta Content-Security-Policy activo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-parity-test-'));
  const toml = path.join(dir, 'netlify.toml');
  fs.writeFileSync(toml, `
[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy = "default-src 'self'"
`);
  const violations = findCspInToml(toml);
  assert.equal(violations.length, 1);
  assert.match(violations[0].text, /Content-Security-Policy/);
});

test('findCspInToml: detecta Content-Security-Policy-Report-Only también', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-parity-test-'));
  const toml = path.join(dir, 'netlify.toml');
  fs.writeFileSync(toml, `
[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy-Report-Only = "require-trusted-types-for 'script'"
`);
  const violations = findCspInToml(toml);
  assert.equal(violations.length, 1);
  assert.match(violations[0].text, /Content-Security-Policy-Report-Only/);
});

test('findCspInToml: ignora menciones en comentarios', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-parity-test-'));
  const toml = path.join(dir, 'netlify.toml');
  fs.writeFileSync(toml, `
# El Content-Security-Policy vive en dist/_headers, no acá.
[[headers]]
  for = "/*"
  [headers.values]
    # Ver comment sobre Content-Security-Policy en el generator.
    X-Frame-Options = "DENY"
`);
  const violations = findCspInToml(toml);
  assert.deepEqual(violations, []);
});

test('findCspInToml: detecta múltiples violaciones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-parity-test-'));
  const toml = path.join(dir, 'netlify.toml');
  fs.writeFileSync(toml, `
[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy = "default-src 'self'"
    Content-Security-Policy-Report-Only = "trusted-types default"
`);
  const violations = findCspInToml(toml);
  assert.equal(violations.length, 2);
});

// ── parseHeadersFile ──────────────────────────────────────────

test('parseHeadersFile: extrae CSP + CSP-Report-Only del block /*', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-parity-test-'));
  const headers = path.join(dir, '_headers');
  fs.writeFileSync(headers, `
# comment
/*
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; script-src 'self'
  Content-Security-Policy-Report-Only: require-trusted-types-for 'script'

/assets/*
  Cache-Control: max-age=31536000
`);
  const { csp, reportOnly } = parseHeadersFile(headers);
  assert.equal(csp, "default-src 'self'; script-src 'self'");
  assert.equal(reportOnly, "require-trusted-types-for 'script'");
});

test('parseHeadersFile: throw si falta CSP', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-parity-test-'));
  const headers = path.join(dir, '_headers');
  fs.writeFileSync(headers, `
/*
  X-Frame-Options: DENY
`);
  assert.throws(() => parseHeadersFile(headers), /Content-Security-Policy/);
});

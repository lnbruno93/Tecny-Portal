/**
 * Tests unitarios para verify-csp-parity.js.
 *
 * Usan node:test (built-in, Node 20+) — no requieren jest/vitest ni dependencies
 * extra. Corren con:
 *
 *   $ node --test scripts/security/verify-csp-parity.test.js
 *
 * Cobertura:
 *   - Parser de directivas CSP (tokenización, trailing semicolons, whitespace).
 *   - Clasificador de blocks TOML (context-setting vs subsection vs reset).
 *   - Diff maps (agregadas, faltantes, reordenadas, valores diferentes).
 *   - Parser end-to-end sobre un netlify.toml fixture inline.
 *
 * No cubre `main()` porque su output son console.log/console.error + exit code
 * — testear eso agrega complejidad de spies sin señal extra. La lógica está
 * en las funciones exportadas.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  parseCspHeaderValue,
  classifyBlockHeader,
  diffCspMaps,
  parseNetlifyToml,
} = require('./verify-csp-parity');

// ── parseCspHeaderValue ──────────────────────────────────────────────

test('parseCspHeaderValue: extrae directiva simple con 1 token', () => {
  const result = parseCspHeaderValue("default-src 'self'");
  assert.deepEqual(result, { 'default-src': ["'self'"] });
});

test('parseCspHeaderValue: extrae varias directivas separadas por ;', () => {
  const result = parseCspHeaderValue(
    "default-src 'self'; script-src 'self' https://a.com; frame-ancestors 'none'",
  );
  assert.deepEqual(result, {
    'default-src': ["'self'"],
    'script-src': ["'self'", 'https://a.com'],
    'frame-ancestors': ["'none'"],
  });
});

test('parseCspHeaderValue: ignora trailing semicolon', () => {
  const result = parseCspHeaderValue("default-src 'self';");
  assert.deepEqual(result, { 'default-src': ["'self'"] });
});

test('parseCspHeaderValue: tolera whitespace excesivo entre tokens', () => {
  const result = parseCspHeaderValue("  default-src   'self'   https://a.com  ");
  assert.deepEqual(result, { 'default-src': ["'self'", 'https://a.com'] });
});

test('parseCspHeaderValue: preserva orden de tokens', () => {
  const result = parseCspHeaderValue("connect-src 'self' https://b.com https://a.com");
  // Explícito: los tokens NO se ordenan alfabéticamente — el orden del CSP source
  // se mantiene, así el diff detecta reordenamientos accidentales.
  assert.deepEqual(result['connect-src'], ["'self'", 'https://b.com', 'https://a.com']);
});

// ── classifyBlockHeader ──────────────────────────────────────────────

test('classifyBlockHeader: [[headers]] → set production', () => {
  assert.deepEqual(classifyBlockHeader('[[headers]]'), { action: 'set', context: 'production' });
});

test('classifyBlockHeader: [[context.branch-deploy.headers]] → set branch-deploy', () => {
  assert.deepEqual(classifyBlockHeader('[[context.branch-deploy.headers]]'), {
    action: 'set',
    context: 'branch-deploy',
  });
});

test('classifyBlockHeader: [[context.deploy-preview.headers]] → set deploy-preview', () => {
  assert.deepEqual(classifyBlockHeader('[[context.deploy-preview.headers]]'), {
    action: 'set',
    context: 'deploy-preview',
  });
});

test('classifyBlockHeader: [headers.values] → keep (subsección)', () => {
  assert.deepEqual(classifyBlockHeader('[headers.values]'), { action: 'keep' });
});

test('classifyBlockHeader: [context.branch-deploy.headers.values] → keep', () => {
  assert.deepEqual(classifyBlockHeader('[context.branch-deploy.headers.values]'), {
    action: 'keep',
  });
});

test('classifyBlockHeader: [build] → reset (block no relacionado)', () => {
  assert.deepEqual(classifyBlockHeader('[build]'), { action: 'reset' });
});

test('classifyBlockHeader: [[redirects]] → reset', () => {
  assert.deepEqual(classifyBlockHeader('[[redirects]]'), { action: 'reset' });
});

test('classifyBlockHeader: [build.environment] → reset (subsección no de headers)', () => {
  assert.deepEqual(classifyBlockHeader('[build.environment]'), { action: 'reset' });
});

// ── diffCspMaps ──────────────────────────────────────────────────────

test('diffCspMaps: maps idénticos → sin problemas', () => {
  const a = { 'default-src': ["'self'"], 'script-src': ["'self'", 'https://a.com'] };
  const b = { 'default-src': ["'self'"], 'script-src': ["'self'", 'https://a.com'] };
  assert.deepEqual(diffCspMaps(a, b), []);
});

test('diffCspMaps: token faltante en actual → problema', () => {
  const actual = { 'script-src': ["'self'"] };
  const expected = { 'script-src': ["'self'", 'https://hcaptcha.com'] };
  const problems = diffCspMaps(actual, expected);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /script-src/);
});

test('diffCspMaps: directiva de más en actual → problema', () => {
  const actual = { 'default-src': ["'self'"], 'unexpected-src': ["'none'"] };
  const expected = { 'default-src': ["'self'"] };
  const problems = diffCspMaps(actual, expected);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unexpected-src/);
});

test('diffCspMaps: directiva faltante en actual → problema', () => {
  const actual = { 'default-src': ["'self'"] };
  const expected = { 'default-src': ["'self'"], 'frame-ancestors': ["'none'"] };
  const problems = diffCspMaps(actual, expected);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /frame-ancestors/);
  assert.match(problems[0], /faltante/);
});

test('diffCspMaps: tokens reordenados → problema (orden importa)', () => {
  const actual = { 'script-src': ['https://a.com', "'self'"] };
  const expected = { 'script-src': ["'self'", 'https://a.com'] };
  const problems = diffCspMaps(actual, expected);
  assert.equal(problems.length, 1);
});

// ── parseNetlifyToml end-to-end ──────────────────────────────────────

test('parseNetlifyToml: extrae CSP de los 3 contextos en un fixture inline', () => {
  // Fixture inline representativo: un netlify.toml mínimo con la MISMA
  // estructura que el real (block global + branch-deploy + deploy-preview,
  // cada uno con `[headers.values]` subsection).
  const fixture = `
[build]
  base = "frontend"
  command = "npm run build"

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    Content-Security-Policy = "default-src 'self'; script-src 'self'"

[[context.branch-deploy.headers]]
  for = "/*"
  [context.branch-deploy.headers.values]
    Content-Security-Policy = "default-src 'self'; script-src 'self' https://staging.com"

[[context.deploy-preview.headers]]
  for = "/*"
  [context.deploy-preview.headers.values]
    Content-Security-Policy = "default-src 'self'; connect-src 'self'"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
`;
  const tmp = path.join(os.tmpdir(), `csp-parity-test-${Date.now()}.toml`);
  fs.writeFileSync(tmp, fixture);
  try {
    const result = parseNetlifyToml(tmp);
    assert.deepEqual(result.production, {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
    });
    assert.deepEqual(result['branch-deploy'], {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://staging.com'],
    });
    assert.deepEqual(result['deploy-preview'], {
      'default-src': ["'self'"],
      'connect-src': ["'self'"],
    });
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('parseNetlifyToml: block [build] no ensucia el context (regresión)', () => {
  // Regresión: la primera versión del parser trataba `[build.environment]`
  // como si fuera un context-setter y perdía el track del context real. Este
  // fixture pone un [build.environment] ENTRE el [[headers]] y su .values
  // subsection para asegurar que el reset funciona bien.
  const fixture = `
[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy = "default-src 'self'"

[build]
  base = "frontend"

[build.environment]
  VITE_API_URL = "https://x.com"

[[context.branch-deploy.headers]]
  for = "/*"
  [context.branch-deploy.headers.values]
    Content-Security-Policy = "default-src 'self'; connect-src https://y.com"
`;
  const tmp = path.join(os.tmpdir(), `csp-parity-test-${Date.now()}.toml`);
  fs.writeFileSync(tmp, fixture);
  try {
    const result = parseNetlifyToml(tmp);
    // Ambos contextos deben aparecer, y el [build.environment] NO debe
    // aparecer como si fuera un context aparte.
    assert.deepEqual(Object.keys(result).sort(), ['branch-deploy', 'production']);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('parseNetlifyToml: netlify.toml del repo (root) parsea 3 contextos', () => {
  const rootToml = path.resolve(__dirname, '../../netlify.toml');
  const result = parseNetlifyToml(rootToml);
  assert.ok(result.production, 'debe encontrar production');
  assert.ok(result['branch-deploy'], 'debe encontrar branch-deploy');
  assert.ok(result['deploy-preview'], 'debe encontrar deploy-preview');
  // Sanity: la directiva default-src debe existir en los 3.
  assert.deepEqual(result.production['default-src'], ["'self'"]);
});

test('parseNetlifyToml: netlify.toml del repo (admin) parsea 3 contextos', () => {
  const adminToml = path.resolve(__dirname, '../../admin-frontend/netlify.toml');
  const result = parseNetlifyToml(adminToml);
  assert.ok(result.production, 'debe encontrar production');
  assert.ok(result['branch-deploy'], 'debe encontrar branch-deploy');
  assert.ok(result['deploy-preview'], 'debe encontrar deploy-preview');
});

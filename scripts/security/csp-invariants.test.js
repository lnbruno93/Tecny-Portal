/**
 * Tests de INVARIANTES de seguridad del CSP canónico.
 *
 * A diferencia de `verify-csp-parity.js` (que compara root vs admin), estos
 * tests asertan que la spec canónica NUNCA relaja ciertas garantías core.
 * Cualquier PR que remueva `object-src 'none'`, agregue `'unsafe-inline'`
 * a script-src, etc. — falla acá.
 *
 * Cierra el ciclo de 12 sprints de CSP hardening. Sin este archivo, un
 * PR bien intencionado ("agregá 'unsafe-eval' porque necesito una lib")
 * podría revertir el trabajo silenciosamente y solo se detectaría auditando
 * el netlify.toml a ojo.
 *
 * Corre con:
 *
 *   $ node --test scripts/security/csp-invariants.test.js
 *
 * Los invariantes están basados en:
 * - MDN CSP Best Practices.
 * - OWASP Cheat Sheet para SPAs.
 * - Decisiones documentadas en docs/CSP.md.
 *
 * Si un invariante DEBE cambiarse (raro, requiere justificación fuerte):
 * update el test + PR body con la razón. El test es explícito para forzar
 * esa conversación.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  COMMON_DIRECTIVES,
  SITE_DIFFERENCES,
  expectedCspFor,
  REQUIRED_CONTEXTS,
} = require('./csp-spec.js');

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Devuelve los tokens efectivos de una directiva. Si está solo en
 * SITE_DIFFERENCES, cae al common. Si está en ambos, gana el site (el
 * builder `expectedCspFor` hace exactamente ese spread).
 */
function tokensFor(site, directive) {
  return expectedCspFor(site, 'production')[directive] || [];
}

const SITES = ['root', 'admin'];

// ── script-src ─────────────────────────────────────────────────────────

test('script-src NUNCA tiene \'unsafe-inline\'', () => {
  for (const site of SITES) {
    const tokens = tokensFor(site, 'script-src');
    assert.ok(
      !tokens.includes("'unsafe-inline'"),
      `[${site}] script-src no debe permitir 'unsafe-inline'. ` +
      `Es el vector XSS principal. Si aparece: fixear el codebase, ` +
      `no relajar el CSP. Actual: ${JSON.stringify(tokens)}`
    );
  }
});

test('script-src NUNCA tiene \'unsafe-eval\'', () => {
  for (const site of SITES) {
    const tokens = tokensFor(site, 'script-src');
    assert.ok(
      !tokens.includes("'unsafe-eval'"),
      `[${site}] script-src no debe permitir 'unsafe-eval'. ` +
      `Habilita eval() y new Function(), superficie XSS grande. ` +
      `Actual: ${JSON.stringify(tokens)}`
    );
  }
});

test('script-src NUNCA tiene wildcard \'*\'', () => {
  for (const site of SITES) {
    const tokens = tokensFor(site, 'script-src');
    assert.ok(
      !tokens.includes('*'),
      `[${site}] script-src no debe permitir *. ` +
      `Cualquier origen podría hostear scripts arbitrarios. ` +
      `Actual: ${JSON.stringify(tokens)}`
    );
  }
});

test('script-src-attr fuerza \'none\' (bloquea inline event handlers)', () => {
  for (const site of SITES) {
    const tokens = tokensFor(site, 'script-src-attr');
    assert.deepEqual(
      tokens,
      ["'none'"],
      `[${site}] script-src-attr debe ser 'none' para bloquear ` +
      `handlers HTML inline como onclick="alert(1)". React usa ` +
      `syntheticEvent, no HTML attrs — no debería haber impacto. ` +
      `Actual: ${JSON.stringify(tokens)}`
    );
  }
});

// ── object-src / frame-ancestors ────────────────────────────────────────

test('object-src fuerza \'none\' (bloquea plugins legacy Flash/Java)', () => {
  for (const site of SITES) {
    const tokens = tokensFor(site, 'object-src');
    assert.deepEqual(
      tokens,
      ["'none'"],
      `[${site}] object-src debe ser 'none'. ` +
      `Plugins legacy son un vector XSS reconocido, y no usamos ninguno. ` +
      `Actual: ${JSON.stringify(tokens)}`
    );
  }
});

test('frame-ancestors fuerza \'none\' (anti-clickjacking)', () => {
  for (const site of SITES) {
    const tokens = tokensFor(site, 'frame-ancestors');
    assert.deepEqual(
      tokens,
      ["'none'"],
      `[${site}] frame-ancestors debe ser 'none'. ` +
      `Equivalente a X-Frame-Options: DENY. Ni tecnyapp.com ni ` +
      `admin.tecnyapp.com deben poder ser iframed en otro dominio. ` +
      `Actual: ${JSON.stringify(tokens)}`
    );
  }
});

// ── base-uri / form-action / default-src ────────────────────────────────

test('base-uri fuerza \'self\' (bloquea inyección de <base>)', () => {
  for (const site of SITES) {
    const tokens = tokensFor(site, 'base-uri');
    assert.deepEqual(
      tokens,
      ["'self'"],
      `[${site}] base-uri debe ser 'self'. ` +
      `Un <base href="http://attacker.com/"> inyectado podría redirigir ` +
      `todas las URLs relativas del bundle. ` +
      `Actual: ${JSON.stringify(tokens)}`
    );
  }
});

test('form-action fuerza \'self\' (bloquea form POST a external)', () => {
  for (const site of SITES) {
    const tokens = tokensFor(site, 'form-action');
    assert.deepEqual(
      tokens,
      ["'self'"],
      `[${site}] form-action debe ser 'self'. ` +
      `Impide que un form con action="http://attacker.com" exfiltre ` +
      `credenciales tipeadas por el user. ` +
      `Actual: ${JSON.stringify(tokens)}`
    );
  }
});

test('default-src fuerza \'self\' (fallback restrictivo)', () => {
  for (const site of SITES) {
    const tokens = tokensFor(site, 'default-src');
    assert.deepEqual(
      tokens,
      ["'self'"],
      `[${site}] default-src debe ser 'self'. ` +
      `Es el fallback para directivas no listadas explícitamente. ` +
      `Con 'self', un directive nuevo (ej. child-src si aparece) ` +
      `default-eará a restrictivo, no permisivo. ` +
      `Actual: ${JSON.stringify(tokens)}`
    );
  }
});

// ── upgrade-insecure-requests ───────────────────────────────────────────

test('upgrade-insecure-requests está presente (defense-in-depth con HSTS)', () => {
  for (const site of SITES) {
    const tokens = tokensFor(site, 'upgrade-insecure-requests');
    // Directive sin tokens (spec: [])
    assert.ok(
      tokens !== undefined,
      `[${site}] upgrade-insecure-requests debe estar presente. ` +
      `Cubre subresources http:// dentro del bundle compilado, ` +
      `complementando HSTS que solo cubre navigation.`
    );
    assert.deepEqual(
      tokens,
      [],
      `[${site}] upgrade-insecure-requests no lleva tokens. ` +
      `Actual: ${JSON.stringify(tokens)}`
    );
  }
});

// ── style-src (documentar el tech-debt aceptado) ───────────────────────

test('style-src tiene \'unsafe-inline\' (13 residuales data-driven — Rec #6)', () => {
  // Este test documenta explícitamente que 'unsafe-inline' está presente
  // en style-src Y ESTO ES ACEPTADO. La razón: 13 residuales data-driven
  // (bar-fill widths, chart heights %) que no se pueden expresar como
  // clases estáticas. Ver docs/CSP.md sección "13 residuales".
  //
  // El anti-regression check (scripts/csp-inline-styles-check.mjs) previene
  // que el count suba. Cuando/si logremos runtime CSS custom props para
  // los 13 residuales, este test debe ACTUALIZARSE — no borrarse.
  for (const site of SITES) {
    const tokens = tokensFor(site, 'style-src');
    assert.ok(
      tokens.includes("'unsafe-inline'"),
      `[${site}] style-src debe tener 'unsafe-inline' aceptado. ` +
      `Si lo removieron pensando "logramos hardening total": VERIFICAR ` +
      `que los 13 residuales fueron migrados antes (bar-fills, etc.). ` +
      `Ver docs/CSP.md. Actual: ${JSON.stringify(tokens)}`
    );
  }
});

// ── report-uri ──────────────────────────────────────────────────────────

test('todas las contextos tienen report-uri configurado', () => {
  for (const site of SITES) {
    for (const context of REQUIRED_CONTEXTS) {
      const spec = expectedCspFor(site, context);
      assert.ok(
        Array.isArray(spec['report-uri']) && spec['report-uri'].length > 0,
        `[${site}][${context}] report-uri debe estar seteado. ` +
        `Sin report-uri las violaciones son invisibles. ` +
        `Actual: ${JSON.stringify(spec['report-uri'])}`
      );
    }
  }
});

// ── Diferencias entre sites (fixture del bug 2026-07-19) ────────────────

test('root y admin tienen las mismas backend URLs en connect-src', () => {
  const rootConnect = tokensFor('root', 'connect-src');
  const adminConnect = tokensFor('admin', 'connect-src');
  assert.deepEqual(
    rootConnect,
    adminConnect,
    'connect-src debe ser idéntico entre root y admin. ' +
    'El bug del 2026-07-19 (logos admin no cargaban) fue una divergencia ' +
    'no intencional entre estos dos. Ver docs/CSP.md.'
  );
});

test('root y admin tienen las mismas backend URLs en img-src', () => {
  const rootImg  = tokensFor('root',  'img-src');
  const adminImg = tokensFor('admin', 'img-src');
  const backends = ['https://tecny-backend-production.up.railway.app',
                    'https://tecny-backend-staging.up.railway.app'];
  for (const backend of backends) {
    assert.ok(
      rootImg.includes(backend),
      `[root] img-src debe incluir ${backend}. Actual: ${JSON.stringify(rootImg)}`
    );
    assert.ok(
      adminImg.includes(backend),
      `[admin] img-src debe incluir ${backend}. Actual: ${JSON.stringify(adminImg)}`
    );
  }
});

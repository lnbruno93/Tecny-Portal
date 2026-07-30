#!/usr/bin/env node
/**
 * scripts/security/verify-landing-csp-hcaptcha.js — asserta que el CSP del
 * landing incluye `https://*.hcaptcha.com` en las 4 directives necesarias
 * (script-src, style-src, connect-src, frame-src).
 *
 * ── Contexto (P0 del 2026-07-30) ──────────────────────────────────────
 *
 * La migración a Astro (PRs #936/#937) creó un CSP restrictivo en el
 * landing que omitió hcaptcha.com. Los paths /login, /signup y
 * /forgot-password del portal se sirven vía proxy 200 desde el landing —
 * los headers que aplican son los del landing site (pattern de Netlify:
 * `[[headers]]` del site wrappean el response del proxy). Sin hcaptcha
 * en el CSP del landing, el widget invisible no cargaba → usuarios NO
 * podían loguearse. 4 horas de detour.
 *
 * Este check corre en CI y falla si alguien saca hcaptcha del CSP de
 * cualquiera de los 2 files donde vive:
 *   · landing/netlify.toml          (block [[headers]] for = "/*")
 *   · landing/public/_headers       (block "/*" — es el fallback runtime
 *                                    porque el edge cache de Netlify a
 *                                    veces no invalida cambios del toml)
 *
 * ── Cómo corre ────────────────────────────────────────────────────────
 *
 *   $ node scripts/security/verify-landing-csp-hcaptcha.js
 *
 * Exit 0 → los 4 directives tienen hcaptcha en ambos files.
 * Exit 1 → falta hcaptcha en alguno; el output dice cuál file y directive.
 *
 * ── Diseño del parser ─────────────────────────────────────────────────
 *
 * Regex simple sobre la string del CSP. No parseamos TOML full ni
 * _headers spec — el shape es predecible (el CSP vive en 1 sola línea
 * de cada file). Si el shape cambia mañana, este check falla ruidoso y
 * lo actualizamos.
 *
 * ── Extensibilidad ────────────────────────────────────────────────────
 *
 * Si a futuro agregamos otros vendors críticos (Stripe, Datadog RUM,
 * etc.) que también DEBAN estar en el CSP para funcionalidad crítica
 * del portal via proxy, agregar tokens al array `REQUIRED_TOKENS` con
 * las mismas directives.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');

// ── Config ────────────────────────────────────────────────────────────

/**
 * Tokens que DEBEN estar presentes en cada uno de los directives listados.
 * Si mañana agregamos otro vendor crítico (Stripe, DataDog RUM, etc.) que
 * corra via proxy desde el portal, agregarlo acá.
 */
const REQUIRED_TOKENS = Object.freeze([
  {
    token: 'https://*.hcaptcha.com',
    directives: ['script-src', 'style-src', 'connect-src', 'frame-src'],
    reason: 'widget hCaptcha invisible en /login, /signup, /forgot-password del portal (proxeados desde landing)',
  },
]);

/**
 * Files a verificar. Cada uno especifica cómo extraer el CSP header value.
 */
const FILES = Object.freeze([
  {
    label: 'landing/netlify.toml',
    path: 'landing/netlify.toml',
    // El CSP vive en 1 línea: `    Content-Security-Policy = "..."`.
    // El regex captura el string entre comillas después de `=`.
    extractCsp: (content) => {
      const m = content.match(/Content-Security-Policy\s*=\s*"([^"]+)"/);
      return m ? m[1] : null;
    },
  },
  {
    label: 'landing/public/_headers',
    path: 'landing/public/_headers',
    // En _headers format: `  Content-Security-Policy: ...\n` (hasta fin de línea).
    extractCsp: (content) => {
      const m = content.match(/Content-Security-Policy:\s*([^\n]+)/);
      return m ? m[1].trim() : null;
    },
  },
]);

// ── Parser CSP ────────────────────────────────────────────────────────

/**
 * Parsea un CSP header value a un objeto { directive-name → [tokens] }.
 *
 *   "default-src 'self'; script-src 'self' https://x.com;"
 *   → { 'default-src': ["'self'"], 'script-src': ["'self'", 'https://x.com'] }
 */
function parseCsp(csp) {
  const out = {};
  csp
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((directive) => {
      const parts = directive.split(/\s+/);
      const name = parts[0];
      const tokens = parts.slice(1);
      out[name] = tokens;
    });
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────

/** Colecta errors en lugar de exit-fast — devuelve reporte completo. */
const errors = [];

for (const file of FILES) {
  const fullPath = path.join(REPO_ROOT, file.path);
  if (!fs.existsSync(fullPath)) {
    errors.push({
      file: file.label,
      msg: `file no encontrado en ${fullPath}`,
    });
    continue;
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  const csp = file.extractCsp(content);
  if (!csp) {
    errors.push({
      file: file.label,
      msg: 'no se pudo extraer Content-Security-Policy — cambió el shape del file?',
    });
    continue;
  }
  const parsed = parseCsp(csp);

  for (const { token, directives, reason } of REQUIRED_TOKENS) {
    for (const directive of directives) {
      const tokens = parsed[directive] || [];
      if (!tokens.includes(token)) {
        errors.push({
          file: file.label,
          directive,
          token,
          reason,
          msg: `directive "${directive}" no incluye "${token}"`,
        });
      }
    }
  }
}

// ── Reporte ───────────────────────────────────────────────────────────

if (errors.length === 0) {
  console.log('✓ CSP del landing: hcaptcha.com presente en script/style/connect/frame-src');
  console.log(`  Files verificados: ${FILES.map((f) => f.label).join(', ')}`);
  process.exit(0);
}

console.error('✗ CSP del landing tiene problemas:\n');
for (const err of errors) {
  console.error(`  ${err.file}:`);
  console.error(`    ${err.msg}`);
  if (err.reason) console.error(`    ↳ razón: ${err.reason}`);
  console.error('');
}
console.error('Ver contexto en scripts/security/verify-landing-csp-hcaptcha.js (comment cabecera).');
process.exit(1);

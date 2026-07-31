#!/usr/bin/env node
/**
 * admin-frontend/scripts/generate-headers.mjs — genera `dist/_headers`
 * runtime para el site admin.tecnyapp.com (task backlog #259).
 *
 * Espejo del generator en frontend/scripts/generate-headers.mjs — misma
 * lógica, distinto SITE ('admin' vs 'root') y distinto DIST_DIR. La
 * spec canónica (`scripts/security/csp-spec.js`) sabe la diferencia:
 * admin tiene `blob:` en img-src (TrustedCompaniesCard preview),
 * root no.
 *
 * Ver documentación completa en el generator del portal.
 */

import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const SPEC_PATH = resolve(__dirname, '../../scripts/security/csp-spec.js');
const {
  KNOWN_BACKEND_URLS,
  cspForSiteAndBackend,
  formatCsp,
  trustedTypesReportOnlyFor,
} = require(SPEC_PATH);

// ── Config del site ───────────────────────────────────────────────────
const SITE = 'admin';
const DIST_DIR = resolve(__dirname, '../dist');
const OUTPUT_PATH = join(DIST_DIR, '_headers');

function resolveBackendUrl() {
  const fromEnv = process.env.VITE_API_URL;
  if (fromEnv) {
    if (!KNOWN_BACKEND_URLS.includes(fromEnv)) {
      throw new Error(
        `[generate-headers admin] VITE_API_URL no reconocido: "${fromEnv}". ` +
        `Válidos: ${KNOWN_BACKEND_URLS.join(', ')}. ` +
        `Actualizá scripts/security/csp-spec.js:KNOWN_BACKEND_URLS si es un backend nuevo legítimo.`
      );
    }
    return fromEnv;
  }
  console.warn('[generate-headers admin] VITE_API_URL no set — usando backend prod por default.');
  return 'https://tecny-backend-production.up.railway.app';
}

function generate() {
  if (!existsSync(DIST_DIR)) {
    throw new Error(
      `[generate-headers admin] ${DIST_DIR} no existe. Correr después de \`vite build\`.`
    );
  }

  const backendUrl = resolveBackendUrl();
  const cspDict = cspForSiteAndBackend(SITE, backendUrl);
  const cspHeader = formatCsp(cspDict);
  const reportOnlyHeader = trustedTypesReportOnlyFor(backendUrl);

  // Static headers — replicar del admin-frontend/netlify.toml.
  // Diferencia con portal: agrega X-Robots-Tag (admin no es público).
  // X-Tecny-Headers-Source: diagnóstico verificable con curl.
  const staticHeaders = [
    'X-Robots-Tag: noindex, nofollow',
    'X-Frame-Options: DENY',
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: strict-origin-when-cross-origin',
    'Permissions-Policy: camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
    `X-Tecny-Headers-Source: build-time-generator-admin-${SITE}`,
  ];

  // Cache headers — replicar del toml.
  const indexHeaders = [
    'Cache-Control: no-cache, no-store, must-revalidate',
  ];
  const assetsHeaders = [
    'Cache-Control: public, max-age=31536000, immutable',
  ];

  const content = [
    '# ─────────────────────────────────────────────────────────────────────',
    '# dist/_headers — GENERADO AUTOMÁTICAMENTE por scripts/generate-headers.mjs.',
    '# NO EDITAR A MANO. Cambios acá se pierden en el próximo build.',
    '# Config fuente: scripts/security/csp-spec.js.',
    '# ',
    `# Backend deployed: ${backendUrl}`,
    `# Site: ${SITE} (admin-frontend/admin.tecnyapp.com)`,
    `# Build ts: ${new Date().toISOString()}`,
    '# ',
    '# Netlify aplica _headers con precedencia sobre [[headers]] del toml',
    '# per-header. Ver docs/runbooks/csp-landing.md sección "Build-time',
    '# _headers generation (task #259)".',
    '# ─────────────────────────────────────────────────────────────────────',
    '',
    '/*',
    ...staticHeaders.map(h => `  ${h}`),
    `  Content-Security-Policy: ${cspHeader}`,
    `  Content-Security-Policy-Report-Only: ${reportOnlyHeader}`,
    '',
    '/index.html',
    ...indexHeaders.map(h => `  ${h}`),
    '',
    '/assets/*',
    ...assetsHeaders.map(h => `  ${h}`),
    '',
  ].join('\n');

  writeFileSync(OUTPUT_PATH, content, 'utf8');
  console.log(
    `[generate-headers admin] ${OUTPUT_PATH} generado (backend: ${backendUrl}).`
  );
}

try {
  generate();
} catch (err) {
  console.error(`[generate-headers admin] ERROR: ${err.message}`);
  process.exit(1);
}

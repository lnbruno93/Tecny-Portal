#!/usr/bin/env node
/**
 * frontend/scripts/generate-headers.mjs — genera `dist/_headers` runtime
 * (task backlog #259).
 *
 * ── Problema ──────────────────────────────────────────────────────────
 *
 * `[[context.<X>.headers]]` en netlify.toml es DEAD CODE — solo aplica
 * el `[[headers]]` global (confirmado 2026-07-30 durante staging drift
 * diagnóstico). Consecuencia: no podemos separar el CSP prod / staging
 * / preview desde toml. El Fix 10 del audit 07-25 (restringir prod a
 * backend-prod solamente) rompió staging por 4 días porque el header
 * global aplicaba a AMBOS sites; el PR #948 lo unificó pragmáticamente
 * a "ambos backends permitidos" para desbloquear.
 *
 * ── Solución ──────────────────────────────────────────────────────────
 *
 * Netlify `dist/_headers` file OVERRIDES el `[[headers]]` toml para los
 * paths que matchea. Como el build corre en Netlify con `VITE_API_URL`
 * ya seteado por `[build.environment]` / `[context.<X>.environment]`,
 * podemos derivar el backend del env deployed y escribir un CSP
 * restringido a SOLO ESE backend. Esto:
 *
 *   · Restaura el hardening del Fix 10 (portal-prod → backend-prod
 *     solamente; portal-staging → backend-staging solamente).
 *   · Cierra el XSS-exfil-cross-env cerrado por Fix 10 y regressed
 *     por PR #948.
 *   · Funciona porque _headers se aplica per SITE, y VITE_API_URL
 *     está scopeado per site en Netlify.
 *
 * El toml queda como fallback SAFE: si por alguna razón _headers no
 * se genera, el sitio sigue funcionando (CSP más permisivo pero
 * funcional).
 *
 * ── Contract con Netlify ──────────────────────────────────────────────
 *
 * Docs: https://docs.netlify.com/routing/headers/#syntax-for-the-headers-file
 * Reglas relevantes:
 *   · Path pattern en primera columna, headers indentados en las
 *     siguientes lineas (2 spaces).
 *   · Un mismo path puede tener múltiples header lines.
 *   · El file OVERRIDES `[[headers]]` toml para los headers definidos;
 *     los headers que no están acá siguen viniendo del toml (merge por
 *     header, no por path).
 *   · Un header con mismo nombre en _headers y toml → gana _headers.
 *
 * ── Verificación post-build ───────────────────────────────────────────
 *
 * Después de `npm run build` local:
 *   cat dist/_headers  # ver que se generó correctamente
 *   curl -sI https://tecnyapp.com/ | grep -i content-security-policy  # post-deploy
 *
 * En prod:
 *   · `https://tecnyapp.com/` → Content-Security-Policy debe incluir
 *     tecny-backend-production, NO tecny-backend-staging.
 *   · `https://staging.tecnyapp.com/` → mismo pero con -staging.
 */

import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Load spec canónica (Node CJS — resolvemos ../../scripts/security/).
const SPEC_PATH = resolve(__dirname, '../../scripts/security/csp-spec.js');
const {
  KNOWN_BACKEND_URLS,
  cspForSiteAndBackend,
  formatCsp,
  trustedTypesReportOnlyFor,
} = require(SPEC_PATH);

// ── Config del site ───────────────────────────────────────────────────
// Este generator corre en frontend/, así que site='root'. El generator
// del admin (admin-frontend/scripts/generate-headers.mjs) pasa 'admin'.
const SITE = 'root';
const DIST_DIR = resolve(__dirname, '../dist');
const OUTPUT_PATH = join(DIST_DIR, '_headers');

// ── Resolución del backend URL ────────────────────────────────────────
// Prioridad: VITE_API_URL (seteado por Netlify según context) > fallback
// prod (para builds locales sin env vars). Netlify siempre pasa la env
// var correcta al build.
//
// Fallback prod es intencional para local dev: `npm run build` en la
// máquina de un dev debería producir un _headers compatible con prod.
// Si alguien pushea una branch a un site staging sin `[context.<branch>.environment]`,
// también le va a caer prod por default — mismo comportamiento que
// [build.environment] del toml.
function resolveBackendUrl() {
  const fromEnv = process.env.VITE_API_URL;
  if (fromEnv) {
    if (!KNOWN_BACKEND_URLS.includes(fromEnv)) {
      // Defense-in-depth: si alguien setea VITE_API_URL a un dominio
      // rando (typo, misconfig, o malicioso), abortamos el build en vez
      // de escribir un CSP que legitime ese dominio.
      throw new Error(
        `[generate-headers] VITE_API_URL no reconocido: "${fromEnv}". ` +
        `Válidos: ${KNOWN_BACKEND_URLS.join(', ')}. ` +
        `Actualizá scripts/security/csp-spec.js:KNOWN_BACKEND_URLS si es un backend nuevo legítimo.`
      );
    }
    return fromEnv;
  }
  // Fallback prod (build local sin env vars).
  console.warn('[generate-headers] VITE_API_URL no set — usando backend prod por default.');
  return 'https://tecny-backend-production.up.railway.app';
}

// ── Generación del _headers file ──────────────────────────────────────
function generate() {
  if (!existsSync(DIST_DIR)) {
    throw new Error(
      `[generate-headers] ${DIST_DIR} no existe. Correr después de \`vite build\`.`
    );
  }

  const backendUrl = resolveBackendUrl();
  const cspDict = cspForSiteAndBackend(SITE, backendUrl);
  const cspHeader = formatCsp(cspDict);
  const reportOnlyHeader = trustedTypesReportOnlyFor(backendUrl);

  // Static security headers — deben duplicar los del `[[headers]]` toml
  // porque _headers wins per-header (no per-block). Si acá solo pusiéramos
  // CSP, los demás (HSTS, X-Frame-Options, etc.) seguirían viniendo del
  // toml — pero mejor tenerlos juntos para claridad y menor sorpresa
  // operativa.
  //
  // X-Tecny-Headers-Source es un marker de diagnóstico — nos permite verificar
  // con `curl -sI <url> | grep x-tecny-headers-source` si el _headers file
  // fue efectivamente aplicado por Netlify (deprecable una vez estable).
  const staticHeaders = [
    'X-Frame-Options: DENY',
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: strict-origin-when-cross-origin',
    'Permissions-Policy: camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
    `X-Tecny-Headers-Source: build-time-generator-portal-${SITE}`,
  ];

  // Cache headers para SW, manifest, y assets — replicar del toml para
  // la misma razón (evitar el _headers/toml split confuso).
  const swHeaders = [
    'Cache-Control: no-cache, no-store, must-revalidate',
    'Service-Worker-Allowed: /',
  ];
  const manifestHeaders = [
    'Content-Type: application/manifest+json',
    'Cache-Control: public, max-age=86400',
  ];
  const assetsHeaders = [
    'Cache-Control: public, max-age=31536000, immutable',
  ];

  // Formato Netlify _headers: `path` + indent 2 spaces por header line.
  // Múltiples path blocks separados por línea en blanco (spec estándar).
  const content = [
    '# ─────────────────────────────────────────────────────────────────────',
    '# dist/_headers — GENERADO AUTOMÁTICAMENTE por scripts/generate-headers.mjs.',
    '# NO EDITAR A MANO. Cambios acá se pierden en el próximo build.',
    '# Config fuente: scripts/security/csp-spec.js.',
    '# ',
    `# Backend deployed: ${backendUrl}`,
    `# Site: ${SITE} (frontend/tecnyapp.com)`,
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
    '/sw.js',
    ...swHeaders.map(h => `  ${h}`),
    '',
    '/manifest.webmanifest',
    ...manifestHeaders.map(h => `  ${h}`),
    '',
    '/assets/*',
    ...assetsHeaders.map(h => `  ${h}`),
    '',
  ].join('\n');

  writeFileSync(OUTPUT_PATH, content, 'utf8');
  console.log(
    `[generate-headers] ${OUTPUT_PATH} generado (backend: ${backendUrl}).`
  );
}

// ── Entry point ───────────────────────────────────────────────────────
try {
  generate();
} catch (err) {
  console.error(`[generate-headers] ERROR: ${err.message}`);
  process.exit(1);
}

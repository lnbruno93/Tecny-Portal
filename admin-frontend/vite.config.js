/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Admin console build. Separada del portal de usuarios para deployar en
// admin.tecnyapp.com con su propio bundle, su propio CSP, y sin exponer
// código super-admin al frontend público.
//
// Port 5174 elegido a propósito para no chocar con el portal (5173) cuando
// Lucas levanta los dos en paralelo en local.

// ─────────────────────────────────────────────────────────────────────────
// Build metadata + Sentry source maps (task #137, 2026-07-15)
//
// Mismo pattern que frontend/vite.config.js — inyectamos __BUILD_COMMIT__ y
// __BUILD_VERSION__ al bundle para que reportError.js pueda taggear los
// errores con la release que los generó. Sin esto los stacktraces
// minificados de Sentry son ilegibles.
//
// El plugin de Sentry es no-op sin SENTRY_AUTH_TOKEN → build local /
// preview no requieren token. En Netlify (main + staging) el token va
// como env var → los .map se suben a Sentry y se borran del bundle
// público para no exponer código admin.
// ─────────────────────────────────────────────────────────────────────────
function buildCommit() {
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
  if (process.env.COMMIT_REF)             return process.env.COMMIT_REF.slice(0, 7); // Netlify
  if (process.env.GIT_COMMIT_SHA)         return process.env.GIT_COMMIT_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}
function buildVersion() {
  try {
    return JSON.parse(readFileSync('./package.json', 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}
const SENTRY_TOKEN   = process.env.SENTRY_AUTH_TOKEN;
const SENTRY_ORG     = process.env.SENTRY_ORG     || 'lnbruno';
const SENTRY_PROJECT = process.env.SENTRY_PROJECT || 'tecny-portal-admin';
const BUILD_SHA      = buildCommit();
const BUILD_VER      = buildVersion();

// ─────────────────────────────────────────────────────────────────────────
// Fail-loud gate para VITE_API_URL en builds de Netlify (2026-07-04 P0).
//
// Contexto: el admin en admin.tecnyapp.com quedó inaccesible por horas porque
// VITE_API_URL en Netlify UI apuntaba a localhost (o estaba vacía). El bundle
// compiló OK, el deploy salió verde, pero en el browser todos los fetches
// tiraban "Sin conexión con el servidor" — imposible de detectar en logs
// porque no había ninguna señal server-side.
//
// Este gate replica el patrón del portal (frontend/vite.config.js) y agrega
// detección de "URL dev": además de ausencia, atrapamos valores con
// localhost / 127.0.0.1 / .local — configuraciones que se ven "válidas"
// pero rompen todos los clientes reales.
//
// `process.env.CONTEXT` lo setea Netlify:
//   - "production"     → main branch / prod site
//   - "branch-deploy"  → cualquier otra rama
//   - "deploy-preview" → PR builds
// En local (npm run dev/build), CONTEXT es undefined → gate skipeado.
const NETLIFY_CONTEXT = process.env.CONTEXT;
const RAW_VITE_API_URL = (process.env.VITE_API_URL || '').trim();
const HAS_VITE_API_URL = Boolean(RAW_VITE_API_URL);
const LOOKS_LIKE_DEV_URL = /localhost|127\.0\.0\.1|0\.0\.0\.0|\.local(:|\/|$)/i.test(RAW_VITE_API_URL);

if (NETLIFY_CONTEXT) {
  if (NETLIFY_CONTEXT !== 'production' && !HAS_VITE_API_URL) {
    throw new Error(
      `[admin vite.config] VITE_API_URL no está seteada para Netlify context "${NETLIFY_CONTEXT}". ` +
      `Configurala en netlify.toml ([context.<name>.environment]) o Site settings → ` +
      `Environment variables.`
    );
  }
  if (LOOKS_LIKE_DEV_URL) {
    throw new Error(
      `[admin vite.config] VITE_API_URL apunta a un host dev/local ("${RAW_VITE_API_URL}") ` +
      `en Netlify context "${NETLIFY_CONTEXT}". Los clientes reales no pueden ` +
      `resolver "localhost" ni IPs privadas desde su navegador. Corregí la variable ` +
      `en netlify.toml o Site settings → Environment variables.`
    );
  }
}
// ─────────────────────────────────────────────────────────────────────────

export default defineConfig({
  plugins: [
    react(),
    // sentryVitePlugin DEBE ir después de los demás plugins para procesar
    // los source maps ya generados. No-op sin SENTRY_AUTH_TOKEN (build
    // local / preview sin token siguen funcionando).
    SENTRY_TOKEN && sentryVitePlugin({
      org:       SENTRY_ORG,
      project:   SENTRY_PROJECT,
      authToken: SENTRY_TOKEN,
      release:   { name: BUILD_SHA },
      sourcemaps: {
        // Sube los .map a Sentry y los borra del bundle público — el admin
        // no debería exponer su source code (super-admin panel).
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
      silent:    false,
      telemetry: false,
    }),
  ].filter(Boolean),
  // Constantes inyectadas al bundle — accesibles desde reportError.js
  // como __BUILD_COMMIT__ y __BUILD_VERSION__. Serializadas con JSON.stringify
  // para que Vite las trate como string literals (no expresiones).
  define: {
    __BUILD_COMMIT__:  JSON.stringify(BUILD_SHA),
    __BUILD_VERSION__: JSON.stringify(BUILD_VER),
  },
  server: {
    port: 5174,
    strictPort: false,
  },
  preview: {
    port: 5174,
  },
  build: {
    outDir: 'dist',
    // 'hidden' cuando hay token: genera .map para que Sentry los suba, pero
    // NO agrega el "//# sourceMappingURL=..." al bundle público — el browser
    // no descarga los maps ni loguea warnings. Sentry lee los .map directo.
    // Sin token, sourcemap=false → no se generan (mantiene el bundle chico).
    sourcemap: SENTRY_TOKEN ? 'hidden' : false,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.js'],
    globals: true,
    css: false,
    // T-20 fix (audit 2026-06-22): coverage thresholds para que CI atrape
    // regresiones de cobertura. Se ejecuta con `npm run coverage`.
    // Thresholds calibrados al baseline actual + buffer mínimo de margen
    // para refactors menores. La idea NO es 100% — es no degradar.
    // Reusable: si la cobertura sube post-features futuros, subir los
    // thresholds aquí para evitar drift hacia abajo.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.{js,jsx}'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/*.test.{js,jsx}',
        'src/main.jsx',
        'src/test-setup.js',
      ],
      thresholds: {
        lines:      60,
        statements: 60,
        functions:  60,
        branches:   55,
      },
    },
  },
});

/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Admin console build. Separada del portal de usuarios para deployar en
// admin.tecnyapp.com con su propio bundle, su propio CSP, y sin exponer
// código super-admin al frontend público.
//
// Port 5174 elegido a propósito para no chocar con el portal (5173) cuando
// Lucas levanta los dos en paralelo en local.

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
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: false,
  },
  preview: {
    port: 5174,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
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

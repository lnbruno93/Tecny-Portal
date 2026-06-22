/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Admin console build. Separada del portal de usuarios para deployar en
// admin.tecnyapp.com con su propio bundle, su propio CSP, y sin exponer
// código super-admin al frontend público.
//
// Port 5174 elegido a propósito para no chocar con el portal (5173) cuando
// Lucas levanta los dos en paralelo en local.
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

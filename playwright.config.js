// Playwright config para iPro Portal.
//
// Lanza backend (puerto 3001) y frontend (puerto 5173) en paralelo vía
// `webServer` (array soportado desde Playwright 1.40+). Cada uno corre desde
// su carpeta y comparte la misma DATABASE_URL de test.
//
// El globalSetup corre UNA vez antes de toda la suite:
//   - aplica migraciones
//   - TRUNCATE de todas las tablas
//   - crea usuario `testadmin` / `testpass123` con permisos completos
//
// Decisiones:
//   - Solo chromium en CI/local. Firefox/webkit los sumamos cuando aporten;
//     hoy ralentizan sin agregar señal (el portal solo se usa en Chrome/Edge).
//   - trace: 'on-first-retry' — no cada test (mantiene CI rápido), pero si
//     algo falla y reintenta, queda el trace para debug.
//   - reporter html + list — list en stdout para CI; html como artifact.

const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

// Cargar e2e/.env si existe (DATABASE_URL del entorno de tests E2E).
// En CI las vars vienen del workflow; en local pueden venir de e2e/.env
// o de las env vars actuales (export DATABASE_URL=...).
require('dotenv').config({ path: path.resolve(__dirname, 'e2e/.env') });

// Vars de entorno compartidas por backend webServer y globalSetup.
const SHARED_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://lucasbruno@localhost:5432/ipro_e2e',
  JWT_SECRET: process.env.JWT_SECRET || 'e2e_test_jwt_secret_min_32_chars_padding_xyz',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '8h',
  // Test-only key: 64 hex chars (32 bytes). NO usar en prod.
  TWOFA_ENCRYPTION_KEY: process.env.TWOFA_ENCRYPTION_KEY ||
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  PORT: process.env.PORT || '3001',
  // Silenciar pino en backend durante e2e (menos ruido en stdout de webServer).
  LOG_LEVEL: 'warn',
};

module.exports = defineConfig({
  testDir: './e2e/specs',
  // En CI fail-fast con menos paciencia; en local damos margen.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,           // tests escriben a la MISMA DB compartida
  workers: 1,                     // serial — la DB es estado global
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  globalSetup: require.resolve('./e2e/helpers/globalSetup.js'),

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      // Arranca el backend vía starter custom (e2e/helpers/startBackend.js) que
      // neutraliza el `dotenv.config({override:true})` de backend/server.js antes
      // de cargarlo. Sin eso, server.js pisaría DATABASE_URL con el .env de dev
      // (apunta a ipro_preview) y los tests E2E correrían contra la DB equivocada.
      command: 'node e2e/helpers/startBackend.js',
      cwd: __dirname,
      url: 'http://localhost:3001/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: SHARED_ENV,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Vite en host fijo + strictPort para que falle ruidoso si :5173 ya está ocupado
      // (en lugar de subir en otro puerto y romper el baseURL del test).
      command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
      cwd: path.resolve(__dirname, 'frontend'),
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...process.env,
        VITE_API_URL: 'http://localhost:3001',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});

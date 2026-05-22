/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 30000,

  // Carga .env.test ANTES de que cualquier módulo sea requerido (incluido src/app.js)
  // Esto garantiza que DATABASE_URL apunte a ipro_test, no a ipro_portal
  setupFiles: ['./tests/helpers/setEnv.js'],

  // Cierra el pool singleton de PostgreSQL al terminar todas las suites —
  // evita el "Force exiting Jest" warning que aparecía con forceExit: true
  globalTeardown: './tests/helpers/globalTeardown.js',

  verbose: true,
};

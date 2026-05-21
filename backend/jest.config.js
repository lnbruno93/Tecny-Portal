/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 30000,
  // Carga .env.test ANTES de que cualquier módulo sea requerido (incluido src/app.js)
  // Esto garantiza que DATABASE_URL apunte a ipro_test, no a ipro_portal
  setupFiles: ['./tests/helpers/setEnv.js'],
  // Cerrar handles abiertos (pool de pg) al terminar
  forceExit: true,
  // Resumen limpio
  verbose: true,
};

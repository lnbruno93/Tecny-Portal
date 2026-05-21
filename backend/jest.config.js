/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 30000,
  // Cerrar handles abiertos (pool de pg) al terminar
  forceExit: true,
  // Resumen limpio
  verbose: true,
};

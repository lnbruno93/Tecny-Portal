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

  // ── Coverage configuration (T4 auditoría 2026-06) ─────────────────────────
  // Se activa al correr con --coverage. Threshold soft (no rompe local), pero
  // CI gatea con --coverage para que un PR que baje la cobertura falle.
  // Sin esto, archivos críticos podían quedar sin tests y el CI no lo detectaba.
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/scripts/**',      // utilidades one-shot
    '!src/config/database.js', // setup de conexión, difícil de mockear con valor
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'lcov', 'clover'],

  // Thresholds basados en el baseline actual (junio 2026):
  //   Statements 81.87% | Branches 71.7% | Functions 85.47% | Lines 85.81%
  // Los thresholds están unos puntos por debajo para tener un poco de margen
  // ante refactors menores. Si un PR baja la cobertura por debajo, CI lo
  // rechaza. La idea NO es alcanzar 100% — es no degradar lo que tenemos.
  coverageThreshold: {
    global: {
      lines:      80,
      statements: 78,
      functions:  82,
      branches:   65,
    },
  },
};

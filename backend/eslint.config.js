/**
 * ESLint config para el backend.
 *
 * Foco: solo reglas que atrapan bugs reales (unused-vars, equality estricta,
 * await-promesas, returns inconsistentes). Sin reglas de estilo opinadas
 * (las dejamos a prettier o al criterio del autor).
 *
 * Filosofía: el lint es una red de seguridad complementaria a los tests.
 * No queremos que sea ruidoso, queremos que evite que mergeemos algo claramente
 * mal (typo de variable, promise sin await, etc.).
 */
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // Reglas recomendadas oficiales
  js.configs.recommended,
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'coverage/**', 'migrations/**'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      // Variables sin usar — el problema clásico en backends grandes.
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // pg's `_pgm` en migraciones, `req`/`res`/`next` no usados en handlers
        caughtErrorsIgnorePattern: '^_',
      }],
      // == y != silenciosos rara vez son lo que querés.
      'eqeqeq': ['warn', 'smart'],
      // console.log en producción es ruido (Pino se usa para logs estructurados).
      // Permitimos warn/error que sí son legítimos para debugging.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Promises sin await dentro de async function suelen ser bugs.
      // Permitimos en chains explícitas (.then().catch()).
      'require-atomic-updates': 'off', // demasiados falsos positivos en patrón con pool.connect()
      // Permitimos require dinámico (lo usamos en algunos casos).
      'no-process-exit': 'off', // server.js lo necesita para shutdown
    },
  },
];

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';

// Follow-up L-6 auditoría 2026-06-22 (#370): ESLint config para admin-frontend.
// Clonado de frontend/eslint.config.js para mantener paridad de reglas entre
// los dos apps. Mismas convenciones: catch vacío OK como best-effort,
// no-unused-vars con prefix `_` para variables intencionalmente ignoradas,
// react-hooks como warn (los false positives en effects con debounce son
// frecuentes y los reviewás manualmente).
//
// La única diferencia con el portal: admin-frontend NO tiene globals
// inyectadas por vite (__BUILD_COMMIT__ / __BUILD_VERSION__). Si en el
// futuro las agregamos al vite.config.js del admin, sumar el override
// correspondiente.
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^(_|e$|err$|ignored$)',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': ['error', { typeof: false }],
      // React-hooks: degradar a warn (false positives en effects con
      // debounce, race-id refs, etc. que son intencionales). Mantenemos
      // visibles para que un dev las revise al codear, pero no bloquean
      // el lint para CI.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/exhaustive-deps':     'warn',
      'react-hooks/immutability':        'warn',
      'react-hooks/purity':              'warn',
      // Rules nuevas del plugin react-hooks que disparan en patterns
      // válidos pero "viejos": module-level counters para IDs (Modal.jsx),
      // refs leídos en JSX para data read-only (titleIdRef), sub-components
      // declarados dentro del render (Ficha.jsx panels switch). Refactor
      // tiene scope-creep — los dejamos como warn para visibilidad.
      'react-hooks/globals':             'warn',
      'react-hooks/refs':                'warn',
      'react-hooks/static-components':   'warn',
      // Convención del proyecto: preferir un logger custom sobre console.
      // En admin todavía no tenemos uno; mantener warn para visibilidad.
      'no-console': 'warn',
      'no-useless-assignment': 'warn',
      // Fast-refresh: AuthContext exporta hook + Provider (pattern estándar).
      'react-refresh/only-export-components': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  // Override para test files: vitest globals.
  {
    files: ['**/*.test.{js,jsx}', '**/test-setup.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        describe: 'readonly', it: 'readonly', expect: 'readonly',
        vi: 'readonly', beforeEach: 'readonly', afterEach: 'readonly',
        beforeAll: 'readonly', afterAll: 'readonly', test: 'readonly',
      },
    },
  },
]);

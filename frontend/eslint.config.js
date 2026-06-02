import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

// T5 auditoría 2026-06: config refinada para que el lint pueda activarse en CI.
// Cambios principales:
//   · Agregamos node globals (process, etc.) — vite.config.js y similares los usan.
//   · Vitest globals (describe/it/expect/vi/beforeEach) para archivos *.test.*.
//   · no-unused-vars con argsIgnorePattern: '^_' — convención estándar para
//     "marcar como no usado a propósito" sin error.
//   · no-empty con allowEmptyCatch:true — usamos catch vacío en patterns como
//     "fire-and-forget" o "best-effort" donde fallar es OK.
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
        ...globals.node, // process, console, Buffer, etc. (usados en vite.config.js, lib/api.js)
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Convención: variables/args con prefix `_` están explícitamente no usadas.
      // Útil para destructuring parcial: const { _ph, ...rest } = obj.
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^(_|e$|err$|ignored$)',
      }],
      // Catch vacío OK — usamos para best-effort que no debe romper el flow principal.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // __BUILD_COMMIT__ / __BUILD_VERSION__ son global constants inyectadas por vite.
      'no-undef': ['error', { typeof: false }],
      // React-hooks rules: degradar a warn por ahora. set-state-in-effect e
      // immutability detectan patterns que en muchos casos son intencionales
      // (debounce de filtros, sincronización con localStorage, etc.). Las
      // dejamos visibles pero no bloqueantes — un dev las revisa al codear.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/exhaustive-deps':     'warn',
      'react-hooks/immutability':        'warn',
      'react-hooks/purity':              'warn',
      // Convención del proyecto: usar reportError() del lib en lugar de console.error.
      // Bajamos a warn porque hay un par de lugares legítimos (test setup, etc.).
      'no-console': 'warn',
      // Útil pero no crítico; emite errores en patterns de defensa (ternarios anidados, etc.)
      'no-useless-assignment': 'warn',
      // Fast refresh — los Context providers exportan tanto el Provider component
      // como el hook (useToast, useConfirm, etc.). Pattern estándar de React.
      // El "fast refresh" no es crítico para CI, solo afecta DX en desarrollo.
      'react-refresh/only-export-components': 'warn',
      // Mejora útil pero no rompedora — re-throw con `{ cause: err }` es nice-to-have.
      'preserve-caught-error': 'warn',
    },
  },
  // Override para test files: vitest globals (describe/it/expect/vi/etc.)
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
  // Variables globales inyectadas por vite.config.js define:.
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      globals: {
        __BUILD_COMMIT__:  'readonly',
        __BUILD_VERSION__: 'readonly',
      },
    },
  },
])

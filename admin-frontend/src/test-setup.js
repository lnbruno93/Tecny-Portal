import '@testing-library/jest-dom/vitest';
import { expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

// Follow-up T-19 (audit 2026-06-22): expose `toHaveNoViolations` matcher
// for a11y tests. Cada *.test.jsx puede llamar:
//   import { axe } from 'vitest-axe';
//   expect(await axe(container)).toHaveNoViolations();
// Smoke tests por screen viven en src/__tests__/a11y.test.jsx.
expect.extend(axeMatchers);

// jsdom 29 dejó de incluir localStorage por default (https://github.com/jsdom/jsdom/pull/3669
// y siguientes). Tampoco lo expone Node 22 sin --localstorage-file (es
// experimental). Polyfill manual con un Map en memoria — suficiente para
// tests, y se resetea entre archivos porque vitest crea un jsdom nuevo por
// archivo. Si en el futuro algún test necesita persistencia o mock más fino,
// migrar a un mock por test con vi.spyOn.
//
// Definimos en window Y en globalThis porque distinto código accede de
// distinta forma:
//   - lib/api.js → localStorage.getItem(...) (acceso global, sin window.)
//   - tests → localStorage.clear() (también global)
//   - React DOM → window.localStorage (a veces, internamente)
function createStorageMock() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => { store.clear(); },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
}

if (typeof window !== 'undefined') {
  if (!window.localStorage) {
    Object.defineProperty(window, 'localStorage', {
      value: createStorageMock(),
      writable: true,
      configurable: true,
    });
  }
  if (!window.sessionStorage) {
    Object.defineProperty(window, 'sessionStorage', {
      value: createStorageMock(),
      writable: true,
      configurable: true,
    });
  }
}
// Algunos módulos hacen `localStorage.foo(...)` sin window., así que también
// lo exponemos en globalThis. Node 22 imprime un ExperimentalWarning si no
// está definido — el assignment lo silencia (no usamos el built-in nativo).
if (typeof globalThis.localStorage === 'undefined' && typeof window !== 'undefined') {
  globalThis.localStorage = window.localStorage;
}
if (typeof globalThis.sessionStorage === 'undefined' && typeof window !== 'undefined') {
  globalThis.sessionStorage = window.sessionStorage;
}

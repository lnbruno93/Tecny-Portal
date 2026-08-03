import '@testing-library/jest-dom/vitest';
import { expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

// Follow-up T-19 (audit 2026-06-22): expose `toHaveNoViolations` matcher
// for a11y tests. Cada *.test.jsx puede llamar:
//   import { axe } from 'vitest-axe';
//   expect(await axe(container)).toHaveNoViolations();
// Smoke tests por screen viven en src/__tests__/a11y.test.jsx.
expect.extend(axeMatchers);

// jsdom 30 no incluye localStorage por default (https://github.com/jsdom/jsdom/pull/3669
// y siguientes). Tampoco lo expone Node 22+ sin --localstorage-file (es
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
//
// 2026-08-02 (task #287): defineProperty INCONDICIONAL. El check previo
// `if (typeof globalThis.localStorage === 'undefined')` fallaba en Node
// 22+ — el mero acto de evaluar `typeof globalThis.localStorage` toca el
// built-in experimental del runtime y emite `ExperimentalWarning:
// localStorage is not available because --localstorage-file was not
// provided` por cada worker de vitest (~10 warnings por corrida en
// admin-frontend). Sobreescribir siempre con el mock ni siquiera necesita
// el check y elimina el warning limpio. Mismo pattern que
// frontend/src/test-setup.js.
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

const defineStorage = (obj, name) => {
  try {
    Object.defineProperty(obj, name, {
      value: createStorageMock(),
      writable: true,
      configurable: true,
    });
  } catch { /* noop — algunos runtimes bloquean redefinir */ }
};

defineStorage(globalThis, 'localStorage');
defineStorage(globalThis, 'sessionStorage');
if (typeof window !== 'undefined') {
  defineStorage(window, 'localStorage');
  defineStorage(window, 'sessionStorage');
}

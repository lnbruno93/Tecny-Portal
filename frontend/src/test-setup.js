// Setup de tests — localStorage en memoria (evita el quirk de jsdom con origin opaco).
const store = new Map();
const localStorageMock = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => { store.clear(); },
};
const def = (obj) => {
  try { Object.defineProperty(obj, 'localStorage', { value: localStorageMock, configurable: true, writable: true }); } catch { /* noop */ }
};
def(globalThis);
if (globalThis.window) def(globalThis.window);

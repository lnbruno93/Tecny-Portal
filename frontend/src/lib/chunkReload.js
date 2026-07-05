// Manejo de "chunk viejo tras un deploy".
//
// La app carga pantallas con import() dinámico (code-splitting). Cuando se
// publica un deploy nuevo, los chunks cambian de hash; una pestaña que tenía
// la versión anterior pide un chunk que ya no existe y el server devuelve el
// index.html (text/html) en vez del JS → el import falla. La solución correcta
// es recargar la página una vez para tomar el bundle nuevo.

// ¿El error es de carga de un chunk (no un bug de la pantalla)?
//
// 2026-07-05: ampliado con los 2 patrones que aparecían en Sentry sin
// matchear (issues 7515527708 y 7514038974) cuando un chunk lazy resolvía
// undefined en Vite tras fallar el fetch. React internamente hace
// `moduleResult.default` y tira uno de estos:
//
//   Chrome:  Cannot read properties of undefined (reading 'default')
//   Safari:  undefined is not an object (evaluating 'e._result.default')
//
// También agregamos el catch-all para el mensaje de lazyWithRetry.js:
// "Dynamic import resolved to invalid module".
export function isChunkLoadError(error) {
  const msg = (error && (error.message || String(error))) || '';
  return /valid JavaScript MIME type|dynamically imported module|Importing a module script failed|Loading chunk\s+\S+\s+failed|Failed to fetch dynamically imported|Cannot read properties of undefined \(reading 'default'\)|_result\.default|Dynamic import resolved to invalid module/i.test(msg);
}

// Recarga la página UNA sola vez (guarda en sessionStorage para evitar loops:
// si tras recargar el chunk sigue fallando, ya es un problema real y no insiste).
let reloadedThisSession = false;
export function reloadForNewVersion() {
  const KEY = 'iproChunkReloadAt';
  const last = Number(sessionStorage.getItem(KEY) || 0);
  if (reloadedThisSession || Date.now() - last < 10000) return false;
  reloadedThisSession = true;
  sessionStorage.setItem(KEY, String(Date.now()));
  window.location.reload();
  return true;
}

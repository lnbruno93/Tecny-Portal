// Manejo de "chunk viejo tras un deploy".
//
// La app carga pantallas con import() dinámico (code-splitting). Cuando se
// publica un deploy nuevo, los chunks cambian de hash; una pestaña que tenía
// la versión anterior pide un chunk que ya no existe y el server devuelve el
// index.html (text/html) en vez del JS → el import falla. La solución correcta
// es recargar la página una vez para tomar el bundle nuevo.

// ¿El error es de carga de un chunk (no un bug de la pantalla)?
export function isChunkLoadError(error) {
  const msg = (error && (error.message || String(error))) || '';
  return /valid JavaScript MIME type|dynamically imported module|Importing a module script failed|Loading chunk\s+\S+\s+failed|Failed to fetch dynamically imported/i.test(msg);
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

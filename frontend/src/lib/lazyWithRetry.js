// lazyWithRetry — wrapper alrededor de React.lazy con retry defensivo.
//
// Motivación (bug prod 2026-06 → 2026-07, Sentry issues 7515527708 y
// 7514038974): con code-splitting via `import()` dinámico, un chunk puede
// fallar silenciosamente por 3 causas típicas:
//
//   1. Deploy nuevo mientras el user tenía tab abierto → hash cambió, el
//      chunk viejo devuelve 404 o el index.html (text/html) en vez del JS.
//   2. Network flap momentáneo (2G / wifi malo) → el fetch del chunk falla.
//   3. Service Worker cacheando un manifest viejo con paths que ya no existen.
//
// El error que llega a React NO es "Failed to fetch" (que sí matchearía
// isChunkLoadError). React se despierta el component Lazy con el resultado
// del import, y si `moduleResult` es undefined (Vite a veces resuelve así
// ante fallo del fetch), React internamente hace `moduleResult.default` y
// tira uno de estos según el browser:
//
//   Chrome:  Cannot read properties of undefined (reading 'default')
//   Safari:  undefined is not an object (evaluating 'e._result.default')
//
// Estos errores NO matchean los regexes de isChunkLoadError, así que el
// ErrorBoundary los reporta como "bug real" y no dispara el reload.
//
// Estrategia:
//
//   1. Retry inmediato con backoff exponencial cortito (0ms, 500ms, 1500ms).
//      El 99% de los network flaps se resuelven en el 2do intento.
//   2. Si tras N intentos sigue fallando, propagamos el error. El
//      ErrorBoundary lo va a catchear y — con la ampliación de patterns en
//      chunkReload.js — va a disparar el reload para tomar el bundle nuevo.
//
// La retry no persiste entre re-renders porque `lazy()` cachea el
// resultado del primer llamado. Si el primer intento falla, React llama
// de nuevo al factory pasado a `lazy` — y ahí volvemos a intentar (con
// retries frescos).

import { lazy } from 'react';

const DEFAULT_RETRIES = 2;
const BACKOFFS_MS = [0, 500, 1500]; // 3 intentos totales (initial + 2 retries)

/**
 * Envuelve un import() dinámico con retry defensivo.
 *
 * Uso:
 *   const Screen = lazyWithRetry(() => import('./screens/X'));
 *
 * Cuando el import falla, reintenta hasta `retries` veces con backoff antes
 * de propagar el error.
 *
 * @param {() => Promise<{ default: React.ComponentType }>} factory
 * @param {number} [retries=2]
 */
export function lazyWithRetry(factory, retries = DEFAULT_RETRIES) {
  return lazy(async () => {
    let lastErr;
    // +1 porque el initial cuenta como "intento 0"
    for (let attempt = 0; attempt <= retries; attempt++) {
      const delay = BACKOFFS_MS[attempt] ?? BACKOFFS_MS[BACKOFFS_MS.length - 1];
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        const mod = await factory();
        // Guard extra: si el import resolvió con `undefined` (Vite bug conocido
        // ante fallo silencioso), NO devolvemos eso a React — sería el patrón
        // exacto del `_result.default` en Sentry. Forzamos error para retry.
        if (!mod || typeof mod !== 'object') {
          throw new Error('Dynamic import resolved to invalid module (empty or non-object)');
        }
        return mod;
      } catch (err) {
        lastErr = err;
        // No hace falta log a Sentry acá — el ErrorBoundary lo hace si todo
        // falla, con contexto de qué chunk pidió el user. Retryamos silencioso.
      }
    }
    // Todos los reintentos fallaron. Propagamos el error para que el
    // ErrorBoundary lo catchee. isChunkLoadError() lo va a matchear (ver
    // chunkReload.js) y va a disparar reloadForNewVersion().
    throw lastErr;
  });
}

export default lazyWithRetry;

'use strict';

// features.js — middleware que decora `req.features` con un resolver de
// flags per-request memoizado.
//
// F3 del Rec proactiva #3 (2026-07-20). Complementa el resolver de F1
// (`lib/featureFlags.js`) y los endpoints admin de F2 (`superAdmin.js`).
//
// ── Uso ────────────────────────────────────────────────────────────────
//
//   app.use('/api/comprobantes', requireAuth, loadFeatures(), comprobantesRoutes);
//
//   // dentro del route:
//   if (await req.features.enabled('storage_r2_comprobantes')) {
//     ...
//   }
//
// ── Diseño ─────────────────────────────────────────────────────────────
//
// El middleware es "opt-in por route" (no global) para no forzar Overhead
// en endpoints públicos/health. Es LAZY: no fetchea nada hasta que se
// llama `req.features.enabled(name)`. Cada nombre se resuelve máximo una
// vez por request (memo local) — repetir la misma llamada dentro del
// handler es free.
//
// El resolver por dentro es `isFeatureEnabled(name, req.tenantId)` — hereda
// toda la precedencia tenant > plan > rollout > global + cache Redis 5min.
//
// Fail-safe: si el lookup falla, devuelve false (fail-closed). Idéntico
// contrato que `isFeatureEnabled`.
//
// Tests: se importa el middleware directo y se ejerce con un fake req
// (ver tests/featuresMiddleware.test.js).

const { isFeatureEnabled } = require('../lib/featureFlags');

/**
 * Factory que devuelve el middleware Express. Se usa como `loadFeatures()`
 * en `app.use(...)`. Retorna una nueva instancia por invocación, con memo
 * per-request nuevo — el memo NO se comparte entre requests.
 *
 * @returns {import('express').RequestHandler}
 */
function loadFeatures() {
  return function loadFeaturesMiddleware(req, _res, next) {
    // Memo per-request. Map<string, Promise<boolean>>. Guardamos la promesa
    // (no el valor) para que llamadas concurrentes al mismo flag dentro del
    // mismo request compartan el resolve (evita doble hit a Redis/DB).
    const memo = new Map();

    req.features = {
      /**
       * Resuelve un flag para el tenant del request actual. Memoizado
       * per-request — la primera llamada hace el lookup, las siguientes
       * devuelven el resultado cacheado (sin round-trip).
       *
       * @param {string} name
       * @returns {Promise<boolean>}
       */
      enabled(name) {
        if (memo.has(name)) return memo.get(name);
        // req.tenantId puede ser null si el middleware se monta antes de
        // requireAuth (uso raro pero soportado). isFeatureEnabled maneja
        // ese caso: cae al default global.
        const promise = isFeatureEnabled(name, req.tenantId ?? null);
        memo.set(name, promise);
        return promise;
      },

      /**
       * Resuelve una lista de flags de una vez. Útil para el endpoint
       * `GET /api/features` que devuelve el map completo, o para cualquier
       * handler que necesite conocer varios flags upfront.
       *
       * Ejecuta en paralelo — la latencia es la del flag más lento, no la
       * suma. Con cache Redis caliente son ~1ms cada uno.
       *
       * @param {string[]} names
       * @returns {Promise<Record<string, boolean>>}
       */
      async resolveAll(names) {
        const values = await Promise.all(names.map((n) => this.enabled(n)));
        const out = {};
        names.forEach((n, i) => { out[n] = values[i]; });
        return out;
      },
    };

    next();
  };
}

module.exports = loadFeatures;

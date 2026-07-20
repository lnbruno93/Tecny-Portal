'use strict';

// features-public.js — endpoint `GET /api/features` que devuelve el map
// resuelto de todos los feature flags para el tenant del request actual.
//
// F3 del Rec proactiva #3 (2026-07-20).
//
// ── Contrato ───────────────────────────────────────────────────────────
//
//   GET /api/features
//   Headers: Authorization: Bearer <jwt>
//
//   200 →
//   {
//     "features": {
//       "audit_async_enabled": false,
//       "storage_r2_comprobantes": true,
//       "storage_r2_productos": false,
//       ...
//     },
//     "resolved_at": "2026-07-20T18:45:00.123Z"
//   }
//
//   401 → sin JWT válido (requireAuth).
//   500 → error resolviendo (raro, isFeatureEnabled es fail-safe).
//
// ── Diseño vs GET /api/feature-flags viejo ─────────────────────────────
//
// El viejo endpoint (feature-flags.js) devuelve `{ flags: { name: bool } }`
// leyendo SOLO `feature_flags.enabled` global — no considera overrides
// tenant/plan/rollout. Sirvió antes de que existiera el resolver de F1.
//
// Este endpoint nuevo USA el resolver (`req.features.enabled(name)`), así
// que respeta la precedencia completa: tenant > plan > rollout > global.
//
// Coexisten los dos:
//   · Consumers frontend nuevos → `/api/features` (respeta overrides).
//   · El viejo queda por back-compat hasta migrar los consumers restantes.
//
// El shape es DISTINTO a propósito (`features` vs `flags`, más `resolved_at`)
// para que un consumer nuevo no se confunda con un response viejo.
//
// ── Perf ───────────────────────────────────────────────────────────────
//
// La lista de flags se lee de `feature_flags` (LIMIT ninguno — hay <100).
// Cada flag se resuelve via `isFeatureEnabled` que tiene cache Redis 5min.
// En path caliente: 1 query DB (list de flags) + N cache-hits paralelos.
// Con Redis down: 1 query + N queries paralelas (aún así <100ms).
//
// ── resolved_at ────────────────────────────────────────────────────────
//
// Ayuda al frontend a saber cuán vieja es la respuesta (si cachea).
// No es la fecha de última modificación — es "cuando el server resolvió".
// Sirve para debug ("¿esta respuesta vino cacheada de hace 10 min?").

const router = require('express').Router();
const db = require('../config/database');
const logger = require('../lib/logger');
const loadFeatures = require('../middleware/features');

// El router monta su propio loadFeatures() — así los consumers que hagan
// `app.use('/api/features', requireAuth, featuresPublicRoutes)` no tienen
// que acordarse de agregar el middleware por separado.
router.use(loadFeatures());

router.get('/', async (req, res, next) => {
  try {
    // Lista de flags — leemos SOLO `name` para el resolver (que ya tiene
    // su propia lógica de precedencia). NO exponemos `description` acá
    // porque es metadata operativa — el admin lo ve en la UI de F2.
    const { rows } = await db.adminQuery(async (client) => {
      const r = await client.query(
        `SELECT name FROM feature_flags ORDER BY name`
      );
      return r;
    });

    const names = rows.map((r) => r.name);
    const features = await req.features.resolveAll(names);

    res.json({
      features,
      resolved_at: new Date().toISOString(),
    });
  } catch (err) {
    // isFeatureEnabled es fail-safe (devuelve false en error), así que
    // llegar acá implica un fallo raro (ej. DB down antes del list).
    logger.warn({ err: err.message, tenantId: req.tenantId }, '[features-public] error resolviendo');
    next(err);
  }
});

module.exports = router;

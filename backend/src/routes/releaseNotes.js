// Release notes — endpoints públicos que consume el portal del cliente
// (task #141, 2026-07-16).
//
// Contexto: en 48h se mergearon 13 PRs con fixes/features visibles al
// usuario. El cliente no se entera → cuando algo cambia genera dudas
// ("¿esto es bug o mejora?") por WhatsApp. Solución: un "Novedades" con
// badge en el sidebar y una vista simple con la lista.
//
// La tabla `release_notes` es GLOBAL (mismas notas para todos los tenants,
// no per-tenant). Por eso no hay `withTenant()` acá — leemos con
// `db.query` plano. La escritura/CRUD vive en superAdmin.js (solo Lucas).
//
// Endpoints (todos requireAuth, sin capability específica — cualquier
// user autenticado del portal puede ver novedades):
//
//   GET  /api/release-notes                → lista (últimas N, default 50)
//   GET  /api/release-notes/count-unseen   → count de notas nuevas desde
//                                            users.last_seen_release_notes_at
//   POST /api/release-notes/mark-seen      → setea last_seen = NOW() para
//                                            el user actual (limpia el badge)
//
// Nota sobre email_verified: el middleware requireAuth bloquea escrituras
// (POST/PUT/PATCH/DELETE) para users no verificados excepto rutas /api/auth/*.
// Eso implica que mark-seen (POST) fallará para users unverified — pero
// es un caso muy edge (user recién registrado que no verificó email todavía
// abriendo /novedades) y el 403 es aceptable: primero verificás email,
// después usás el portal.

const router = require('express').Router();
const db = require('../config/database');

// Cap defensivo: aunque no exponemos paginación, evitamos que un cliente
// pida 100k rows con un query param custom. 200 es holgado (agregamos ~5
// notas/semana → 200 = ~10 meses de historia).
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// GET /api/release-notes → lista pública (todos los tenants ven lo mismo).
// Order by publicado_en DESC (más recientes primero).
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT)
    );
    const { rows } = await db.query(
      `SELECT id, titulo, descripcion, tipo, publicado_en
         FROM release_notes
        ORDER BY publicado_en DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ release_notes: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/release-notes/count-unseen → count de notas publicadas DESPUÉS
// de users.last_seen_release_notes_at (NULL = nunca vio → count total).
// El frontend lo pega cada vez que carga el Shell para el badge del menú.
//
// Perf: es un COUNT sobre release_notes (tabla pequeña, decenas de rows)
// con filtro sobre `publicado_en` que tiene índice DESC. Sub-ms.
router.get('/count-unseen', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count
         FROM release_notes rn
        WHERE rn.publicado_en > COALESCE(
                (SELECT last_seen_release_notes_at FROM users WHERE id = $1),
                'epoch'::timestamptz
              )`,
      [req.user.id]
    );
    res.json({ count: rows[0]?.count || 0 });
  } catch (err) {
    next(err);
  }
});

// POST /api/release-notes/mark-seen → setea last_seen_release_notes_at = NOW()
// para el user actual. Idempotente: pegar 2 veces seguidas no rompe nada,
// el segundo call bumpea el timestamp sin efecto visible.
//
// Llamado desde el portal cuando el user abre la pantalla /novedades —
// después de esto el badge se apaga hasta la próxima nota nueva.
router.post('/mark-seen', async (req, res, next) => {
  try {
    await db.query(
      `UPDATE users SET last_seen_release_notes_at = NOW() WHERE id = $1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

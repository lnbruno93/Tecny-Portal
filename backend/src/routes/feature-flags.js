// Feature flags API (M-08 GRAN auditoría 2026-06-10).
//
// Endpoints:
//   GET    /api/feature-flags          — usuario logueado: devuelve map { name: bool }.
//   GET    /api/feature-flags/admin    — admin: array completo con metadata.
//   POST   /api/feature-flags          — admin: crear flag.
//   PATCH  /api/feature-flags/:name    — admin: update enabled/description.
//   DELETE /api/feature-flags/:name    — admin: borrado HARD.
//
// Diseño minimalista (ver migración):
//   · Solo on/off global. Sin targeting por user/role/rollout %, sin variantes.
//     Si en el futuro se necesita, se extiende la tabla.
//   · GET público cacheado in-memory con TTL 60s — el frontend lo lee al mount.
//     Trade-off: cuando un admin cambia un flag, los otros procesos lo ven
//     recién al expirar el TTL (≤60s). Decisión consciente, igual al patrón
//     del dashboard de ventas (TANDA 3 P-05). Para invalidación cross-instance
//     real haría falta Redis pub/sub — fuera de scope.
//   · DELETE hard (no soft-delete): los flags son metadata operativa, no datos
//     del negocio. Si querés "apagar y conservar el row para historial", usá
//     PATCH con enabled=false. La audit_log queda con el antes igual.
//   · Audit dentro de TX (TANDA 2 S-05 patrón): create/update/delete persisten
//     el INSERT en audit_logs en la misma TX → no hay "cambio commiteado sin
//     audit" si el proceso muere o hay timeout de red.
//   · `req.user.role === 'admin'` directo: ser admin no es un permiso del enum
//     TOOLS (Lucas es el único admin operativo). El middleware adminOnly del
//     repo ya hace este check; lo aplicamos a las 4 rutas admin con un guard
//     interno (no podemos usar el middleware global del router porque el
//     primer GET / es accesible a cualquier user logueado).

const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const logger = require('../lib/logger');
const { createCachedFetcher } = require('../lib/cacheTtl');
const { createFlagSchema, updateFlagSchema, NAME_REGEX, NAME_MAX } = require('../schemas/featureFlags');

// Guard inline (no usamos el middleware adminOnly global porque el GET /
// público es accesible a cualquier user con sesión, sin importar el rol).
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Requiere rol admin para gestionar feature flags' });
  }
  next();
}

// Cache TTL 60s del GET público. El frontend pide al mount y re-fetch on user
// change (login/logout) — la mayoría de los hits caen en el caché. En tests
// el cache se desactiva (createCachedFetcher detecta NODE_ENV=test).
const fetchFlagsMap = createCachedFetcher('feature_flags:map', 60_000, async () => {
  const { rows } = await db.query('SELECT name, enabled FROM feature_flags');
  const flags = {};
  for (const r of rows) flags[r.name] = r.enabled;
  return { flags };
});

// GET /api/feature-flags — accesible a cualquier user logueado.
// Devuelve un map name → bool, fácil de consumir desde el frontend.
router.get('/', async (_req, res, next) => {
  try {
    res.json(await fetchFlagsMap());
  } catch (err) { next(err); }
});

// GET /api/feature-flags/admin — array completo con metadata para la UI admin
// (que todavía no existe — está fuera de scope de este PR pero la API ya está
// lista para cuando Lucas la pida).
router.get('/admin', requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT name, enabled, description, created_at, updated_at
         FROM feature_flags ORDER BY name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/feature-flags — crear flag.
// Audit con datos completos del row creado. 201 + el row.
router.post('/', requireAdmin, validate(createFlagSchema), async (req, res, next) => {
  const { name, enabled, description } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO feature_flags (name, enabled, description)
       VALUES ($1, $2, $3)
       RETURNING name, enabled, description, created_at, updated_at`,
      [name, enabled, description ?? null]
    );
    // registro_id en audit_logs es INTEGER y la PK de feature_flags es `name`
    // (varchar). Pasamos null en registro_id y dejamos el `name` dentro del
    // payload JSON via `despues.name` para trazabilidad por queries del audit.
    await audit(client, 'feature_flags', 'INSERT', null, {
      despues: rows[0],
      user_id: req.user.id,
      req,
    });
    await client.query('COMMIT');
    // Invalidamos el cache local — la otra réplica sigue su TTL natural.
    fetchFlagsMap.invalidate();
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // 23505 = unique_violation: el flag ya existe. El handler global lo mapea
    // a 409 con un mensaje genérico — acá afinamos el copy.
    if (err.code === '23505') {
      return res.status(409).json({ error: `El flag "${name}" ya existe` });
    }
    next(err);
  } finally { client.release(); }
});

// PATCH /api/feature-flags/:name — update enabled y/o description.
// Audit con before/after. 404 si no existe.
router.patch('/:name', requireAdmin, validate(updateFlagSchema), async (req, res, next) => {
  const name = String(req.params.name || '');
  // Validamos también el name del path para no permitir lookups con caracteres
  // raros (defensa en profundidad — la query es parametrizada igual).
  if (!NAME_REGEX.test(name) || name.length > NAME_MAX) {
    return res.status(400).json({ error: 'name inválido en el path' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query(
      'SELECT name, enabled, description, created_at, updated_at FROM feature_flags WHERE name = $1 FOR UPDATE',
      [name]
    );
    if (!before[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `Flag "${name}" no encontrado` });
    }

    const sets = [];
    const params = [];
    if (req.body.enabled !== undefined) {
      params.push(req.body.enabled);
      sets.push(`enabled = $${params.length}`);
    }
    if (req.body.description !== undefined) {
      params.push(req.body.description); // puede ser null (clear) o string
      sets.push(`description = $${params.length}`);
    }
    sets.push('updated_at = NOW()');
    params.push(name);
    const { rows: after } = await client.query(
      `UPDATE feature_flags SET ${sets.join(', ')} WHERE name = $${params.length}
       RETURNING name, enabled, description, created_at, updated_at`,
      params
    );

    await audit(client, 'feature_flags', 'UPDATE', null, {
      antes: before[0],
      despues: after[0],
      user_id: req.user.id,
      req,
    });
    await client.query('COMMIT');
    fetchFlagsMap.invalidate();
    // P-04 Fase 3.1: si cambió `audit_async_enabled`, invalidamos cross-instance
    // el cache de audit.js. Sin esto las 2 réplicas siguen sus TTL natural de
    // 60s — el flag tarda hasta 1 min en propagar. Con esto, <100ms para todas.
    // El invalidate es await porque puede llamar redis.del (es async).
    if (name === 'audit_async_enabled' && req.body.enabled !== undefined) {
      try { await audit._clearAsyncCache(); }
      catch (err) { logger.warn({ err: err.message }, 'audit cache invalidate falló (best-effort)'); }
    }
    res.json(after[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

// DELETE /api/feature-flags/:name — borrado HARD.
// Los flags son metadata, no datos del negocio. 204 (no content) si OK.
router.delete('/:name', requireAdmin, async (req, res, next) => {
  const name = String(req.params.name || '');
  if (!NAME_REGEX.test(name) || name.length > NAME_MAX) {
    return res.status(400).json({ error: 'name inválido en el path' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query(
      'SELECT name, enabled, description, created_at, updated_at FROM feature_flags WHERE name = $1 FOR UPDATE',
      [name]
    );
    if (!before[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `Flag "${name}" no encontrado` });
    }
    await client.query('DELETE FROM feature_flags WHERE name = $1', [name]);
    await audit(client, 'feature_flags', 'DELETE', null, {
      antes: before[0],
      user_id: req.user.id,
      req,
    });
    await client.query('COMMIT');
    fetchFlagsMap.invalidate();
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

module.exports = router;

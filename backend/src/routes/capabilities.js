// routes/capabilities.js — endpoints de la nueva pantalla de Usuarios
// (F2). Tres endpoints:
//
//   GET  /api/capabilities/catalog    → catálogo global (45 caps), lectura
//                                       libre para todo user autenticado.
//   GET  /api/capabilities/users      → lista de users del tenant + rol +
//                                       overrides + caps efectivas.
//                                       adminOnly.
//   PUT  /api/capabilities/users/:id  → update rol + overrides del user.
//                                       adminOnly. Bumpea password_changed_at
//                                       del target para invalidar su JWT.
//
// 2026-06-23 F1: nuevo router. NO interfiere con /api/usuarios (sistema
// viejo) — ambos coexisten hasta F4.

const router = require('express').Router();
const db = require('../config/database');
const adminOnly = require('../middleware/adminOnly');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const logger = require('../lib/logger');
const { PANTALLAS, ROLES_VALIDOS } = require('../lib/capabilityCatalog');
const { resolveCaps } = require('../lib/capabilities');
const { isBypassRole } = require('../lib/roleDefaults');
const { updateUserCapabilitiesSchema } = require('../schemas/capabilities');
const userAuthCache = require('../lib/userAuthCache');

// ─── GET /api/capabilities/catalog ────────────────────────────────────────
// Devuelve el catálogo de capabilities agrupadas por pantalla. NO requiere
// adminOnly — todo user autenticado puede ver el catálogo (no es info
// sensible, sirve para que la UI sepa qué slugs existen).
//
// Estrategia: leemos de DB en lugar de servir la constante de
// capabilityCatalog.js. Razón: si una migration agrega una capability
// nueva pero el código backend no se redeployó (escenario edge), la DB
// igual la tiene — la UI ve la nueva capability con su orden correcto.
// Costo: 1 query de ~45 filas, sin RLS (capability_catalog es global).
router.get('/catalog', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT slug, pantalla, pantalla_label, capability, capability_label, orden
         FROM capability_catalog
        ORDER BY orden ASC`,
    );

    // Agrupar por pantalla manteniendo el orden del query.
    const byPantalla = new Map();
    for (const r of rows) {
      if (!byPantalla.has(r.pantalla)) {
        byPantalla.set(r.pantalla, {
          id: r.pantalla,
          label: r.pantalla_label,
          capabilities: [],
        });
      }
      byPantalla.get(r.pantalla).capabilities.push({
        slug: r.slug,
        id: r.capability,
        label: r.capability_label,
      });
    }

    res.json({
      pantallas: Array.from(byPantalla.values()),
      roles: ROLES_VALIDOS,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/capabilities/users ──────────────────────────────────────────
// Lista de users del tenant + rol + overrides + caps efectivas resueltas.
// Para uso de la pantalla de Usuarios (F2) — muestra una grilla con
// el estado actual de cada user.
//
// adminOnly: solo el admin del tenant puede ver/editar permisos.
router.get('/users', adminOnly, async (req, res, next) => {
  try {
    const { users, roles, overrides } = await db.withTenant(req.tenantId, async (client) => {
      // 1) Users del tenant (mismo filtro que usuarios.js).
      const { rows: users } = await client.query(
        `SELECT u.id, u.nombre, u.username, u.email, u.role, u.created_at
           FROM users u
           JOIN tenant_users tu ON tu.user_id = u.id
          WHERE tu.tenant_id = $1 AND u.deleted_at IS NULL
          ORDER BY u.nombre LIMIT 200`,
        [req.tenantId],
      );

      if (users.length === 0) {
        return { users, roles: [], overrides: [] };
      }

      const userIds = users.map(u => u.id);

      // 2) Roles base de cada user.
      const { rows: roles } = await client.query(
        `SELECT user_id, rol FROM tenant_user_roles
          WHERE tenant_id = $1 AND user_id = ANY($2)`,
        [req.tenantId, userIds],
      );

      // 3) Todos los overrides del tenant para estos users.
      const { rows: overrides } = await client.query(
        `SELECT user_id, capability_slug, enabled
           FROM user_capabilities
          WHERE tenant_id = $1 AND user_id = ANY($2)`,
        [req.tenantId, userIds],
      );

      return { users, roles, overrides };
    });

    // Resolver por user — agrupamos roles + overrides por user_id.
    const rolByUser  = new Map(roles.map(r => [r.user_id, r.rol]));
    const ovByUser   = new Map();
    for (const o of overrides) {
      if (!ovByUser.has(o.user_id)) ovByUser.set(o.user_id, []);
      ovByUser.get(o.user_id).push({
        capability_slug: o.capability_slug,
        enabled: o.enabled,
      });
    }

    const out = users.map(u => {
      const rol = rolByUser.get(u.id) || 'custom';
      const userOverrides = ovByUser.get(u.id) || [];
      const caps = resolveCaps(rol, userOverrides);
      return {
        id: u.id,
        nombre: u.nombre,
        username: u.username,
        email: u.email,
        legacy_role: u.role, // 'admin' | 'op' — viene del sistema viejo
        rol,
        overrides: userOverrides,
        // caps_efectivas: null = bypass (owner/admin), array = lista explícita.
        caps_efectivas: caps === null ? null : Array.from(caps),
      };
    });

    res.json(out);
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/capabilities/users/:id ──────────────────────────────────────
// Update rol + overrides del user target. Body:
//   { rol?: 'admin'|'vendedor'|..., overrides?: [{capability_slug, enabled}, ...] }
//
// Comportamiento:
//   - rol: UPSERT en tenant_user_roles. Si no había fila, se crea con
//     este rol. Si había, se updatea.
//   - overrides: reemplazo TOTAL — DELETE todos los existentes y reinserto
//     la lista nueva. Si el body manda overrides=[], el user queda sin
//     overrides (solo el default del rol manda).
//
// Side effects:
//   - Bumpear password_changed_at del target → invalida su JWT en curso.
//     Mismo patrón que el usuarios.js viejo (cambiar role/perms requiere
//     re-login).
//   - Invalidar userAuthCache del target.
//   - Audit log.
//
// Guards:
//   - adminOnly: solo admin del tenant.
//   - El user target debe pertenecer al tenant (EXISTS tenant_users).
//   - No se puede cambiar rol a 'owner' (solo signup asigna owner).
//   - No se puede degradar al único owner del tenant (deja al tenant sin
//     dueño). Check explícito antes del UPDATE.
router.put('/users/:id', adminOnly, validate(updateUserCapabilitiesSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rol, overrides } = req.body;

    const result = await db.withTenant(req.tenantId, async (client) => {
      // Verificar que el target pertenece al tenant.
      const { rows: own } = await client.query(
        `SELECT u.id, u.nombre
           FROM users u
           JOIN tenant_users tu ON tu.user_id = u.id
          WHERE u.id = $1 AND tu.tenant_id = $2 AND u.deleted_at IS NULL`,
        [id, req.tenantId],
      );
      if (!own[0]) {
        return { status: 404, body: { error: 'Usuario no encontrado' } };
      }

      // Leer rol actual del target (puede no existir si es user pre-F1
      // sin backfill — tratamos como custom para el "antes" del audit).
      const { rows: curr } = await client.query(
        'SELECT rol FROM tenant_user_roles WHERE tenant_id = $1 AND user_id = $2',
        [req.tenantId, id],
      );
      const rolActual = curr[0]?.rol || 'custom';

      // Si se intenta cambiar el rol del único owner a otra cosa, bloquear.
      if (rolActual === 'owner' && rol !== undefined && rol !== 'owner') {
        const { rows: c } = await client.query(
          `SELECT COUNT(*)::int AS n
             FROM tenant_user_roles
            WHERE tenant_id = $1 AND rol = 'owner'`,
          [req.tenantId],
        );
        if (c[0].n <= 1) {
          return { status: 400, body: {
            error: 'No se puede degradar al único owner del tenant. Asigná otro owner antes.',
          }};
        }
      }

      // Leer overrides actuales para el audit.
      const { rows: ovsBefore } = await client.query(
        'SELECT capability_slug, enabled FROM user_capabilities WHERE tenant_id = $1 AND user_id = $2',
        [req.tenantId, id],
      );

      // 1) UPSERT rol si vino en el body.
      let rolFinal = rolActual;
      if (rol !== undefined) {
        await client.query(
          `INSERT INTO tenant_user_roles (tenant_id, user_id, rol)
                VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, user_id)
           DO UPDATE SET rol = EXCLUDED.rol, updated_at = NOW()`,
          [req.tenantId, id, rol],
        );
        rolFinal = rol;
        // 2026-06-24 TANDA 1 P1 fix: sync con tenant_users.rol (sistema viejo
        // que todavía usa adminOnly y otros middleware legacy hasta drop
        // completo). Sin esto, un owner degradado a 'vendedor' en la UI nueva
        // retenía acceso a endpoints adminOnly (que leen tenant_users.rol).
        // tenant_users.rol tiene CHECK = ('owner' | 'admin' | 'member') —
        // mapeamos owner/admin del sistema nuevo iguales, y el resto cae a
        // 'member' (rol neutro del sistema viejo). El sistema viejo solo
        // distingue owner/admin/member a efectos de adminOnly; la lógica
        // granular vive en el sistema nuevo.
        const tuRol = (rol === 'owner' || rol === 'admin') ? rol : 'member';
        await client.query(
          `UPDATE tenant_users SET rol = $1
            WHERE tenant_id = $2 AND user_id = $3`,
          [tuRol, req.tenantId, id],
        );
      }

      // 2) Reemplazo total de overrides si vino la lista.
      let ovsFinal = ovsBefore;
      if (overrides !== undefined) {
        await client.query(
          'DELETE FROM user_capabilities WHERE tenant_id = $1 AND user_id = $2',
          [req.tenantId, id],
        );
        if (overrides.length > 0) {
          // Bulk INSERT con VALUES (..),(..),(..)
          const values = overrides
            .map((_, i) => `($1, $2, $${i * 2 + 3}, $${i * 2 + 4})`)
            .join(', ');
          const params = [req.tenantId, id];
          for (const ov of overrides) {
            params.push(ov.capability_slug, ov.enabled);
          }
          await client.query(
            `INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
                  VALUES ${values}`,
            params,
          );
        }
        ovsFinal = overrides;
      }

      // 3) Bumpear password_changed_at — invalida JWT del target.
      // Solo si cambió algo (mismo patrón M3 audit 2026-06-17).
      const cambioRol  = (rol !== undefined && rol !== rolActual);
      const cambioOvs  = (overrides !== undefined); // siempre que se touch los overrides
      const bumpPw = cambioRol || cambioOvs;
      if (bumpPw) {
        await client.query(
          'UPDATE users SET password_changed_at = NOW() WHERE id = $1',
          [id],
        );
      }

      // 4) Audit log.
      await audit(client, 'capabilities', 'UPDATE', id, {
        antes:   { rol: rolActual, overrides: ovsBefore },
        despues: { rol: rolFinal,  overrides: ovsFinal },
        user_id: req.user.id,
      });

      return {
        status: 200,
        body: { rol: rolFinal, overrides: ovsFinal, pw_bumped: bumpPw },
        bumpedUserId: bumpPw ? id : null,
      };
    });

    if (result.status !== 200) {
      return res.status(result.status).json(result.body);
    }

    // Invalidar cache de auth del target (mismo patrón usuarios.js).
    if (result.bumpedUserId) {
      userAuthCache.invalidateUserAuth(result.bumpedUserId);
    }

    res.json(result.body);
  } catch (err) {
    // FK violation: capability_slug fuera del catálogo. La validación zod
    // ya lo filtra, pero defensive.
    if (err.code === '23503') {
      logger.warn({ err: err.message, body: req.body }, 'PUT /capabilities/users FK violation');
      return res.status(400).json({ error: 'capability_slug inválido' });
    }
    // CHECK violation: rol fuera del enum. Idem, zod ya filtra.
    if (err.code === '23514') {
      return res.status(400).json({ error: 'rol inválido' });
    }
    next(err);
  }
});

module.exports = router;

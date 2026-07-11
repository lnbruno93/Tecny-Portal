// Rutas del Share Link público de Equipos Usados (2026-07-11).
//
// Este archivo agrupa:
//   1. Endpoints admin bajo `/api/inventario/share-link` (requieren auth
//      + cap `inventario.ver`).
//   2. Endpoint público `/publico/usados/:token` sin auth, con rate limit
//      y cache HTTP.
//
// El público se registra en app.js como router aparte para que no herede
// el `requireAuth` de las rutas admin. Ver `module.exports.publicRouter`.
//
// Diseño técnico completo en la migration `20260711100000_share_links_usados.js`.

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const requireCapability = require('../middleware/requireCapability');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const logger = require('../lib/logger');

const {
  updateShareLinkSchema,
  tokenParamSchema,
} = require('../schemas/shareLinks');

// ─── Helpers ────────────────────────────────────────────────────

// Genera un token URL-safe de 24 chars. Base64URL sin padding = 24 chars
// para 18 bytes random. Suficiente entropía (~144 bits) para no colisionar
// ni ser adivinable por brute force.
function genRandomToken() {
  return crypto.randomBytes(18).toString('base64url');
}

// Salt del env para el hash de IPs (no queremos IPs plaintext en la DB).
// Si no viene, uso un default no vacío para que el hash siga funcionando
// en dev sin bloquear. En prod DEBE venir de env.
const IP_HASH_SALT = process.env.SHARE_LINK_IP_SALT || 'tecny-share-link-salt-dev';

function hashIP(ip) {
  if (!ip) return crypto.createHash('sha256').update(IP_HASH_SALT).digest('hex').slice(0, 32);
  return crypto.createHash('sha256')
    .update(String(ip) + IP_HASH_SALT)
    .digest('hex')
    .slice(0, 32);
}

// Devuelve la config (o crea la fila con defaults si nunca se creó).
// Idempotente: si el tenant llama GET /share-link por primera vez, el
// endpoint la crea con defaults + token generado y devuelve todo.
async function getOrCreateShareLink(client, tenantId) {
  const { rows } = await client.query(
    `SELECT id, token, activo, whatsapp, mensaje_extra,
            mostrar_bateria, mostrar_precio,
            created_at, updated_at, rotated_at
       FROM share_links
      WHERE tenant_id = $1
      LIMIT 1`,
    [tenantId]
  );
  if (rows[0]) return rows[0];

  // Primera vez: creamos la fila con defaults + token nuevo.
  const token = genRandomToken();
  const { rows: created } = await client.query(
    `INSERT INTO share_links (tenant_id, token)
     VALUES ($1, $2)
     RETURNING id, token, activo, whatsapp, mensaje_extra,
               mostrar_bateria, mostrar_precio,
               created_at, updated_at, rotated_at`,
    [tenantId, token]
  );
  return created[0];
}

// Query de stats agregadas (vistas último mes, únicos hoy, última visita).
async function getShareLinkStats(client, shareLinkId) {
  const q = `
    SELECT
      COUNT(*)                                             AS vistas_mes,
      COUNT(*) FILTER (WHERE visto_en >= NOW() - INTERVAL '30 days') AS ult_mes,
      COUNT(DISTINCT ip_hash) FILTER (WHERE visto_en::date = CURRENT_DATE) AS unicos_hoy,
      MAX(visto_en)                                        AS ultimo_acceso
      FROM share_link_views
     WHERE share_link_id = $1
       AND visto_en >= NOW() - INTERVAL '30 days'
  `;
  const { rows } = await client.query(q, [shareLinkId]);
  const r = rows[0] || {};
  return {
    vistas_ult_mes: Number(r.ult_mes || 0),
    unicos_hoy:     Number(r.unicos_hoy || 0),
    ultimo_acceso:  r.ultimo_acceso || null,
  };
}

// ─── Router admin ───────────────────────────────────────────────

const adminRouter = express.Router();
adminRouter.use(requireAuth);

/**
 * GET /api/inventario/share-link
 *
 * Devuelve la config del share link del tenant + stats. Si no existe,
 * la crea con defaults + token nuevo (primera llamada del tenant).
 *
 * Auth: requiere `inventario.ver` (misma cap del tab Equipos usados).
 */
adminRouter.get('/', requireCapability('inventario.ver'), async (req, res, next) => {
  try {
    const link = await db.withTenant(req.tenantId, async (client) => {
      return await getOrCreateShareLink(client, req.tenantId);
    });
    // Stats vive fuera del withTenant porque `share_link_views` no tiene
    // RLS (analytics agregados sin scope de tenant en la query).
    const stats = await db.adminQuery(async (client) => {
      return await getShareLinkStats(client, link.id);
    });
    res.json({ ...link, stats });
  } catch (err) { next(err); }
});

/**
 * PATCH /api/inventario/share-link
 *
 * Actualiza config del link. Todos los campos opcionales. Devuelve el link
 * completo post-update. Solo el owner + admins del tenant pueden mutar
 * (usamos `inventario.editar` para no proliferar capabilities específicas).
 */
adminRouter.patch('/', requireCapability('inventario.editar'), validate(updateShareLinkSchema), async (req, res, next) => {
  try {
    const changes = req.body;
    // Body vacío → no-op, devolvemos el estado actual.
    if (Object.keys(changes).length === 0) {
      const link = await db.withTenant(req.tenantId, async (client) => {
        return await getOrCreateShareLink(client, req.tenantId);
      });
      return res.json(link);
    }

    const updated = await db.withTenant(req.tenantId, async (client) => {
      // Aseguramos que exista antes de update.
      const before = await getOrCreateShareLink(client, req.tenantId);

      // Construimos SET dinámico solo con las claves que vinieron.
      const cols = [];
      const params = [];
      for (const [k, v] of Object.entries(changes)) {
        params.push(v);
        cols.push(`${k} = $${params.length}`);
      }
      params.push(req.tenantId);
      const { rows } = await client.query(
        `UPDATE share_links SET ${cols.join(', ')}
          WHERE tenant_id = $${params.length}
        RETURNING id, token, activo, whatsapp, mensaje_extra,
                  mostrar_bateria, mostrar_precio,
                  created_at, updated_at, rotated_at`,
        params
      );
      await audit(client, 'share_links', 'UPDATE', String(before.id), {
        antes:   before,
        despues: rows[0],
        user_id: req.user.id,
      });
      return rows[0];
    });
    res.json(updated);
  } catch (err) { next(err); }
});

/**
 * POST /api/inventario/share-link/rotate
 *
 * Genera un token nuevo. El viejo queda inválido (los clientes que lo
 * tenían bookmarkeado ven "listado no disponible"). Marca `rotated_at`.
 */
adminRouter.post('/rotate', requireCapability('inventario.editar'), async (req, res, next) => {
  try {
    const rotated = await db.withTenant(req.tenantId, async (client) => {
      const before = await getOrCreateShareLink(client, req.tenantId);
      const newToken = genRandomToken();
      const { rows } = await client.query(
        `UPDATE share_links
            SET token = $1, rotated_at = NOW()
          WHERE tenant_id = $2
        RETURNING id, token, activo, whatsapp, mensaje_extra,
                  mostrar_bateria, mostrar_precio,
                  created_at, updated_at, rotated_at`,
        [newToken, req.tenantId]
      );
      await audit(client, 'share_links', 'UPDATE', String(before.id), {
        antes:   { token: before.token },
        despues: { token: rows[0].token, rotated_at: rows[0].rotated_at },
        tipo:    'rotate_token',
        user_id: req.user.id,
      });
      return rows[0];
    });
    res.json(rotated);
  } catch (err) { next(err); }
});

// ─── Router público (sin auth) ──────────────────────────────────

const publicRouter = express.Router();

// Rate limit: 60 req/min por IP. Suficiente para uso normal (un cliente
// que abre + refresca + navega ~10 veces) pero corta scraping agresivo.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  // Rate limit por IP (default) — no necesitamos key custom. En un futuro
  // agregar rate limit por token también si algún link se vuelve viral y
  // baja calidad del servicio.
});

/**
 * GET /publico/usados/:token
 *
 * Endpoint público sin auth. Devuelve el listado de equipos usados
 * disponibles del tenant dueño del token + config del link.
 *
 * Response shape:
 *   {
 *     tenant: { nombre, pais },
 *     config: {
 *       whatsapp, mensaje_extra,
 *       mostrar_bateria, mostrar_precio
 *     },
 *     equipos: [{
 *       id, nombre, gb, color, bateria,
 *       precio_venta, precio_moneda,
 *       clase_nombre, clase_emoji,
 *       created_at
 *     }],
 *     count: N,
 *     actualizado_en: ISO string
 *   }
 *
 * Estados de error:
 *   - 404 { error: 'not_found' }         → token no matchea NINGÚN link.
 *   - 410 { error: 'link_inactivo' }     → link existe pero activo=false.
 *   - 429 → rate limit.
 *
 * Cache HTTP: `Cache-Control: public, max-age=60` — cliente + CDN cachean
 * 60s. Si el tenant edita el inventario, la vista se refresca en máximo 60s.
 */
publicRouter.get('/usados/:token', publicLimiter, validate(tokenParamSchema, 'params'), async (req, res, next) => {
  try {
    const { token } = req.params;

    // Lookup del link + tenant asociado en admin pool (bypass RLS —
    // necesitamos leer cross-tenant filtrando por token). El token es
    // secret, así que quien lo tiene está autorizado por diseño.
    const linkRow = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT sl.id, sl.tenant_id, sl.activo,
                sl.whatsapp, sl.mensaje_extra,
                sl.mostrar_bateria, sl.mostrar_precio,
                sl.updated_at,
                t.nombre AS tenant_nombre, t.pais AS tenant_pais
           FROM share_links sl
           JOIN tenants t ON t.id = sl.tenant_id AND t.deleted_at IS NULL
          WHERE sl.token = $1
          LIMIT 1`,
        [token]
      );
      return rows[0];
    });

    if (!linkRow) {
      return res.status(404).json({ error: 'not_found', mensaje: 'Listado no encontrado.' });
    }
    if (!linkRow.activo) {
      return res.status(410).json({ error: 'link_inactivo', mensaje: 'Este listado ya no está disponible.' });
    }

    // Traer equipos usados disponibles del tenant. Query directo con
    // filtro por tenant_id (admin pool, sin RLS) — el token ya autorizó.
    const equipos = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT p.id, p.nombre, p.gb, p.color, p.bateria,
                p.precio_venta, p.precio_moneda,
                p.created_at,
                cp.nombre AS clase_nombre,
                cp.emoji  AS clase_emoji
           FROM productos p
           LEFT JOIN clases_producto cp
             ON cp.id = p.clase_id AND cp.deleted_at IS NULL
          WHERE p.tenant_id = $1
            AND p.deleted_at IS NULL
            AND p.condicion = 'usado'
            AND p.estado = 'disponible'
            AND p.precio_venta > 0
          ORDER BY p.precio_venta DESC, p.nombre ASC
          LIMIT 500`,
        [linkRow.tenant_id]
      );
      return rows;
    });

    // Aplicar toggle mostrar_precio: si false, sacamos precio_venta del
    // response (defensa server-side; el frontend público también respeta
    // el toggle en el render pero doble check evita bug de scraping).
    // Toggle mostrar_bateria: idem con `bateria`.
    const equiposFiltrados = equipos.map(e => {
      const base = { ...e };
      if (!linkRow.mostrar_precio) { base.precio_venta = null; }
      if (!linkRow.mostrar_bateria) { base.bateria = null; }
      return base;
    });

    // Registrar view (async, no bloquea response). Si falla, log warn
    // pero no rompemos la request del cliente final.
    const ipRaw = req.ip || req.headers['x-forwarded-for'] || '';
    const uaRaw = String(req.headers['user-agent'] || '').slice(0, 200);
    const ipH = hashIP(ipRaw);
    // Fire-and-forget: no await.
    db.adminQuery(async (client) => {
      await client.query(
        `INSERT INTO share_link_views (share_link_id, ip_hash, user_agent_short)
         VALUES ($1, $2, $3)`,
        [linkRow.id, ipH, uaRaw || null]
      );
    }).catch(err => {
      logger.warn({ err: err.message, tenantId: linkRow.tenant_id },
        '[share-link] fallo al registrar view (no bloquea response)');
    });

    // Cache HTTP: 60s CDN + browser. Si el tenant edita inventario, se
    // refresca en máximo 60s.
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      tenant: {
        nombre: linkRow.tenant_nombre || 'Tu comercio',
        pais:   linkRow.tenant_pais || 'AR',
      },
      config: {
        whatsapp:        linkRow.whatsapp,
        mensaje_extra:   linkRow.mensaje_extra,
        mostrar_bateria: linkRow.mostrar_bateria,
        mostrar_precio:  linkRow.mostrar_precio,
      },
      equipos:        equiposFiltrados,
      count:          equiposFiltrados.length,
      actualizado_en: linkRow.updated_at,
    });
  } catch (err) { next(err); }
});

module.exports = { adminRouter, publicRouter };

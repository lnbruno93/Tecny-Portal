/**
 * requireSuperAdmin — middleware para endpoints /api/admin/*.
 *
 * Debe usarse DESPUÉS de `requireAuth`, que decora `req.user.is_super_admin`
 * leyendo de DB via userAuthCache (cache Redis 60s, source of truth = DB).
 *
 * Diseño:
 *   - Validamos contra DB (vía cache), NO contra JWT claim. Razón: si Lucas
 *     revoca super-admin a alguien con `setSuperAdmin --revoke`, el JWT viejo
 *     SIGUE diciendo `is_super_admin: true` hasta vencer. Validar contra DB
 *     cierra esa ventana — el cambio aplica en la próxima request del user
 *     post-invalidación del cache (máx 60s).
 *   - 403 (no 401): si está autenticado pero no es super-admin, devolvemos
 *     403 (forbidden — sabemos quién sos pero no podés). 401 queda reservado
 *     para problemas de auth (token inválido, ausente). Semántica HTTP.
 *   - Log warn por cada 403: detecta intentos de escalada de privilegios
 *     (un user normal probando endpoints admin con curl) — útil para Sentry
 *     y forense.
 *
 * Bootstrap: el bit `is_super_admin` se setea EXCLUSIVAMENTE vía
 * `backend/scripts/setSuperAdmin.js`. NO hay endpoint API que lo modifique.
 * Esto es a propósito — el super-admin solo se otorga manualmente, con
 * acceso físico a la DB (DATABASE_URL admin), y queda audit-trail en
 * `tenant_admin_actions` con action='bootstrap_super_admin'.
 */

const logger = require('../lib/logger');

module.exports = function requireSuperAdmin(req, res, next) {
  // Fail closed si requireAuth no corrió antes (mal montaje del router).
  if (!req.user) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  if (req.user.is_super_admin !== true) {
    logger.warn(
      { user_id: req.user.id, path: req.path, ip: req.ip },
      '[requireSuperAdmin] acceso denegado a endpoint admin'
    );
    return res.status(403).json({
      error: 'Acceso denegado',
      reason: 'super_admin_required',
    });
  }

  next();
};

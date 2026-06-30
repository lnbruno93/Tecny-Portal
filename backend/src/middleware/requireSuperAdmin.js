/**
 * requireSuperAdmin — middleware para endpoints /api/admin/*.
 *
 * Debe usarse DESPUÉS de `requireAuth`, que decora `req.user.is_super_admin`
 * y `req.user.twofa_enabled` leyendo de DB via userAuthCache (cache Redis 60s,
 * source of truth = DB).
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
 * Auditoría 2026-06-30 S-25 — 2FA obligatoria para super-admin:
 *   Además de `is_super_admin = true`, exigimos `twofa_enabled = true`. Sin
 *   2FA, un super-admin con password leakeada controla cross-tenant todos
 *   los tenants de la plataforma — el blast radius es total. 2FA reduce ese
 *   riesgo a un segundo factor que el atacante no controla.
 *
 *   Edge case: el endpoint para HABILITAR 2FA está en /api/auth/2fa/*
 *   (mountado con `requireAuth` + `twoFaLimiter` en app.js — NO usa este
 *   middleware). Por lo tanto, un super-admin sin 2FA puede activar 2FA
 *   sin quedar locked-out del setup.
 *
 *   Devolvemos 403 con `code: 'super_admin_2fa_required'` para que el admin
 *   frontend pueda detectar el caso específico y redirigir al setup de 2FA
 *   en lugar de mostrar el genérico "acceso denegado".
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

  // Auditoría 2026-06-30 S-25: exigir 2FA activa para super-admin.
  if (req.user.twofa_enabled !== true) {
    logger.warn(
      { user_id: req.user.id, path: req.path, ip: req.ip },
      '[requireSuperAdmin] super-admin sin 2FA — acceso bloqueado'
    );
    return res.status(403).json({
      error: 'Activá 2FA en tu cuenta para acceder al panel super-admin.',
      reason: 'super_admin_2fa_required',
      code: 'super_admin_2fa_required',
    });
  }

  next();
};

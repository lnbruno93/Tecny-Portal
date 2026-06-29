const jwt    = require('jsonwebtoken');
const Sentry = require('@sentry/node');
// Importamos el módulo (no destructuramos) para que jest.spyOn pueda
// reemplazar `getUserAuth` desde tests sin gimnasia de jest.mock. Acceso
// late-binding via `userAuthCache.getUserAuth(...)` en cada request.
const userAuthCache = require('../lib/userAuthCache');

module.exports = async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'No autorizado' });

  let decoded;
  try {
    // algorithms explícito previene algorithm confusion attacks (none, RS256, etc.)
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // Verificar que el token no fue emitido antes de un cambio de contraseña
  // y leer el estado de verificación de email (TANDA 2.1).
  //
  // P-04 Fase 3.6: la query a `users` está cacheada 60s en Redis
  // (userAuthCache.js). El cache se invalida explícitamente desde los call-
  // sites que tocan los fields cacheados:
  //   - routes/auth.js logout (bump password_changed_at)
  //   - routes/auth.js change-password (bump password_changed_at)
  //   - routes/usuarios.js PUT (bump password_changed_at en sensitive changes)
  //   - routes/usuarios.js DELETE (soft-delete + bump password_changed_at)
  //   - routes/signup.js verify-email (set email_verified_at)
  // NO invalidamos en failed_login_count / lockout_until updates — esos
  // fields no están en el cache. Sub-ms hit en lugar de query por request.
  let userAuth;
  try {
    userAuth = await userAuthCache.getUserAuth(decoded.id);
    if (!userAuth) return res.status(401).json({ error: 'Usuario no encontrado' });

    const changedAt = userAuth.password_changed_at;
    if (changedAt) {
      const changedAtMs   = new Date(changedAt).getTime();
      // TANDA 3 fix T7 auditoría 2026-06-17: NaN guard. Si el cache Redis
      // devuelve un timestamp malformado (data corruption, poisoning, parser
      // bug futuro), `new Date('not-a-date').getTime()` da NaN. La comparación
      // `tokenIssuedMs < NaN` siempre es false → el token VIEJO sería aceptado
      // como válido aunque debiera rechazarse. Fail-closed: si no podemos
      // verificar el timestamp, rechazamos el token.
      if (Number.isNaN(changedAtMs)) {
        return res.status(401).json({ error: 'Sesión inválida. Ingresá de nuevo.' });
      }
      // iat_ms está presente en tokens nuevos (precisión ms); fallback a iat*1000 para tokens legacy
      const tokenIssuedMs = decoded.iat_ms ?? decoded.iat * 1000;
      if (tokenIssuedMs < changedAtMs) {
        return res.status(401).json({ error: 'Sesión expirada. Ingresá de nuevo.' });
      }
    }
  } catch (err) {
    return next(err);
  }

  // 2026-06-16 TANDA 2.1: source of truth = DB (no el JWT cacheado en cliente).
  // Los users pre-TANDA 2.1 fueron backfilleados con email_verified_at = NOW() en
  // la migration 20260616000004, así que para usuarios existentes esto es true.
  // Para signups públicos nuevos, esto es null hasta que el user clickee el link
  // de verificación → bloqueo blando de escrituras (abajo).
  const isEmailVerified = !!userAuth.email_verified_at;

  // 2026-06-21 #353 Fase 1: decorar req.user con is_super_admin desde DB
  // (no el JWT). Source of truth = DB — si Lucas revoca super-admin a
  // alguien via script `setSuperAdmin --revoke`, el cambio aplica en la
  // próxima request (post invalidación del cache de 60s), sin esperar a
  // que el token venza.
  req.user = {
    ...decoded,
    email_verified: isEmailVerified,
    is_super_admin: !!userAuth.is_super_admin,
  };

  // 2026-06-16 TANDA 2.1 bloqueo blando: si el user NO verificó su email,
  // bloquear escrituras (POST/PUT/PATCH/DELETE) excepto los endpoints de
  // /api/auth/* (que incluyen verify-email, resend-verification, logout,
  // change-password — todos deben funcionar incluso para users unverified).
  //
  // Lectura (GET) siempre OK: el user puede ver su dashboard / inventario,
  // explorar la app, pero no crear ni modificar datos hasta verificar.
  //
  // Trade-off UX: el legítimo unverified ve el dashboard vacío pero no puede
  // crear nada. El frontend muestra un banner persistente con CTA "verificá
  // tu email" + opción de resend. Acepta esta UX para evitar abuse de signup.
  const isWriteMethod = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  const isAuthRoute = req.originalUrl.startsWith('/api/auth/');
  if (isWriteMethod && !isAuthRoute && !isEmailVerified) {
    return res.status(403).json({
      error: 'Verificá tu email para crear o modificar datos.',
      reason: 'email_not_verified',
    });
  }

  // 2026-06-15 multi-tenant PR 3: decorar req.tenantId / req.tenantRol.
  // - JWTs emitidos post-PR3 incluyen tenant_id (resuelto al login vía
  //   tenant_users del user).
  // - JWTs viejos (pre-PR3) tenían fallback silencioso a tenant 1 — esos
  //   tokens caducaron meses atrás (TTL 8h) y el grace period terminó.
  //
  // 2026-06-24 SEG-2 (audit pre-live): rechazamos ahora cualquier token sin
  // tenant_id explícito. Misma razón que userTenant.js — fail-CLOSED contra
  // el riesgo de servir data de tenant 1 a un user sin tenant resuelto.
  // El frontend recibe 401 + code=NO_TENANT y fuerza re-login (que va a
  // emitir un JWT con tenant_id válido, o rechazar con NO_TENANT si el
  // user realmente no tiene tenant_users row).
  if (decoded.tenant_id == null) {
    return res.status(401).json({
      error: 'Sesión expirada. Ingresá de nuevo.',
      code: 'NO_TENANT',
    });
  }
  req.tenantId  = decoded.tenant_id;
  req.tenantRol = decoded.tenant_rol ?? 'member';

  // 2026-06-29 Multi-país F2: exponer `req.tenantPais` derivado del cache
  // `tenantStatus` (5min TTL Redis cross-instance, ya leído más abajo en
  // writes). Llamada cacheada — sub-ms hit en path caliente, único miss
  // por tenant cada 5min. Fail-open: si el lookup falla (Redis/DB down),
  // defaulteamos a 'AR' para no romper requests legítimos. La migration
  // F1 garantiza que TODOS los tenants tienen un `pais` no-null seteado.
  //
  // Diseño: NO embebemos `pais` en el JWT directamente porque (a) JWTs
  // existentes no lo tienen y queremos backward-compat sin re-login forzado
  // de toda la base; (b) el cache de tenantStatus ya es shared cross-instance
  // y `pais` cambia ~nunca post-signup; (c) consistencia con `paid_until`
  // que sigue el mismo patrón.
  try {
    const { getTenantStatus } = require('../lib/tenantStatus');
    const tenantStatus = await getTenantStatus(req.tenantId);
    req.tenantPais = (tenantStatus && tenantStatus.pais) || 'AR';
  } catch (err) {
    const logger = require('../lib/logger');
    logger.warn({ err: err.message, tenantId: req.tenantId },
      'requireAuth: lookup tenant.pais falló, fallback a AR');
    req.tenantPais = 'AR';
  }

  // TANDA 4 (billing pre-live 2026-06-25): bloqueo blando de WRITES en tenants
  // expirados (paid_until < hoy) o suspendidos.
  //
  // Diseño paralelo al gate de email_verified de arriba — mismas mecánicas:
  //   - GET / HEAD / OPTIONS pasan siempre (read-only state permite
  //     exportar comprobantes, ver, navegar — defendemos a un cliente vencido
  //     que no quedó "sin acceso a sus propios datos").
  //   - /api/auth/* (logout, change-password, etc.) pasan siempre.
  //   - /api/super-admin/* pasa siempre (el operador necesita poder PATCH
  //     paid_until aunque el tenant esté suspendido por él mismo).
  //   - Write methods en cualquier otro path → 402 Payment Required.
  //
  // El check pega al cache TENANT_STATUS (5min TTL, invalidate cross-instance
  // via Redis al PATCH paid-until del admin). Si Redis está down, fail-OPEN
  // (next()) — preferimos no bloquear toda la operación del tenant por un
  // problema de infra. El audit log igual registra cada acción.
  const isSuperAdminRoute = req.originalUrl.startsWith('/api/super-admin/');
  if (isWriteMethod && !isAuthRoute && !isSuperAdminRoute) {
    try {
      const { getTenantStatus } = require('../lib/tenantStatus');
      const status = await getTenantStatus(req.tenantId);
      if (status && !status.is_active) {
        const reason = status.suspended_at ? 'suspended' : 'expired';
        return res.status(402).json({
          error: reason === 'suspended'
            ? 'Tu cuenta está suspendida. Contactá soporte.'
            : 'Tu cuenta venció. Renová para seguir operando.',
          code: reason === 'suspended' ? 'TENANT_SUSPENDED' : 'TENANT_EXPIRED',
          paid_until: status.paid_until,
        });
      }
    } catch (err) {
      // Fail-open en error de infra (DB / Redis). Log pero no bloqueamos —
      // bloquear toda la operación del tenant por un problema infraestructural
      // sería peor que un breve período sin enforcement (que el cron de
      // warning igual va a alertarle al operador via mail).
      const logger = require('../lib/logger');
      logger.error({ err: err.message, tenantId: req.tenantId },
        'requireAuth: lookup tenant_status falló, fail-open');
    }
  }

  // Asociar el usuario autenticado al scope de Sentry para este request.
  // Así todos los errores capturados incluyen quién los triggereó.
  if (process.env.SENTRY_DSN) {
    Sentry.getCurrentScope().setUser({
      id:       String(decoded.id),
      username: decoded.username,
      role:     decoded.role,
    });
  }

  next();
};

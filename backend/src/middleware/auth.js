const jwt    = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const { getUserAuth } = require('../lib/userAuthCache');

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
  // sites que UPDATE-an users (change-password, login fail/lockout/reset,
  // admin edit, soft-delete, verify-email). Sub-ms hit en lugar de query
  // por request.
  let userAuth;
  try {
    userAuth = await getUserAuth(decoded.id);
    if (!userAuth) return res.status(401).json({ error: 'Usuario no encontrado' });

    const changedAt = userAuth.password_changed_at;
    if (changedAt) {
      const changedAtMs   = new Date(changedAt).getTime();
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

  req.user = { ...decoded, email_verified: isEmailVerified };

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
  // - JWTs viejos (pre-PR3, en cache de browser de users actuales) NO los
  //   tienen → default a tenant 1 (Lucas/iPro Original) hasta el próximo
  //   login que regenera el JWT con el nuevo formato.
  // - PR 4 usará estos campos en endpoints; PR 6 agrega tests de aislamiento
  //   exhaustivos.
  req.tenantId  = decoded.tenant_id ?? 1;
  req.tenantRol = decoded.tenant_rol ?? 'member';

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

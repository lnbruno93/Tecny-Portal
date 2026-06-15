const jwt    = require('jsonwebtoken');
const db     = require('../config/database');
const Sentry = require('@sentry/node');

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
  try {
    const { rows } = await db.query(
      'SELECT password_changed_at FROM users WHERE id = $1 AND deleted_at IS NULL',
      [decoded.id]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Usuario no encontrado' });

    const changedAt = rows[0].password_changed_at;
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

  req.user = decoded;

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

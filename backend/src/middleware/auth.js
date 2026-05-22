const jwt = require('jsonwebtoken');
const db  = require('../config/database');

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
    if (changedAt && decoded.iat < Math.floor(new Date(changedAt).getTime() / 1000)) {
      return res.status(401).json({ error: 'Sesión expirada. Ingresá de nuevo.' });
    }
  } catch (err) {
    return next(err);
  }

  req.user = decoded;
  next();
};

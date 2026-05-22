/**
 * Historial de acciones — lee de audit_logs (fuente de verdad).
 * La tabla `historial` no recibe writes; audit_logs captura todos los cambios.
 *
 * Formato de respuesta compatible con el frontend:
 *   accion        → "tabla: ACCION" (ej. "comprobantes: INSERT")
 *   detalle       → descripción corta derivada de datos_despues / datos_antes
 *   usuario_nombre → nombre del usuario que realizó la acción
 *   creado_en     → timestamp ISO
 */
const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const { parsePagination, paginatedResponse } = require('../lib/paginate');

router.use(requireAuth);

const HISTORIAL_SELECT = `
  SELECT
    a.id,
    a.tabla || ': ' || a.accion                AS accion,
    CASE
      WHEN a.datos_despues IS NOT NULL
        THEN COALESCE(
          a.datos_despues->>'cliente',
          a.datos_despues->>'nombre',
          a.datos_despues->>'username',
          a.datos_despues::text
        )
      WHEN a.datos_antes IS NOT NULL
        THEN 'eliminado: ' || COALESCE(
          a.datos_antes->>'cliente',
          a.datos_antes->>'nombre',
          a.datos_antes->>'username',
          '#' || a.registro_id::text
        )
      ELSE NULL
    END                                         AS detalle,
    COALESCE(u.nombre, 'Sistema')               AS usuario_nombre,
    a.created_at                                AS creado_en
  FROM audit_logs a
  LEFT JOIN users u ON u.id = a.user_id
`;

router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });

    const [countRes, dataRes] = await Promise.all([
      db.query('SELECT COUNT(*) FROM audit_logs'),
      db.query(`${HISTORIAL_SELECT} ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
    ]);
    const total = parseInt(countRes.rows[0].count);
    res.json(paginatedResponse(dataRes.rows, total, { page, limit }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;

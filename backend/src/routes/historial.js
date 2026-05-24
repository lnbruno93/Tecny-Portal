/**
 * Historial de acciones — lee de audit_logs (fuente de verdad).
 * La tabla `historial` no recibe writes; audit_logs captura todos los cambios.
 *
 * Filtros soportados:
 *   q      → busca en nombre de usuario y datos JSON (ILIKE)
 *   accion → INSERT | UPDATE | DELETE | OCR | LOGIN
 *   tabla  → módulo exacto (comprobantes, pagos, contactos, …)
 *   desde  → YYYY-MM-DD (incluyente)
 *   hasta  → YYYY-MM-DD (incluyente)
 *   page / limit (o per_page) → paginación
 *
 * Formato de respuesta compatible con el frontend:
 *   accion        → "tabla: ACCION" (ej. "comprobantes: INSERT")
 *   detalle       → descripción corta derivada de datos_despues / datos_antes
 *   usuario_nombre → nombre del usuario que realizó la acción
 *   creado_en     → timestamp ISO
 */
const router = require('express').Router();
const db = require('../config/database');
const { parsePagination, paginatedResponse } = require('../lib/paginate');

const VALID_ACCIONES = ['INSERT', 'UPDATE', 'DELETE', 'OCR', 'LOGIN'];

// Whitelist de tablas auditadas — previene filtrado con valores arbitrarios
const VALID_TABLAS = [
  'comprobantes', 'pagos', 'envios', 'contactos', 'vendedores',
  'clientes_cc', 'movimientos_cc', 'catalogo_usados',
  'movimientos_deudas', 'movimientos_inversiones', 'users', 'config',
];

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
    // Soporta tanto ?limit= como ?per_page= (compatibilidad con el frontend)
    const rawQuery = { ...req.query };
    if (!rawQuery.limit && rawQuery.per_page) rawQuery.limit = rawQuery.per_page;
    const { page, limit, offset } = parsePagination(rawQuery, { defaultLimit: 20, maxLimit: 200 });

    const { q, accion, tabla, desde, hasta } = req.query;

    // ── Construcción dinámica del WHERE ──────────────────────────────────────
    const conditions = [];
    const params     = [];

    if (q && q.trim()) {
      params.push(`%${q.trim()}%`);
      const i = params.length;
      conditions.push(
        `(u.nombre ILIKE $${i} OR a.datos_despues::text ILIKE $${i} OR a.datos_antes::text ILIKE $${i})`
      );
    }

    if (accion && VALID_ACCIONES.includes(accion)) {
      params.push(accion);
      conditions.push(`a.accion = $${params.length}`);
    }

    if (tabla && VALID_TABLAS.includes(tabla)) {
      params.push(tabla);
      conditions.push(`a.tabla = $${params.length}`);
    }

    if (desde && /^\d{4}-\d{2}-\d{2}$/.test(desde)) {
      params.push(desde);
      conditions.push(`a.created_at::date >= $${params.length}::date`);
    }

    if (hasta && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      params.push(hasta);
      conditions.push(`a.created_at::date <= $${params.length}::date`);
    }

    const where    = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const joinBase = `FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${where}`;

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) ${joinBase}`, params),
      db.query(
        `${HISTORIAL_SELECT} ${where} ORDER BY a.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countRes.rows[0].count);
    res.json(paginatedResponse(dataRes.rows, total, { page, limit }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;

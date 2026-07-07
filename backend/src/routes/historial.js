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

// Whitelist de tablas auditadas — previene filtrado con valores arbitrarios.
// Actualizada en mayo-2026 con los módulos nuevos (ventas, envios items, egresos,
// proveedores, cambios, tarjetas, proyectos, etc.). La auditoría detectó que el
// filtro `?tabla=ventas` se ignoraba silenciosamente porque no estaba en la lista.
const VALID_TABLAS = [
  // Catálogos / config
  'config', 'users', 'metodos_pago', 'etiquetas', 'plantillas_garantia',
  // Inventario
  'productos', 'categorias', 'depositos',
  // Ventas y Envíos
  'ventas', 'venta_items', 'venta_pagos', 'venta_comprobantes', 'canjes',
  'envios', 'envio_items',
  // Caja / Cuentas / Cambios / Tarjetas / Egresos
  'caja_movimientos', 'cambio_movimientos', 'cambio_entidades',
  'tarjeta_movimientos', 'egresos', 'egreso_categorias', 'egresos_recurrentes',
  // Cuenta corriente
  'clientes_cc', 'movimientos_cc',
  // Proveedores / Proyectos / Contactos
  'proveedores', 'proveedor_movimientos', 'proyectos', 'proyecto_movimientos',
  'contactos',
  // Catálogos legacy
  'comprobantes', 'pagos', 'vendedores', 'catalogo_usados',
  'movimientos_deudas', 'movimientos_inversiones',
];

// Rango máximo (en días) para queries de búsqueda libre. Si hay `q` y no se
// pasa `desde`, lo forzamos a NOW() - este valor para evitar seq scan + cast
// a text sobre toda la tabla `audit_logs` (que crece linealmente con uso real).
const Q_RANGO_DIAS_MAX = 90;

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
    const hayBusqueda = !!(q && q.trim());

    // ── Construcción dinámica del WHERE ──────────────────────────────────────
    const conditions = [];
    const params     = [];

    // Hotfix 2026-06-19 #336: leak cross-tenant en /api/historial.
    //
    // La policy RLS de `audit_logs` permite `tenant_id IS NULL` por diseño
    // (audits del sistema sin contexto de tenant — jobs/crons). El problema:
    // entre 2026-06-16 y 2026-06-18, 82 audits se insertaron con tenant_id NULL
    // por un bug en code paths legacy (pre TANDA 0b refactor). Esos 82 quedaban
    // visibles a TODOS los tenants al listar /api/historial — el "Actividad
    // reciente" del Inicio mostraba acciones de otros tenants.
    //
    // Fix de superficie: filtrar `tenant_id IS NOT NULL` en este endpoint.
    // RLS sigue filtrando el resto (tenant_id = current_setting). Defense
    // in depth: la app NO confía en que la policy cubra el corner case del
    // NULL — lo descartamos explícitamente en el SQL.
    //
    // Audits de sistema (tenant_id NULL) NO deben aparecer en UI user-facing
    // en ningún caso — son para admin / sysadmin tools, no para el feed de
    // actividad del dashboard.
    //
    // Follow-up planeado: (a) backfill de los 82 huérfanos via user_id →
    // users.tenant_id, (b) borrado de los que queden sin attribution,
    // (c) tighten RLS para no permitir NULL en audit_logs — defensa permanente.
    conditions.push('a.tenant_id IS NOT NULL');

    if (hayBusqueda) {
      params.push(`%${q.trim()}%`);
      const i = params.length;
      // El cast JSONB::text + ILIKE es costoso (seq scan). El range floor abajo
      // limita el universo; aún así, si la tabla audit_logs crece mucho, considerar
      // GIN sobre `to_tsvector` o columna generada con campos whitelisted.
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

    // Perf H1 auditoría 2026-06-06: usar `created_at >= $::date` en vez de
    // `created_at::date >= $`. El cast a date EN LA COLUMNA invalida el
    // índice `idx_audit_created` (btree sobre created_at DESC) → seq scan
    // sobre toda audit_logs (millones de filas con la purga a 365d).
    // Esta forma usa el índice y mantiene el comportamiento "inclusivo del
    // día completo" agregando un day a `hasta`.
    const desdeValido = desde && /^\d{4}-\d{2}-\d{2}$/.test(desde);
    if (desdeValido) {
      params.push(desde);
      conditions.push(`a.created_at >= $${params.length}::date`);
    } else if (hayBusqueda) {
      // No hay `desde` pero sí búsqueda libre: forzamos un rango máximo para
      // limitar el universo escaneado por el ILIKE sobre JSONB::text.
      conditions.push(`a.created_at >= NOW() - INTERVAL '${Q_RANGO_DIAS_MAX} days'`);
    }

    if (hasta && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      params.push(hasta);
      conditions.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    const where    = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const joinBase = `FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${where}`;

    const { countRes, dataRes } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query(`SELECT COUNT(*) ${joinBase}`, params);
      const dataRes = await client.query(
        `${HISTORIAL_SELECT} ${where} ORDER BY a.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      return { countRes, dataRes };
    });

    const total = parseInt(countRes.rows[0].count);
    res.json(paginatedResponse(dataRes.rows, total, { page, limit }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;

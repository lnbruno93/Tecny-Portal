// Validador de invariantes de integridad de datos. Lista de queries SQL que
// detectan filas que violan reglas de negocio que el código DEBERÍA mantener
// pero que sin defensa en DB podrían driftar silenciosamente.
//
// Diseño:
//   · Cada validator es { id, descripcion, severity, query, format }
//   · query devuelve filas problemáticas (vacío = invariante OK).
//   · evaluarTodos() corre todos en paralelo (Promise.all + error isolation)
//     y devuelve { id, ok, violaciones, error }.
//   · El job nocturno (jobs/invariantsJob.js) lo llama y reporta a Sentry si
//     alguna invariante tiene violaciones.
//
// Cómo agregar uno nuevo:
//   1. Pensar el invariante en palabras ("X debería implicar Y").
//   2. SQL que devuelve filas donde X es verdad pero Y no.
//   3. Agregarlo a INVARIANTES con id único + severity.
//
// Severity guía la urgencia de la alerta:
//   · 'critica' — corrupción financiera (saldo en negativo, drift de balance).
//                 Cualquier violación dispara Sentry como error.
//   · 'alta'    — inconsistencia referencial (FK lógica rota, no enforced en DB).
//                 Dispara Sentry como warning.
//   · 'media'   — drift estructural sin impacto financiero inmediato.
//                 Logueado pero no alerta.

const db = require('../config/database');

// ──────────────────────────────────────────────────────────────────────
// Cada entry: { id, descripcion, severity, query, format? }
// `format(row)` es opcional — formatea una fila de la query a string corto
// para el reporte. Si no, JSON.stringify(row).
// ──────────────────────────────────────────────────────────────────────
const INVARIANTES = [

  // ─── Cajas ────────────────────────────────────────────────────────────
  {
    id: 'caja_saldo_negativo',
    descripcion: 'Cajas con saldo actual < 0 (postCajaMovimiento debería prevenirlo)',
    severity: 'critica',
    query: `
      SELECT mp.id, mp.nombre, mp.moneda,
             mp.saldo_inicial + COALESCE(SUM(
               CASE WHEN cm.tipo = 'ingreso' THEN cm.monto ELSE -cm.monto END
             ), 0) AS saldo
        FROM metodos_pago mp
        LEFT JOIN caja_movimientos cm ON cm.caja_id = mp.id AND cm.deleted_at IS NULL
       WHERE mp.deleted_at IS NULL
       GROUP BY mp.id, mp.nombre, mp.moneda, mp.saldo_inicial
      HAVING mp.saldo_inicial + COALESCE(SUM(
               CASE WHEN cm.tipo = 'ingreso' THEN cm.monto ELSE -cm.monto END
             ), 0) < -0.01
       LIMIT 20
    `,
    format: r => `Caja "${r.nombre}" (${r.moneda}): saldo ${Number(r.saldo).toFixed(2)}`,
  },

  {
    id: 'caja_eliminada_con_movs_activos',
    descripcion: 'Cajas soft-deleted con movimientos activos (deleted_at IS NULL)',
    severity: 'alta',
    query: `
      SELECT mp.id, mp.nombre, mp.deleted_at,
             COUNT(cm.id)::int AS movs_activos
        FROM metodos_pago mp
        JOIN caja_movimientos cm ON cm.caja_id = mp.id
       WHERE mp.deleted_at IS NOT NULL
         AND cm.deleted_at IS NULL
       GROUP BY mp.id, mp.nombre, mp.deleted_at
      HAVING COUNT(cm.id) > 0
       LIMIT 20
    `,
    format: r => `Caja "${r.nombre}" eliminada ${r.deleted_at} pero tiene ${r.movs_activos} movs activos`,
  },

  // ─── Conciliación ─────────────────────────────────────────────────────
  {
    id: 'conciliacion_pareja_inconsistente',
    descripcion: 'caja_movimientos.conciliado_en y conciliacion_id deben coexistir o ser ambos NULL',
    severity: 'alta',
    query: `
      SELECT id, fecha, monto, tipo, conciliado_en, conciliacion_id
        FROM caja_movimientos
       WHERE deleted_at IS NULL
         AND ((conciliado_en IS NULL) <> (conciliacion_id IS NULL))
       LIMIT 20
    `,
    format: r => `caja_mov #${r.id}: conciliado_en=${r.conciliado_en}, conciliacion_id=${r.conciliacion_id} (inconsistente)`,
  },

  {
    id: 'conciliacion_match_caja_distinta',
    descripcion: 'conciliacion_lineas.matched_caja_mov_id apunta a mov de caja distinta a la conciliación',
    severity: 'alta',
    query: `
      SELECT cl.id, cl.conciliacion_id, c.caja_id AS caja_concil, cm.caja_id AS caja_mov
        FROM conciliacion_lineas cl
        JOIN conciliaciones c   ON c.id = cl.conciliacion_id  AND c.deleted_at IS NULL
        JOIN caja_movimientos cm ON cm.id = cl.matched_caja_mov_id
       WHERE c.caja_id <> cm.caja_id
       LIMIT 20
    `,
    format: r => `Línea ${r.id}: matched a mov de caja ${r.caja_mov}, pero la conciliación es de caja ${r.caja_concil}`,
  },

  {
    id: 'conciliacion_match_a_mov_deleted',
    descripcion: 'conciliacion_lineas con match a un caja_movimiento soft-deleted',
    severity: 'media',
    query: `
      SELECT cl.id, cl.conciliacion_id, cl.matched_caja_mov_id, cm.deleted_at
        FROM conciliacion_lineas cl
        JOIN conciliaciones c   ON c.id = cl.conciliacion_id  AND c.deleted_at IS NULL
        JOIN caja_movimientos cm ON cm.id = cl.matched_caja_mov_id
       WHERE cm.deleted_at IS NOT NULL
       LIMIT 20
    `,
    format: r => `Línea ${r.id}: matcheada a mov #${r.matched_caja_mov_id} que fue eliminado ${r.deleted_at}`,
  },

  // ─── Egresos ──────────────────────────────────────────────────────────
  {
    id: 'egreso_pagado_sin_caja_mov',
    descripcion: 'Egresos en estado pagado con metodo_pago_id pero sin caja_movimiento asociado',
    severity: 'critica',
    query: `
      SELECT e.id, e.concepto, e.monto, e.metodo_pago_id, e.estado
        FROM egresos e
       WHERE e.deleted_at IS NULL
         AND e.estado = 'pagado'
         AND e.metodo_pago_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM caja_movimientos cm
            WHERE cm.origen = 'egreso'
              AND cm.ref_tabla = 'egresos'
              AND cm.ref_id = e.id
              AND cm.deleted_at IS NULL
         )
       LIMIT 20
    `,
    format: r => `Egreso #${r.id} "${r.concepto ?? '(sin concepto)'}" pagado por ${r.monto} pero sin mov en caja ${r.metodo_pago_id}`,
  },

  {
    id: 'caja_mov_egreso_huerfano',
    descripcion: 'caja_movimientos con origen=egreso pero sin egreso correspondiente activo',
    severity: 'alta',
    query: `
      SELECT cm.id, cm.fecha, cm.monto, cm.ref_id
        FROM caja_movimientos cm
       WHERE cm.deleted_at IS NULL
         AND cm.origen = 'egreso'
         AND cm.ref_tabla = 'egresos'
         AND NOT EXISTS (
           SELECT 1 FROM egresos e
            WHERE e.id = cm.ref_id AND e.deleted_at IS NULL
         )
       LIMIT 20
    `,
    format: r => `caja_mov #${r.id} (egreso) apunta a egreso #${r.ref_id} que no existe / fue eliminado`,
  },

  // ─── Proyectos ────────────────────────────────────────────────────────
  {
    id: 'proyecto_mov_sin_caja_mov',
    descripcion: 'proyecto_movimientos con caja_id pero sin caja_movimiento asociado',
    severity: 'critica',
    query: `
      SELECT pm.id, pm.proyecto_id, pm.caja_id, pm.tipo, pm.monto
        FROM proyecto_movimientos pm
       WHERE pm.deleted_at IS NULL
         AND pm.caja_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM caja_movimientos cm
            WHERE cm.origen = 'proyecto'
              AND cm.ref_tabla = 'proyecto_movimientos'
              AND cm.ref_id = pm.id
              AND cm.deleted_at IS NULL
         )
       LIMIT 20
    `,
    format: r => `Proyecto mov #${r.id} (proyecto ${r.proyecto_id}, ${r.tipo} ${r.monto}) sin mov en caja ${r.caja_id}`,
  },

  // ─── Soft-delete consistency ──────────────────────────────────────────
  {
    id: 'venta_pagos_sin_venta_activa',
    descripcion: 'venta_pagos referenciando una venta soft-deleted',
    severity: 'media',
    query: `
      SELECT vp.id, vp.venta_id, v.deleted_at
        FROM venta_pagos vp
        JOIN ventas v ON v.id = vp.venta_id
       WHERE v.deleted_at IS NOT NULL
       LIMIT 20
    `,
    format: r => `venta_pago #${r.id} apunta a venta #${r.venta_id} eliminada ${r.deleted_at}`,
  },

  // ─── Conciliaciones ───────────────────────────────────────────────────
  {
    id: 'conciliacion_cerrada_con_lineas_pending',
    descripcion: 'Conciliaciones cerradas que tienen líneas sin match ni ignorar (no debería poderse cerrar)',
    severity: 'alta',
    query: `
      SELECT c.id, c.fecha_desde, c.fecha_hasta, c.cerrado_en,
             COUNT(cl.id) FILTER (
               WHERE cl.matched_caja_mov_id IS NULL AND cl.ignorada = false
             )::int AS pendientes
        FROM conciliaciones c
        JOIN conciliacion_lineas cl ON cl.conciliacion_id = c.id
       WHERE c.deleted_at IS NULL
         AND c.cerrado_en IS NOT NULL
       GROUP BY c.id, c.fecha_desde, c.fecha_hasta, c.cerrado_en
      HAVING COUNT(cl.id) FILTER (
               WHERE cl.matched_caja_mov_id IS NULL AND cl.ignorada = false
             ) > 0
       LIMIT 20
    `,
    format: r => `Conciliación #${r.id} (${r.fecha_desde}/${r.fecha_hasta}) cerrada con ${r.pendientes} líneas pendientes`,
  },
];

/**
 * Evalúa todos los invariantes en paralelo. Cada uno tiene su propio try/catch
 * para que la falla de uno no impida ver los otros (resilient evaluation).
 *
 * Devuelve un array de resultados:
 *   { id, descripcion, severity, ok, violaciones, error }
 *
 * - ok: true si query devolvió 0 filas, false si devolvió >0.
 * - violaciones: array de filas problemáticas (max LIMIT del query).
 * - error: presente solo si la query falló (ej: tabla no existe en versión vieja).
 */
async function evaluarTodos() {
  const resultados = await Promise.all(
    INVARIANTES.map(async (inv) => {
      try {
        const { rows } = await db.query(inv.query);
        return {
          id:          inv.id,
          descripcion: inv.descripcion,
          severity:    inv.severity,
          ok:          rows.length === 0,
          violaciones: rows.length === 0
            ? []
            : rows.map(r => ({
                ...r,
                _fmt: inv.format ? inv.format(r) : JSON.stringify(r),
              })),
        };
      } catch (err) {
        return {
          id:          inv.id,
          descripcion: inv.descripcion,
          severity:    inv.severity,
          ok:          false,
          violaciones: [],
          error:       err.message,
        };
      }
    })
  );
  return resultados;
}

/**
 * Resumen agregado de una corrida — útil para el endpoint /admin/invariants
 * y para el reporte que el job nocturno manda a Sentry.
 */
function resumir(resultados) {
  const total       = resultados.length;
  const ok          = resultados.filter(r => r.ok && !r.error).length;
  const violados    = resultados.filter(r => !r.ok && !r.error).length;
  const con_error   = resultados.filter(r => r.error).length;
  const total_filas = resultados.reduce((acc, r) => acc + r.violaciones.length, 0);
  const por_severity = {
    critica: resultados.filter(r => !r.ok && r.severity === 'critica').length,
    alta:    resultados.filter(r => !r.ok && r.severity === 'alta').length,
    media:   resultados.filter(r => !r.ok && r.severity === 'media').length,
  };
  return { total, ok, violados, con_error, total_filas, por_severity };
}

module.exports = { INVARIANTES, evaluarTodos, resumir };

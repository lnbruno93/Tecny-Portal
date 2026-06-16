/**
 * Migration: RLS policy fail-closed (TANDA 0c hardening)
 *
 * Contexto:
 *   La policy original (migration 20260615000002 PR 2) tenía un fallback
 *   permisivo: "OR current_setting('app.current_tenant', true) IS NULL OR ''".
 *   Eso significa que CUALQUIER query corriendo sin SET LOCAL veía TODAS las
 *   filas — no era defense-in-depth, era "abierto por default". El plan
 *   original asumía que TODOS los routes usaban withTenant; en la realidad
 *   14 routes seguían con db.query() directo (refactoreados en TANDA 0b).
 *
 * Esta migration:
 *   - DROP + CREATE de la policy `tenant_isolation` en cada tabla con RLS.
 *   - Predicate nuevo: SOLO `tenant_id = current_setting(...)::int`. Sin
 *     fallback NULL.
 *   - audit_logs sigue permitiendo `tenant_id IS NULL` (audits programáticos
 *     de jobs/crons que no tienen tenant context — comportamiento correcto:
 *     son del sistema, no del tenant).
 *
 * Efecto en runtime:
 *   - Routes que YA usan withTenant / SET LOCAL → siguen funcionando igual.
 *   - Routes sin SET LOCAL → empiezan a devolver 0 rows (fail-closed). Tests
 *     existentes que dependían del fallback ya se ajustaron en TANDA 0b.
 *
 * Prerrequisito: TANDA 0b mergeada y deployada a prod. Si esta migration
 * corre ANTES que el deploy del refactor de routes, las routes legacy ven
 * 0 rows en producción.
 *
 * Down: restaura la policy permisiva (rollback de emergencia).
 */

const TABLAS_CON_RLS = [
  'ventas', 'venta_items', 'venta_pagos', 'venta_comprobantes', 'ventas_rapidas', 'pagos',
  'productos', 'categorias', 'depositos', 'vendedores', 'canjes', 'catalogo_usados',
  'contactos', 'etiquetas',
  'clientes_cc', 'movimientos_cc', 'items_movimiento_cc',
  'proveedores', 'proveedor_movimientos', 'proveedor_movimiento_items',
  'metodos_pago', 'caja_movimientos', 'movimientos_deudas', 'movimientos_inversiones',
  'cambio_entidades', 'cambio_movimientos',
  'tarjeta_movimientos',
  'comprobantes',
  'envios', 'envio_items',
  'egresos', 'egreso_categorias', 'egresos_recurrentes',
  'proyectos', 'proyecto_participantes', 'proyecto_movimientos',
  'alertas_config', 'conciliaciones', 'conciliacion_lineas',
  'plantillas_garantia', 'user_permissions', 'config',
];

// Predicate fail-closed: el current_setting DEBE estar seteado y matchear.
// Sin SET LOCAL → la conversión a int falla (current_setting devuelve NULL
// con missing_ok=true, y NULL::int es NULL) → la comparación tenant_id = NULL
// es NULL (no TRUE) → la fila no pasa el filtro.
const PREDICATE_CLOSED = `tenant_id = current_setting('app.current_tenant', true)::int`;

// audit_logs: permitir tenant_id NULL para audits del sistema (jobs/crons
// que no tienen tenant context). Sin esto, los audits programáticos se
// vuelven invisibles incluso para queries con SET LOCAL.
const PREDICATE_CLOSED_NULLABLE = `tenant_id IS NULL OR (${PREDICATE_CLOSED})`;

exports.up = (pgm) => {
  for (const tabla of TABLAS_CON_RLS) {
    pgm.sql(`
      DROP POLICY IF EXISTS tenant_isolation ON ${tabla};
      CREATE POLICY tenant_isolation ON ${tabla}
        FOR ALL TO PUBLIC
        USING (${PREDICATE_CLOSED})
        WITH CHECK (${PREDICATE_CLOSED});
    `);
  }

  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
    CREATE POLICY tenant_isolation ON audit_logs
      FOR ALL TO PUBLIC
      USING (${PREDICATE_CLOSED_NULLABLE})
      WITH CHECK (${PREDICATE_CLOSED_NULLABLE});
  `);
};

// Down: restaura el fallback NULL permisivo (estado pre-hardening).
exports.down = (pgm) => {
  const PREDICATE_OPEN = `
    (tenant_id = current_setting('app.current_tenant', true)::int)
    OR current_setting('app.current_tenant', true) IS NULL
    OR current_setting('app.current_tenant', true) = ''
  `;
  const PREDICATE_OPEN_NULLABLE = `tenant_id IS NULL OR (${PREDICATE_OPEN})`;

  for (const tabla of TABLAS_CON_RLS) {
    pgm.sql(`
      DROP POLICY IF EXISTS tenant_isolation ON ${tabla};
      CREATE POLICY tenant_isolation ON ${tabla}
        FOR ALL TO PUBLIC
        USING (${PREDICATE_OPEN})
        WITH CHECK (${PREDICATE_OPEN});
    `);
  }

  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
    CREATE POLICY tenant_isolation ON audit_logs
      FOR ALL TO PUBLIC
      USING (${PREDICATE_OPEN_NULLABLE})
      WITH CHECK (${PREDICATE_OPEN_NULLABLE});
  `);
};

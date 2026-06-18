/**
 * Migration: RLS policy NULLIF empty setting (hotfix TANDA 0c)
 *
 * Bug reproducido en staging 2026-06-18 00:01:23 y 00:38:07:
 *   POST /api/auth/login → 500
 *   err.message: 'invalid input syntax for type integer: ""'
 *   err.routine: pg_strtoint32_safe
 *   sql: SELECT tool, enabled FROM user_permissions WHERE user_id = $1
 *
 * Root cause:
 *   La migration 20260616000002_rls_fail_closed (TANDA 0c) cambió las RLS
 *   policies a fail-closed con predicate:
 *     tenant_id = current_setting('app.current_tenant', true)::int
 *
 *   El comentario de esa migration dice (FALSO):
 *     "Sin SET LOCAL → la conversión a int falla (current_setting devuelve
 *      NULL con missing_ok=true, y NULL::int es NULL)"
 *
 *   La realidad: `current_setting('app.current_tenant', true)` cuando la GUC
 *   no existe devuelve string vacío '' (no NULL). Y `''::int` lanza una
 *   excepción `pg_strtoint32_safe — invalid input syntax for type integer`
 *   en lugar de devolver NULL.
 *
 *   Impacto: cualquier query con db.query (sin withTenant) sobre una tabla
 *   con RLS activo y la conexión "limpia" (sin SET LOCAL previo) explota
 *   con 500. Caso concreto: el SELECT user_permissions del login (líneas
 *   229 y 266 de routes/auth.js) — login no usa withTenant porque corre
 *   antes de resolver el tenant del user.
 *
 *   Por qué era sporadic ("primer intento falla, segundo OK"): cuando el
 *   pool reusa una conexión que tuvo SET LOCAL en una tx previa, el setting
 *   sigue presente en el connection state aunque LOCAL técnicamente deba
 *   limpiarse al COMMIT. Comportamiento dependiente de qué conexión libre
 *   te toca del pool.
 *
 * Fix:
 *   Envolver el current_setting() en NULLIF para convertir '' → NULL antes
 *   del cast. Mismo pattern que YA usa la migration 20260615000003 para
 *   el DEFAULT dinámico — esta inconsistencia es lo que generó el bug.
 *
 *   Predicate nuevo:
 *     tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int
 *
 *   Comportamiento:
 *     - Setting valid (int): NULLIF passa-through → cast OK → match exacto.
 *     - Setting empty '' o no existe: NULLIF → NULL → NULL::int es NULL →
 *       comparación tenant_id = NULL es NULL (NOT TRUE) → fila no pasa.
 *
 *   Resultado: queries sin SET LOCAL devuelven 0 rows (fail-closed correcto)
 *   en lugar de lanzar exception.
 *
 * Tradeoff para login:
 *   El SELECT user_permissions del login va a devolver 0 rows con esta fix
 *   (porque la conexión está limpia). El user logueará con permissions {}
 *   (todo false). Esto es "menos malo" que el 500 actual pero requiere
 *   un fix complementario en routes/auth.js para usar withTenant(tenant_id, ...)
 *   después de resolver el default tenant del user.
 *
 *   Ese fix complementario va en un commit separado (mismo PR) para que sea
 *   reviewable independientemente del cambio de schema.
 *
 * Down:
 *   Restaura el predicate sin NULLIF (vuelve al estado bugueado). Solo para
 *   rollback de emergencia si esta migration rompe algo no previsto.
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

// Predicate fail-closed CON NULLIF:
//   - NULLIF(current_setting('app.current_tenant', true), '') convierte '' a NULL.
//   - NULL::int es NULL.
//   - tenant_id = NULL es NULL (no TRUE) → fila no pasa el filtro.
// Esto reemplaza al predicate previo que castea '' directo a int (revienta).
const PREDICATE_CLOSED = `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int`;

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

// Down: restaura el predicate bugueado sin NULLIF (estado pre-hotfix).
// Solo para rollback de emergencia.
exports.down = (pgm) => {
  const PREDICATE_BROKEN = `tenant_id = current_setting('app.current_tenant', true)::int`;
  const PREDICATE_BROKEN_NULLABLE = `tenant_id IS NULL OR (${PREDICATE_BROKEN})`;

  for (const tabla of TABLAS_CON_RLS) {
    pgm.sql(`
      DROP POLICY IF EXISTS tenant_isolation ON ${tabla};
      CREATE POLICY tenant_isolation ON ${tabla}
        FOR ALL TO PUBLIC
        USING (${PREDICATE_BROKEN})
        WITH CHECK (${PREDICATE_BROKEN});
    `);
  }

  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
    CREATE POLICY tenant_isolation ON audit_logs
      FOR ALL TO PUBLIC
      USING (${PREDICATE_BROKEN_NULLABLE})
      WITH CHECK (${PREDICATE_BROKEN_NULLABLE});
  `);
};

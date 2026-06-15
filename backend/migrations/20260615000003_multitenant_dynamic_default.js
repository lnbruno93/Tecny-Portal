/* eslint-disable camelcase */
/**
 * Migración — PR 4.9 del proyecto multi-tenant (cleanup final).
 *
 * Objetivo: cambiar el DEFAULT de `tenant_id` en las 42 tablas de negocio
 * (y `config`) de `1` literal a una expresión dinámica que lee
 * `app.current_tenant`:
 *
 *   DEFAULT (COALESCE(NULLIF(current_setting('app.current_tenant', true), '')::int, 1))
 *
 * Esto resuelve el último blocker para multi-tenant real:
 *
 *   - ANTES: con DEFAULT 1, todo INSERT que no especificara tenant_id
 *     terminaba con tenant_id=1. Para tenants > 1, el RLS WITH CHECK rechazaba
 *     el INSERT (porque DEFAULT 1 ≠ current_setting('app.current_tenant')).
 *     El portal sólo funcionaba para Lucas (tenant 1).
 *
 *   - AHORA: el DEFAULT lee el valor de `app.current_tenant` seteado por
 *     `db.withTenant(req.tenantId, ...)`. INSERTs sin tenant_id explícito
 *     van automáticamente al tenant del request. Backward compat preservada:
 *     si NO hay SET LOCAL (queries pool legacy, scripts admin, tests), el
 *     COALESCE cae a `1` → comportamiento idéntico al pre-PR.
 *
 *   - PRÓXIMO STEP (futuro, post-validación en prod): se podrá dropear el
 *     fallback `, 1)` del COALESCE para forzar tenant SIEMPRE explícito
 *     (INSERT sin SET LOCAL → error). Hasta entonces el fallback es la
 *     red de seguridad para edge cases de scripts/admin que no setean
 *     tenant.
 *
 * Tablas afectadas: 42 tablas de TABLAS_NEGOCIO (idéntica lista que PR 1) +
 * `config`. NO tocamos `audit_logs` — sigue siendo NULLABLE sin DEFAULT;
 * el handler `audit()` setea tenant_id explícitamente desde `req`.
 *
 * Performance: ALTER COLUMN ... SET DEFAULT es metadata-only en Postgres
 * (no reescribe rows). Operación instantánea para 42 tablas. Safe para
 * deploy normal — incluso sin downtime.
 *
 * Compatibilidad con la migración de RLS (PR 2): la policy WITH CHECK
 * sigue requiriendo que `tenant_id` matchee `current_setting`. El nuevo
 * DEFAULT genera exactamente ese mismo valor, así que el INSERT siempre
 * pasa el WITH CHECK (modulo errores de tipo, que no aplican).
 */

exports.shorthands = undefined;

// Misma lista que la migración 20260615000001 (PR 1). Si esa lista cambia,
// actualizar acá también — son las tablas que llevan tenant_id NOT NULL.
const TABLAS_NEGOCIO = [
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
  'plantillas_garantia', 'user_permissions',
];

// Expresión SQL compartida — la usamos en el ALTER de cada tabla.
// El cast `::int` puede fallar si current_setting devuelve algo no-int,
// pero NULLIF('', '') → NULL, y COALESCE(NULL, 1) → 1. El path normal
// (current_setting devuelve un int en string) funciona sin problema.
const DYNAMIC_DEFAULT = `(COALESCE(NULLIF(current_setting('app.current_tenant', true), '')::int, 1))`;

exports.up = (pgm) => {
  for (const tabla of TABLAS_NEGOCIO) {
    pgm.sql(`ALTER TABLE ${tabla} ALTER COLUMN tenant_id SET DEFAULT ${DYNAMIC_DEFAULT};`);
  }
  // `config` no está en TABLAS_NEGOCIO pero también tiene tenant_id con DEFAULT 1 (PR 1).
  pgm.sql(`ALTER TABLE config ALTER COLUMN tenant_id SET DEFAULT ${DYNAMIC_DEFAULT};`);
};

exports.down = (pgm) => {
  // Rollback: volver a DEFAULT 1 literal (estado pre-PR-4.9).
  for (const tabla of TABLAS_NEGOCIO) {
    pgm.sql(`ALTER TABLE ${tabla} ALTER COLUMN tenant_id SET DEFAULT 1;`);
  }
  pgm.sql(`ALTER TABLE config ALTER COLUMN tenant_id SET DEFAULT 1;`);
};

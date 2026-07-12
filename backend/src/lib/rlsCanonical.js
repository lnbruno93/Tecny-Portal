/**
 * RLS canónico — fuente única de verdad para el aislamiento multi-tenant.
 *
 * 2026-07-12 (auditoría TOTAL Auth P0-1): antes había 2 problemas de gobernanza:
 *
 *   1. La lista `TABLAS_CON_RLS` vivía dentro de una migration (2026-06-18)
 *      y NO se actualizaba cuando se agregaban tablas nuevas. Cada
 *      migration nueva definía su propia policy inline, y no había forma
 *      de auditar coherencia.
 *
 *   2. No había startup assertion que verificara que TODAS las tablas con
 *      `tenant_id` tenían policy `tenant_isolation`. Una tabla nueva con
 *      RLS mal configurado (o sin RLS) podía leakear cross-tenant en
 *      silencio hasta que alguien lo detectara post-hoc.
 *
 * Este módulo consolida el pattern:
 *   · `TABLAS_TENANT_SCOPED` — lista canónica de tablas con RLS estricto
 *     + policy `tenant_isolation` estándar. Cuando agregues una tabla
 *     nueva con `tenant_id`, agregar acá y usar `enableTenantRlsFor` en
 *     la migration.
 *   · `TABLAS_TENANT_ID_SIN_RLS` — whitelist de excepciones intencionales
 *     (audit_queue: cola de jobs; tenant_users / tenant_admin_actions:
 *     super-admin cross-tenant). Documentadas explícitamente.
 *   · `PREDICATE_CLOSED` — fórmula del predicate (fail-closed con NULLIF).
 *     Reusable en migrations que cambien predicates masivamente.
 *   · `enableTenantRlsFor(pgm, tableName)` — helper para migrations
 *     nuevas. En 1 call: enable + force + policy `tenant_isolation` con
 *     el predicate canónico.
 *   · `assertRlsCoverage(pool)` — startup assertion. Compara el schema
 *     real (tablas con `tenant_id` column) contra el canónico + whitelist.
 *     Si hay drift, throw fatal. Corre al boot del server (server.js).
 *
 * Convención para tablas nuevas:
 *   1. Agregar la tabla a `TABLAS_TENANT_SCOPED` acá abajo.
 *   2. En la migration usar `enableTenantRlsFor(pgm, 'mi_tabla_nueva')`
 *      en vez de escribir CREATE POLICY manualmente.
 *   3. Si NO debe tener tenant_isolation por diseño (raro),
 *      documentar en `TABLAS_TENANT_ID_SIN_RLS` con razón explícita.
 */

// ─── Lista canónica ─────────────────────────────────────────────────────
//
// TABLAS_TENANT_SCOPED: todas las tablas con `tenant_id` column que DEBEN
// tener RLS enabled + FORCE + policy `tenant_isolation` con el predicate
// canónico fail-closed.
//
// Ordenadas alfabéticamente para facilitar diffs y evitar duplicados.
// Cualquier tabla nueva con tenant_id se agrega acá y la migration usa
// `enableTenantRlsFor(pgm, 'nombre')`.
// Orden ASCII (mismo que Array.sort() default). El underscore `_` (0x5F)
// viene ANTES de las letras minúsculas — por eso `conciliacion_lineas`
// aparece antes que `conciliaciones`. Mantener este orden para consistencia
// con el test de ordenamiento.
const TABLAS_TENANT_SCOPED = Object.freeze([
  'alertas_config',
  'caja_movimientos',
  'caja_transferencias',
  'cambio_entidades',
  'cambio_movimientos',
  'canjes',
  'catalogo_usados',
  'categorias',
  'chat_conversations',
  'chat_messages',
  'chat_rate_limits',
  'clases_producto',
  'clientes_cc',
  'comprobantes',
  'conciliacion_lineas',
  'conciliaciones',
  'config',
  'contactos',
  'cross_tenant_notifications',
  'depositos',
  'egreso_categorias',
  'egresos',
  'egresos_recurrentes',
  'egresos_recurrentes_overrides',
  'envio_items',
  'envios',
  'etiquetas',
  'items_movimiento_cc',
  'metodos_pago',
  'movimientos_cc',
  'movimientos_deudas',
  'movimientos_inversiones',
  'pagos',
  'plantillas_garantia',
  'productos',
  'proveedor_movimiento_items',
  'proveedor_movimientos',
  'proveedores',
  'proyecciones_mensuales',
  'proyecto_movimientos',
  'proyecto_participantes',
  'proyectos',
  'share_links',
  'tarjeta_movimientos',
  'tenant_user_roles',
  'user_capabilities',
  'vendedores',
  'venta_comprobantes',
  'venta_emails_enviados',
  'venta_items',
  'venta_pagos',
  'ventas',
  'ventas_rapidas',
]);

// audit_logs es un caso especial: tiene tenant_id NULLABLE (permite audits
// de sistema sin tenant context, ej. jobs/crons). El predicate es distinto
// (`tenant_id IS NULL OR ...`). La tabla se particiona por mes — las
// particiones heredan la policy del parent. Al enumerar en pg_policies,
// solo aparece 'audit_logs' — las particiones no.
const TABLA_AUDIT_LOGS_NULLABLE = 'audit_logs';

// ─── Excepciones intencionales ──────────────────────────────────────────
//
// TABLAS_TENANT_ID_SIN_RLS: tablas que TIENEN `tenant_id` pero NO deben
// tener RLS. Cada entrada requiere una razón explícita. Estas tablas
// no aparecen en pg_policies con policy `tenant_isolation` y el startup
// assertion las excluye del diff.
const TABLAS_TENANT_ID_SIN_RLS = Object.freeze({
  audit_queue:
    'Cola de audits programáticos (jobs internos). Los workers consumen ' +
    'con adminQuery/BYPASSRLS. No expuesta a rutas de tenant. Tenant_id ' +
    'se usa solo para agregación.',
  tenant_users:
    'Relación N:M user↔tenant. Se accede desde /api/admin/* y flows de ' +
    'super-admin cross-tenant. El aislamiento se hace por capability ' +
    '(requireSuperAdmin) en el endpoint, no por RLS.',
  tenant_admin_actions:
    'Audit trail de acciones de super-admin cross-tenant (plan_change, ' +
    'delete_tenant, etc.). El super-admin necesita ver todas las filas. ' +
    'Aislamiento por capability, no RLS.',
});

// ─── Predicate canónico ─────────────────────────────────────────────────
//
// PREDICATE_CLOSED: fail-closed con NULLIF para manejar el edge case
// donde `current_setting('app.current_tenant', true)` devuelve '' (empty
// string, cuando la GUC no existe) en vez de NULL.
//
// Historia (bug staging 2026-06-18):
//   Sin NULLIF: `''::int` throwea con pg_strtoint32_safe.
//   Con NULLIF: `NULLIF('','')` = NULL → `NULL::int` = NULL →
//   `tenant_id = NULL` = NULL (no TRUE) → fila no pasa. Fail-closed
//   correcto sin exception.
//
// Referencia: migration `20260618000001_rls_nullif_empty_setting.js`.
const PREDICATE_CLOSED =
  `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int`;

// Para audit_logs: tenant_id NULLABLE (audits de sistema).
const PREDICATE_CLOSED_NULLABLE = `tenant_id IS NULL OR (${PREDICATE_CLOSED})`;

// ─── Helper para migrations ─────────────────────────────────────────────
//
// enableTenantRlsFor: aplica ENABLE + FORCE + policy `tenant_isolation`
// canónica sobre una tabla. Uso en migrations que crean tablas nuevas
// con tenant_id.
//
// Ejemplo:
//   const { enableTenantRlsFor } = require('../src/lib/rlsCanonical');
//   exports.up = (pgm) => {
//     pgm.sql(`CREATE TABLE mi_tabla (id SERIAL, tenant_id INT NOT NULL);`);
//     enableTenantRlsFor(pgm, 'mi_tabla');
//   };
//
// Importante: la migration DEBE agregar la tabla a `TABLAS_TENANT_SCOPED`
// en este archivo también, sino el startup assertion la va a detectar
// como huérfana (y romper el boot).
function enableTenantRlsFor(pgm, tableName) {
  pgm.sql(`
    ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON ${tableName};
    CREATE POLICY tenant_isolation ON ${tableName}
      FOR ALL TO PUBLIC
      USING (${PREDICATE_CLOSED})
      WITH CHECK (${PREDICATE_CLOSED});
  `);
}

// ─── Startup assertion ──────────────────────────────────────────────────
//
// assertRlsCoverage: verifica que el schema real coincide con el canónico.
// Corre al boot del server. Si detecta drift, throw fatal → el pod no
// arranca, se detecta en Railway logs, y no llega tráfico a un backend
// con RLS mal configurado.
//
// Chequea 3 invariantes:
//   1. Toda tabla en TABLAS_TENANT_SCOPED tiene policy `tenant_isolation`.
//   2. Toda tabla con column `tenant_id` está en TABLAS_TENANT_SCOPED
//      O en TABLAS_TENANT_ID_SIN_RLS (whitelist). Sin excepción silenciosa.
//   3. audit_logs tiene su policy nullable.
//
// Costa ~2 queries al boot (una a information_schema.columns, otra a
// pg_policies). Trivial.
//
// @param {object} pool — pg Pool o Client
// @returns {Promise<{ok: true, checked: number}>} en success
// @throws {Error} con mensaje enumerando el drift si hay problema
async function assertRlsCoverage(pool) {
  // Query 1: tablas con tenant_id (excluyendo particiones de audit_logs).
  // La regex del NOT LIKE excluye 'audit_logs_YYYY_MM' y demás particiones.
  const { rows: colRows } = await pool.query(`
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN pg_class pc ON pc.relname = c.table_name
      JOIN pg_namespace pn ON pn.oid = pc.relnamespace
     WHERE c.table_schema = 'public'
       AND c.column_name = 'tenant_id'
       AND pn.nspname = 'public'
       AND pc.relkind = 'r'                         -- solo tablas base (no particiones)
       AND c.table_name NOT LIKE 'audit_logs_%'     -- excluir particiones audit
     ORDER BY c.table_name
  `);
  const tablasConTenantId = new Set(colRows.map((r) => r.table_name));

  // Query 2: tablas con policy 'tenant_isolation'.
  const { rows: polRows } = await pool.query(`
    SELECT tablename
      FROM pg_policies
     WHERE policyname = 'tenant_isolation'
       AND schemaname = 'public'
     ORDER BY tablename
  `);
  const tablasConPolicy = new Set(polRows.map((r) => r.tablename));

  // ─── Chequeos ─────────────────────────────────────────────────────────
  const errores = [];

  // Chequeo 1: tablas en TABLAS_TENANT_SCOPED que NO tienen policy.
  for (const tabla of TABLAS_TENANT_SCOPED) {
    if (!tablasConPolicy.has(tabla)) {
      errores.push(
        `Tabla "${tabla}" está en TABLAS_TENANT_SCOPED pero NO tiene policy ` +
        `'tenant_isolation'. Aplicar enableTenantRlsFor en una migration.`
      );
    }
  }

  // Chequeo 2: tablas con tenant_id que NO están ni en canónica ni en
  // whitelist. Huérfanas — leak potencial.
  const tablasCanonicas = new Set(TABLAS_TENANT_SCOPED);
  const tablasWhitelist = new Set(Object.keys(TABLAS_TENANT_ID_SIN_RLS));
  for (const tabla of tablasConTenantId) {
    // audit_logs se maneja aparte (predicate nullable).
    if (tabla === TABLA_AUDIT_LOGS_NULLABLE) continue;
    if (tablasCanonicas.has(tabla)) continue;
    if (tablasWhitelist.has(tabla)) continue;
    errores.push(
      `Tabla "${tabla}" tiene column 'tenant_id' pero NO está en ` +
      `TABLAS_TENANT_SCOPED ni en TABLAS_TENANT_ID_SIN_RLS (whitelist). ` +
      `Agregar a la canónica + migration con enableTenantRlsFor, O ` +
      `documentar la excepción en TABLAS_TENANT_ID_SIN_RLS con razón.`
    );
  }

  // Chequeo 3: audit_logs debe tener SU policy (predicate nullable).
  if (!tablasConPolicy.has(TABLA_AUDIT_LOGS_NULLABLE)) {
    errores.push(
      `Tabla "${TABLA_AUDIT_LOGS_NULLABLE}" no tiene policy 'tenant_isolation'. ` +
      `Debe existir con predicate nullable (${PREDICATE_CLOSED_NULLABLE}).`
    );
  }

  if (errores.length > 0) {
    const err = new Error(
      `[rlsCanonical] Drift detectado entre schema y canónico. ` +
      `El boot del server se aborta para evitar leaks cross-tenant.\n\n` +
      errores.map((e, i) => `${i + 1}. ${e}`).join('\n')
    );
    err.code = 'RLS_COVERAGE_DRIFT';
    throw err;
  }

  return { ok: true, checked: tablasConTenantId.size };
}

module.exports = {
  TABLAS_TENANT_SCOPED,
  TABLAS_TENANT_ID_SIN_RLS,
  TABLA_AUDIT_LOGS_NULLABLE,
  PREDICATE_CLOSED,
  PREDICATE_CLOSED_NULLABLE,
  enableTenantRlsFor,
  assertRlsCoverage,
};

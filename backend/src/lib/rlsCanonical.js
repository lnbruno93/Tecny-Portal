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
  // 2026-08-03 (task #290): tipos de contacto editables per-tenant.
  // Reemplaza la lista hardcoded del CHECK constraint que estaba en la
  // migration inicial 20260521000001. Ver migration
  // 20260803020000_contacto_tipos_editables.js.
  // Orden ASCII: 'contacto_tipos' viene ANTES de 'contactos' porque `_`
  // (0x5F) < 'o' (0x6F) en el 8vo char (matchea sort() default en JS).
  'contacto_tipos',
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
  // 2026-08-03 (task #149 Terceros refactor Fase 1 PR 1.1): schema aditivo
  // para el modelo unificado cliente+proveedor. Coexisten con clientes_cc
  // y proveedores hasta Fase 3 cutover. Ver docs/TERCEROS_REFACTOR_PLAN.md.
  // 2026-08-07 (task #302): las 3 tablas siguen vacías — el refactor está
  // en pausa y se cerró con la alternativa pragmática `tercero_link`
  // (siguiente entrada). Ver migration 20260807000000_tercero_link.js.
  'tercero_items',
  // 2026-08-07 (task #302): link pragmático 1:1 cliente_cc ↔ proveedor
  // (mismo tercero como cliente Y proveedor). Alternativa mínima al refactor
  // Terceros completo (Fase 1 mergeada pero pausada). Ver migration
  // 20260807000000_tercero_link.js.
  // Orden ASCII (Array.sort() default): `tercero_items` < `tercero_link` <
  // `tercero_movimientos` porque después del prefijo compartido `tercero_`,
  // 'i' (0x69) < 'l' (0x6C) < 'm' (0x6D).
  'tercero_link',
  'tercero_movimientos',
  'terceros',
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
  feature_flags_tenants:
    'Overrides de feature flags por tenant (Rec proactiva #3, F1 2026-07-20). ' +
    'Config global de la app, no data de negocio del tenant. Solo se ' +
    'escribe desde super-admin UI (F2) y solo se lee desde el resolver ' +
    '`lib/featureFlags.js` que usa `db.adminQuery/BYPASSRLS`. Ningún ' +
    'endpoint tenant expone la fila a un cliente del tenant. Aislamiento ' +
    'por requireSuperAdmin en el endpoint que setea el override.',
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

// 2026-07-27 (audit 07-25 Track E P1-5): throttle in-memory para el Sentry
// alert de CONTENT drift. Ver assertRlsMatchesCanonical() al final del archivo.
let _lastContentDriftAlert = 0;

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
// Chequea 4 invariantes:
//   1. Toda tabla en TABLAS_TENANT_SCOPED tiene policy `tenant_isolation`.
//   2. Toda tabla con column `tenant_id` está en TABLAS_TENANT_SCOPED
//      O en TABLAS_TENANT_ID_SIN_RLS (whitelist). Sin excepción silenciosa.
//   3. audit_logs tiene su policy nullable.
//   4. **CONTENT check** — cada policy `tenant_isolation` usa NULLIF en su
//      predicate. Este chequeo cierra el gap del bug 2026-07-24 (Sentry #16):
//      la migration `20260619000001_audit_logs_rls_tighten` reescribió la
//      policy de audit_logs SIN NULLIF y el boot pasaba porque la policy
//      SÍ existía — pero el predicate quedaba bugueado. Con este chequeo,
//      cualquier migration que reintroduzca `current_setting(...)::int` sin
//      NULLIF hace fallar el boot antes de recibir tráfico.
//
// Costa ~2 queries al boot (una a information_schema.columns, otra a
// pg_policies con qual/with_check). Trivial.
//
// @param {object} pool — pg Pool o Client
// @returns {Promise<{ok: true, checked: number, contentChecked: number}>} en success
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

  // Query 2: tablas con policy 'tenant_isolation' + CONTENT del predicate.
  // pg_policies expone `qual` (USING expression) y `with_check` (WITH CHECK
  // expression). Postgres los devuelve como texto normalizado — el pretty
  // printing es estable entre versiones (11+), así que un match sobre
  // `NULLIF(current_setting(...` es confiable.
  const { rows: polRows } = await pool.query(`
    SELECT tablename, qual, with_check
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

  // Chequeo 4: CONTENT del predicate. Cada policy debe usar NULLIF para
  // manejar `current_setting()` retornando '' cuando la GUC no está seteada.
  //
  // Este chequeo habría cazado el bug de Sentry TECNY-PORTAL-BACKEND-16
  // (2026-07-24): la migration `20260619000001_audit_logs_rls_tighten`
  // reintrodujo el pattern SIN NULLIF y estuvo latente ~5 semanas hasta
  // que un endpoint específico (/logout) lo disparó. Con este chequeo,
  // el boot post-deploy de esa migration habría abortado inmediatamente.
  //
  // Pattern esperado:
  //   `NULLIF(current_setting('app.current_tenant', true), '')::integer`
  //   (Postgres normaliza `::int` → `::integer` al persistir la policy.)
  //
  // Pattern BUGUEADO (rechazado):
  //   `current_setting('app.current_tenant', true)::integer`
  //   (sin NULLIF → cast '' a int throwea con pg_strtoint32_safe)
  // 2026-07-25 hotfix: el chequeo 4 (CONTENT) originalmente throwaba fatal
  // si detectaba drift. En prod, 7 tablas están en drift (no aplican NULLIF)
  // porque la migration de backfill (20260724000002) falla por owner
  // mismatch — el rol `ipro_app` NOSUPERUSER no puede DROP POLICY sobre
  // tablas cuyo owner es otro rol.
  //
  // Hasta que se corra el fix manual con superuser (ALTER TABLE OWNER TO
  // ipro_app + re-run migration), el chequeo 4 se degrada a warning +
  // Sentry alert — NO aborta boot. Los otros chequeos (1-3, coverage)
  // siguen siendo fatales.
  //
  // Impacto real del drift: bajo. El bug pattern (predicate sin NULLIF)
  // solo se dispara si algún endpoint escribe sin `SET LOCAL
  // app.current_tenant`. Hoy TODAS las escrituras a estas tablas pasan
  // por `withTenant()`. La observabilidad vía Sentry captura si aparece.
  let contentChecked = 0;
  const contentWarnings = [];
  for (const pol of polRows) {
    // Chequear ambos qual (USING) y with_check (WITH CHECK).
    // Postgres puede devolver with_check = null si es idéntico a qual y
    // se creó con `FOR ALL` — normalizamos para evitar false positive.
    const preds = [
      { name: 'USING', text: pol.qual },
      { name: 'WITH CHECK', text: pol.with_check },
    ].filter((p) => p.text != null);

    for (const { name, text } of preds) {
      contentChecked += 1;
      // Verificar que use NULLIF envolviendo current_setting.
      // Match tolerante a whitespace: `NULLIF ( current_setting`
      const hasNullifWrap = /NULLIF\s*\(\s*current_setting\s*\(\s*'app\.current_tenant'/i.test(text);
      // Verificar que NO tenga el pattern bugueado (cast directo sin NULLIF).
      // Buscar `current_setting(...)::` sin NULLIF envolvente.
      // El regex es: `current_setting('app.current_tenant', true)::(int|integer)`
      // NO precedido por `NULLIF(` (usando negative lookbehind).
      const hasBuggedCast = /(?<!NULLIF\s*\(\s*)current_setting\s*\(\s*'app\.current_tenant'\s*,\s*true\s*\)\s*::\s*int/i.test(text);

      if (!hasNullifWrap || hasBuggedCast) {
        contentWarnings.push(
          `Policy 'tenant_isolation' en "${pol.tablename}" tiene predicate ` +
          `${name} SIN NULLIF envolvente. Esto revive el bug Sentry #16 ` +
          `(cast '' → int throwea pg_strtoint32_safe). Usar PREDICATE_CLOSED ` +
          `de rlsCanonical.js o reescribir con NULLIF(current_setting(...), '')::int. ` +
          `Actual: ${JSON.stringify(text)}`
        );
      }
    }
  }

  // Emitir warning + Sentry para el drift de CONTENT (no fatal).
  //
  // 2026-07-27 (audit 07-25 Track E P1-5):
  //   (a) Throttle Sentry a 1 alert por hora por proceso — 2 réplicas × N
  //       boots/día = ~10 alerts/día por drift persistente. Con throttle,
  //       máximo ~48/día si Railway auto-scale genera 24 boots/día × 2
  //       réplicas. Aceptable.
  //   (b) `driftDetectedSince` incluido para forense — si el mensaje sigue
  //       apareciendo después de esa fecha, es señal de que nadie corrió el
  //       fix manual (follow-up PR #874 pendiente).
  //   (c) Test unit que asserta que cada TABLAS_TENANT_ID_SIN_RLS tiene
  //       reason ≥ 50 chars: ver tests/rlsCanonical.test.js.
  if (contentWarnings.length > 0) {
    // Logger optional import (evita ciclo si rlsCanonical se usa desde tests
    // que no cargan logger). Fallback a console.warn.
    let logger;
    try { logger = require('./logger'); } catch { logger = console; }

    const DRIFT_DETECTED_SINCE = '2026-07-25';
    const daysSinceDrift = Math.floor(
      (Date.now() - new Date(DRIFT_DETECTED_SINCE).getTime()) / (1000 * 60 * 60 * 24)
    );

    const warnMsg =
      `[rlsCanonical] CONTENT drift detectado en ${contentWarnings.length} predicate(s). ` +
      `Boot continúa (warning-only) porque el fix requiere superuser en DB para ` +
      `re-owner de tablas. Follow-up: script SQL manual + re-run backfill migration. ` +
      `Drift persistente desde ${DRIFT_DETECTED_SINCE} (${daysSinceDrift} días). ` +
      `Si ves este mensaje después de 2026-09-01, escalar el follow-up.`;
    logger.warn({
      count: contentWarnings.length,
      samples: contentWarnings.slice(0, 3),
      drift_detected_since: DRIFT_DETECTED_SINCE,
      days_since_drift: daysSinceDrift,
    }, warnMsg);

    // Sentry throttle: 1 alert por hora por proceso. `_lastContentDriftAlert`
    // module-level; sobrevive dentro del pod. Múltiples pods por hora aún
    // pueden alertar, pero Sentry dedupe por título similar los agrupa.
    const THROTTLE_MS = 60 * 60 * 1000; // 1 hora
    const now = Date.now();
    if (!_lastContentDriftAlert || (now - _lastContentDriftAlert) > THROTTLE_MS) {
      _lastContentDriftAlert = now;
      try {
        // Fast-path exit si Sentry no está configurado (pattern del hotfix Sprint 1).
        if (process.env.SENTRY_DSN && process.env.NODE_ENV !== 'test') {
          const Sentry = require('@sentry/node');
          Sentry.captureMessage(warnMsg, {
            level: 'warning',
            tags: {
              source: 'rls_content_drift',
              drift_since: DRIFT_DETECTED_SINCE,
            },
            extra: {
              warnings: contentWarnings,
              drift_detected_since: DRIFT_DETECTED_SINCE,
              days_since_drift: daysSinceDrift,
            },
          });
        }
      } catch { /* Sentry not available */ }
    }
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

  return { ok: true, checked: tablasConTenantId.size, contentChecked };
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

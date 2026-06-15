/* eslint-disable camelcase */
/**
 * Migración — PR 2 del proyecto multi-tenant (iPro SaaS).
 *
 * Habilita Row-Level Security (RLS) en Postgres sobre las 43 tablas que llevan
 * `tenant_id`. RLS es la "red de seguridad" del aislamiento entre clientes:
 * incluso si un endpoint nuevo OLVIDA filtrar por `tenant_id` en su WHERE,
 * Postgres NO devuelve datos de otros tenants. Defense-in-depth.
 *
 * ── Cómo funciona la policy ──────────────────────────────────────────────────
 *
 *   USING / WITH CHECK:
 *     (tenant_id = current_setting('app.current_tenant', true)::int)
 *     OR current_setting('app.current_tenant', true) IS NULL
 *
 *   - `current_setting('app.current_tenant', true)`: lee la GUC variable de
 *     sesión. El segundo arg `missing_ok = true` hace que devuelva NULL si
 *     no está seteada (sin esto, tira error).
 *
 *   - Mientras estamos en single-tenant (Lucas con tenant 1), el middleware
 *     todavía no setea esa variable → la policy resuelve a TRUE para todas
 *     las filas → comportamiento idéntico al pre-RLS.
 *
 *   - Cuando PR 3 agregue el middleware que setea `app.current_tenant` por
 *     request, la policy filtra automáticamente: queries de tenant A nunca
 *     ven datos de tenant B, sin importar el WHERE explícito del query.
 *
 * ── FORCE ROW LEVEL SECURITY ─────────────────────────────────────────────────
 *
 *   Por default, RLS NO se aplica al OWNER de la tabla. En Railway/staging
 *   el role de la app suele ser owner (creó las tablas via migrations). Sin
 *   `FORCE`, la app bypassa RLS y la policy es decorativa.
 *
 *   `ALTER TABLE ... FORCE ROW LEVEL SECURITY` fuerza RLS también para el
 *   owner — la única excepción son los superusers, que vos NO usás en
 *   runtime (solo para mantenimiento manual).
 *
 * ── audit_logs (particionado) ────────────────────────────────────────────────
 *
 *   ENABLE RLS en la parent table se propaga automáticamente a partitions
 *   existentes y futuras. No necesitamos hacer nada especial — Postgres lo
 *   maneja.
 *
 *   PERO `tenant_id` en audit_logs es NULLABLE (decisión de PR 1). La policy
 *   debe contemplar ese caso. La condición `tenant_id IS NULL` se permite
 *   siempre (logs legacy que no tienen tenant asignado). Cuando PR 3 active
 *   el seteo de tenant_id en audit(), todos los logs nuevos lo tendrán.
 *
 * ── Tests ────────────────────────────────────────────────────────────────────
 *
 *   Los 1054 tests existentes deben seguir pasando porque ninguno setea
 *   `app.current_tenant` → la policy permite todo. PR 6 agregará tests de
 *   aislamiento que SÍ setean current_tenant y validan que el aislamiento
 *   se cumple.
 *
 * ── Performance ──────────────────────────────────────────────────────────────
 *
 *   RLS agrega un predicado implícito a cada query. Postgres lo combina con
 *   los predicados explícitos y usa los indexes existentes. Como en PR 1 ya
 *   creamos indexes compuestos `(tenant_id, ...)` en las tablas hot, el costo
 *   adicional es despreciable. Si en alguna query crítica vemos degradación,
 *   ajustamos el índice puntualmente.
 */

exports.shorthands = undefined;

// Lista canónica: TODAS las tablas que en PR 1 recibieron `tenant_id`.
// Cualquier cambio acá debe reflejarse también en la migration 001 y en el
// middleware de PR 3. Mantener sincronizadas las tres listas.
const TABLAS_CON_RLS = [
  // Ventas
  'ventas', 'venta_items', 'venta_pagos', 'venta_comprobantes', 'ventas_rapidas', 'pagos',
  // Inventario
  'productos', 'categorias', 'depositos', 'vendedores', 'canjes', 'catalogo_usados',
  // Contactos & etiquetas
  'contactos', 'etiquetas',
  // B2B CC
  'clientes_cc', 'movimientos_cc', 'items_movimiento_cc',
  // Proveedores
  'proveedores', 'proveedor_movimientos', 'proveedor_movimiento_items',
  // Cajas
  'metodos_pago', 'caja_movimientos', 'movimientos_deudas', 'movimientos_inversiones',
  // Cambios de divisa
  'cambio_entidades', 'cambio_movimientos',
  // Tarjetas
  'tarjeta_movimientos',
  // Financiera
  'comprobantes',
  // Envíos
  'envios', 'envio_items',
  // Egresos
  'egresos', 'egreso_categorias', 'egresos_recurrentes',
  // Proyectos
  'proyectos', 'proyecto_participantes', 'proyecto_movimientos',
  // Operacional / config
  'alertas_config', 'conciliaciones', 'conciliacion_lineas',
  'plantillas_garantia', 'user_permissions', 'config',
];

// Predicate de la policy. Permite la fila si:
//   - El tenant_id coincide con el de la sesión actual, O
//   - No hay tenant en la sesión (modo single-tenant compat: tests, ETL, etc.)
// Para audit_logs además permitimos tenant_id NULL (logs legacy).
const POLICY_PREDICATE = `
  (tenant_id = current_setting('app.current_tenant', true)::int)
  OR current_setting('app.current_tenant', true) IS NULL
  OR current_setting('app.current_tenant', true) = ''
`;

const POLICY_PREDICATE_NULLABLE = `
  tenant_id IS NULL
  OR ${POLICY_PREDICATE}
`;

exports.up = (pgm) => {
  // 1. Tablas estándar con tenant_id NOT NULL
  for (const tabla of TABLAS_CON_RLS) {
    pgm.sql(`
      ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${tabla}
        FOR ALL TO PUBLIC
        USING (${POLICY_PREDICATE})
        WITH CHECK (${POLICY_PREDICATE});
    `);
  }

  // 2. Caso especial: audit_logs (particionado, tenant_id NULLABLE).
  //    La policy permite filas con tenant_id NULL (logs históricos pre-PR1)
  //    además de las que matchean current_tenant.
  pgm.sql(`
    ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON audit_logs
      FOR ALL TO PUBLIC
      USING (${POLICY_PREDICATE_NULLABLE})
      WITH CHECK (${POLICY_PREDICATE_NULLABLE});
  `);
};

exports.down = (pgm) => {
  // Drop policies + disable RLS, en orden inverso.
  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
    ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
  `);

  for (const tabla of TABLAS_CON_RLS) {
    pgm.sql(`
      DROP POLICY IF EXISTS tenant_isolation ON ${tabla};
      ALTER TABLE ${tabla} NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE ${tabla} DISABLE ROW LEVEL SECURITY;
    `);
  }
};

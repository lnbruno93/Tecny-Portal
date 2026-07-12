/**
 * Migration: normalizar nombres de policies RLS al canónico.
 *
 * 2026-07-12 (auditoría TOTAL Auth P0-1):
 *
 * Contexto: las migrations 20260616000002 y 20260618000001 canonizaron
 * el nombre de la policy multi-tenant a `tenant_isolation` para TODAS
 * las tablas con `tenant_id`. Sin embargo, 2 migrations posteriores
 * usaron nombres custom para su policy:
 *
 *   · `caja_transferencias` (20260704000001) →
 *     policyname: 'caja_transferencias_tenant_isolation'
 *   · `venta_emails_enviados` (20260630100001) →
 *     policyname: 'venta_emails_tenant_isolation'
 *
 * Efecto: si mañana una migration itera `pg_policies WHERE policyname
 * = 'tenant_isolation'` para aplicar un cambio masivo (ej. rotar el
 * predicate), estas 2 tablas quedan OLVIDADAS. Bug silencioso.
 *
 * Fix: drop + recreate con el nombre canónico. El predicate NO cambia
 * (ya usaban `PREDICATE_CLOSED` correctamente).
 *
 * Down: revierte a los nombres custom, por si algún dashboard admin
 * los leyera por nombre.
 */

const {
  enableTenantRlsFor,
} = require('../src/lib/rlsCanonical');

// Nombres viejos custom a normalizar.
const POLICIES_A_RENOMBRAR = [
  { tabla: 'caja_transferencias',    nombreViejo: 'caja_transferencias_tenant_isolation' },
  { tabla: 'venta_emails_enviados',  nombreViejo: 'venta_emails_tenant_isolation' },
];

exports.up = (pgm) => {
  for (const { tabla, nombreViejo } of POLICIES_A_RENOMBRAR) {
    // Drop la policy vieja + recreate con el nombre canónico usando el
    // helper. enableTenantRlsFor es idempotente (hace DROP IF EXISTS del
    // nombre canónico también, después crea).
    pgm.sql(`DROP POLICY IF EXISTS ${nombreViejo} ON ${tabla};`);
    enableTenantRlsFor(pgm, tabla);
  }
};

exports.down = (pgm) => {
  // Revert: dropea el canónico, recrea con el nombre viejo. Predicate
  // igual (era el mismo).
  const PREDICATE = `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int`;
  for (const { tabla, nombreViejo } of POLICIES_A_RENOMBRAR) {
    pgm.sql(`
      DROP POLICY IF EXISTS tenant_isolation ON ${tabla};
      CREATE POLICY ${nombreViejo} ON ${tabla}
        FOR ALL TO PUBLIC
        USING (${PREDICATE})
        WITH CHECK (${PREDICATE});
    `);
  }
};

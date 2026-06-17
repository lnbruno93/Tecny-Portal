/**
 * Fix multi-tenant: el index UNIQUE `idx_metodos_pago_financiera` estaba
 * globalmente único (sin tenant_id), de la era pre-multitenant. Eso bloqueaba
 * la creación de cajas financieras en tenants nuevos (descubierto al
 * implementar /signup en TANDA 2.1).
 *
 * Fix: drop + re-crear scopeado por tenant_id. Una caja financiera por tenant.
 *
 * Ver migration 20260616000006 para el fix análogo de idx_metodos_pago_nombre.
 *
 * Idempotente. Down restaura comportamiento global — solo correr en single-tenant.
 */

exports.up = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_metodos_pago_financiera;
    CREATE UNIQUE INDEX idx_metodos_pago_financiera
      ON metodos_pago (tenant_id)
      WHERE es_financiera = true AND deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_metodos_pago_financiera;
    CREATE UNIQUE INDEX idx_metodos_pago_financiera
      ON metodos_pago ((1))
      WHERE es_financiera = true AND deleted_at IS NULL;
  `);
};

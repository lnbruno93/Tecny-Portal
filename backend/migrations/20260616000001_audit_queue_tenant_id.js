/**
 * Migration: audit_queue.tenant_id
 *
 * Contexto (TANDA 0a hardening 2026-06-16):
 *   La auditoría multi-tenant detectó que `audit_logs.tenant_id` existe desde
 *   PR 1 pero NUNCA se setea — el INSERT de `audit()` no lo pasa, así que
 *   todos los rows post-PR1 tienen tenant_id NULL. Eso significa que la
 *   policy RLS de audit_logs sólo los retorna gracias al fallback
 *   "OR current_setting IS NULL" (que vamos a eliminar en TANDA 0c), y peor:
 *   un endpoint mal protegido puede listar audit cross-tenant.
 *
 *   Esta migration prepara la pieza faltante: `audit_queue` (path async) NO
 *   tenía columna tenant_id porque PR 1 la marcó como "tabla de sistema sin
 *   tenant_id". Pero el worker mueve rows de audit_queue → audit_logs, y si
 *   audit_queue no tiene tenant_id, el worker no tiene de dónde sacarlo.
 *
 *   Cambios:
 *     - ALTER TABLE audit_queue ADD tenant_id (NULLABLE — audits programáticos
 *       de jobs/crons no tienen tenant en su contexto).
 *     - Index para queries de admin que listen audit por tenant.
 *
 * El INSERT real en `audit()` y la lectura en `auditQueueWorker.js` se
 * actualizan en commits siguientes — pueden mergearse en cualquier orden con
 * esta migration porque NULL es backward-compat.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE audit_queue
      ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_audit_queue_tenant
      ON audit_queue (tenant_id) WHERE tenant_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_audit_queue_tenant;
    ALTER TABLE audit_queue DROP COLUMN IF EXISTS tenant_id;
  `);
};

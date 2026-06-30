/**
 * Migration: venta_emails_enviados — agrega 'pending' al CHECK de status.
 *
 * Auditoría 2026-06-30 E-03 — perf: el endpoint POST
 * /api/ventas/:id/enviar-comprobante (reenvío manual) hacía await del PDF
 * (sync CPU 150-500ms) + Resend send (200-1500ms red) inline. Esto bloquea
 * el event loop y mantiene el HTTP open >1s. Patrón a replicar: el POST
 * /api/ventas (creación) ya hace setImmediate post-COMMIT — el cliente
 * recibe respuesta inmediata y el envío corre en background.
 *
 * Diseño con tres estados:
 *   - 'pending': row insertada cuando se acepta el job (HTTP 202 al cliente).
 *     El frontend polea `GET /api/ventas/:id/emails-enviados` para ver el
 *     status final.
 *   - 'sent':    Resend respondió OK. resend_msg_id populado.
 *   - 'failed':  Resend rechazó o errores de red/PDF. error_msg populado.
 *
 * Cambios al schema:
 *   1. CHECK (status IN (...)) — agregar 'pending'.
 *   2. CHECK chk_error_msg_when_failed — relajar: status='pending' también
 *      requiere error_msg=NULL (igual que 'sent').
 *
 * Estrategia compatible: postgres NO permite ALTER CHECK en sitio. Se DROP +
 * ADD con el mismo nombre. Filas existentes quedan intactas (todas son
 * 'sent' o 'failed', ambos siguen cumpliendo el nuevo invariante).
 *
 * Down: vuelve a los 2 estados originales. Si hay filas 'pending' al
 * downgrade, el CHECK las rechazaría — pero `pending` es estado transitorio
 * (segundos), así que la chance de tener una rollbackeando es baja; aún así
 * la down query las marca como 'failed' antes para no romper la migración.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Status check: agregar 'pending' como estado válido.
    ALTER TABLE venta_emails_enviados
      DROP CONSTRAINT IF EXISTS venta_emails_enviados_status_check;
    ALTER TABLE venta_emails_enviados
      ADD CONSTRAINT venta_emails_enviados_status_check
      CHECK (status IN ('pending','sent','failed'));

    -- 2. Invariante: error_msg solo populado cuando status='failed'.
    --    Tanto 'pending' como 'sent' requieren error_msg=NULL.
    ALTER TABLE venta_emails_enviados
      DROP CONSTRAINT IF EXISTS chk_error_msg_when_failed;
    ALTER TABLE venta_emails_enviados
      ADD CONSTRAINT chk_error_msg_when_failed
      CHECK (
        (status = 'failed')
        OR (status IN ('pending', 'sent') AND error_msg IS NULL)
      );

    -- 3. Idx para que el background job pueda detectar pendings huérfanos
    --    (crashed worker, rare). Partial: solo indexa filas 'pending', costo
    --    despreciable porque su steady-state count es ~0.
    CREATE INDEX IF NOT EXISTS idx_venta_emails_pending
      ON venta_emails_enviados (sent_at)
      WHERE status = 'pending';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_venta_emails_pending;

    -- Si hay filas 'pending' (cola en vuelo), marcarlas como 'failed' antes
    -- del CHECK más estricto. Sentinel error_msg para que el operador sepa
    -- por qué (no es un fallo real de Resend).
    UPDATE venta_emails_enviados
       SET status = 'failed',
           error_msg = 'migration downgrade: pending row at rollback'
     WHERE status = 'pending';

    ALTER TABLE venta_emails_enviados
      DROP CONSTRAINT IF EXISTS chk_error_msg_when_failed;
    ALTER TABLE venta_emails_enviados
      ADD CONSTRAINT chk_error_msg_when_failed
      CHECK ((status = 'failed') OR (status = 'sent' AND error_msg IS NULL));

    ALTER TABLE venta_emails_enviados
      DROP CONSTRAINT IF EXISTS venta_emails_enviados_status_check;
    ALTER TABLE venta_emails_enviados
      ADD CONSTRAINT venta_emails_enviados_status_check
      CHECK (status IN ('sent','failed'));
  `);
};

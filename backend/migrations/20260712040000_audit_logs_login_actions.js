/**
 * Extender CHECK constraint de `audit_logs.accion` (+ `audit_queue.accion`)
 * para incluir eventos de autenticación.
 *
 * 2026-07-12 (auditoría TOTAL Auth P1-1):
 *
 * Contexto: hoy los eventos auth (login exitoso/fallido, lockout, logout,
 * forgot-password) solo dejan trace en `logger.warn/info` que va a
 * Railway/Sentry con retención ~7d. Un incidente forense detectado 2
 * semanas después ("¿desde qué IP ingresó el atacante?") no tiene evidencia.
 *
 * Sarbanes-Oxley / PCI / ISO 27001 exigen audit trail persistido para
 * eventos auth — bloqueante si Tecny escala a clientes enterprise.
 *
 * Fix: extender el CHECK constraint para permitir 5 acciones nuevas:
 *   · LOGIN                    — login exitoso (con o sin 2FA)
 *   · LOGIN_FAILED             — password/2FA/lockout — cubre TODOS los rechazos
 *   · LOCKOUT                  — lockout disparado (10 intentos)
 *   · LOGOUT                   — logout explícito
 *   · PASSWORD_RESET_REQUESTED — /forgot-password (token emitido, aún no consumido)
 *
 * Estrategia: en Postgres particionado (RANGE), las partitions heredan
 * automáticamente el CHECK del padre. NO se puede dropear el CHECK
 * directamente de una partition ("cannot drop inherited constraint"). El
 * fix canónico es solo tocar el padre — el DROP + ADD del padre propaga
 * a todas las partitions vivas.
 *
 * Multi-tabla:
 *   · `audit_logs` (particionada) — el DROP + ADD del padre se propaga.
 *   · `audit_queue` (tabla plana) — DROP + ADD directo.
 */

const NUEVAS = "'INSERT','UPDATE','DELETE','LOGIN','LOGIN_FAILED','LOCKOUT','LOGOUT','PASSWORD_RESET_REQUESTED'";
const VIEJAS = "'INSERT','UPDATE','DELETE'";

exports.up = (pgm) => {
  // audit_logs (particionada): DROP + ADD del padre propaga a partitions.
  //
  // NOTA: la constraint original de la tabla partition (creada por la
  // migration 20260611000004) puede tener nombre autogenerado con sufijo
  // numérico (`audit_logs_accion_check1`) porque el CREATE TABLE la creó
  // sin nombre explícito. Dropeamos ambos posibles nombres por safety.
  pgm.sql('ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_accion_check;');
  pgm.sql('ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_accion_check1;');
  pgm.sql(
    'ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_accion_check ' +
    'CHECK (accion IN (' + NUEVAS + '));'
  );

  // audit_queue (tabla plana).
  pgm.sql('ALTER TABLE audit_queue DROP CONSTRAINT IF EXISTS audit_queue_accion_check;');
  pgm.sql(
    'ALTER TABLE audit_queue ADD CONSTRAINT audit_queue_accion_check ' +
    'CHECK (accion IN (' + NUEVAS + '));'
  );
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_accion_check;');
  pgm.sql(
    'ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_accion_check ' +
    'CHECK (accion IN (' + VIEJAS + '));'
  );

  pgm.sql('ALTER TABLE audit_queue DROP CONSTRAINT IF EXISTS audit_queue_accion_check;');
  pgm.sql(
    'ALTER TABLE audit_queue ADD CONSTRAINT audit_queue_accion_check ' +
    'CHECK (accion IN (' + VIEJAS + '));'
  );
};

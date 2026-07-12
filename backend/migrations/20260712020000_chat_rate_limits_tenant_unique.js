/**
 * Migration: agregar tenant_id a la UNIQUE de chat_rate_limits.
 *
 * 2026-07-12 (auditoría TOTAL Plataforma P2-6, Pattern B multi-país UYU):
 *
 * Contexto: la migration original de chat_assistant.js (20260620000001)
 * creó `chat_rate_limits` con `UNIQUE (user_id, window_start)`. La tabla
 * también tiene `tenant_id NOT NULL` que se lee del contexto para hacer
 * scoping (RLS + WHERE explícito), pero NO forma parte de la UNIQUE.
 *
 * Estado hoy: un mismo `user_id` no puede pertenecer a 2 tenants
 * simultáneamente (users tiene DEFAULT_TENANT_ID single-tenant), así que
 * la UNIQUE actual funciona. PERO:
 *
 * Efecto latente (bug futuro cuando cross-tenant users lleguen):
 *  · Multi-tenant users es el next step (users que operan en múltiples
 *    tenants, ej. contadores, super-admins operando "as tenant X").
 *  · Sin tenant_id en la UNIQUE, dos rows con mismo user_id + window_start
 *    en tenants distintos colisionan → uno se rechaza silenciosamente y
 *    el rate limiter del segundo tenant no cuenta ese turno del user.
 *  · Consecuencia: usuario evade el rate limit al operar en 2 tenants.
 *
 * Fix defense-in-depth: incluir tenant_id en la UNIQUE ahora (barato,
 * cero regresión hoy) para que el modelo esté consistente cuando llegue
 * multi-tenant users.
 *
 * Cost: instant en DBs pequeñas (~1min por 100k rows). No hay data corrupta
 * a limpiar (la UNIQUE actual ya impedía duplicados con mismo user_id).
 *
 * Down: revierte al UNIQUE viejo. Compatibilidad total: si hay 2 rows con
 * mismo (user, window) en tenants distintos post-fix, el rollback rebota
 * con 23505 y el operador debe limpiar antes.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE chat_rate_limits
      DROP CONSTRAINT IF EXISTS chat_rate_limits_user_id_window_start_key;

    ALTER TABLE chat_rate_limits
      ADD CONSTRAINT chat_rate_limits_tenant_user_window_key
      UNIQUE (tenant_id, user_id, window_start);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE chat_rate_limits
      DROP CONSTRAINT IF EXISTS chat_rate_limits_tenant_user_window_key;

    ALTER TABLE chat_rate_limits
      ADD CONSTRAINT chat_rate_limits_user_id_window_start_key
      UNIQUE (user_id, window_start);
  `);
};

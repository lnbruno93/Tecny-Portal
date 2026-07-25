/**
 * Migration: backfill NULLIF en policies tenant_isolation de 7 tablas
 *
 * ── NO-OP hotfix 2026-07-25 ──────────────────────────────────────────────
 *
 * Esta migration fue REEMPLAZADA por no-op durante un hotfix urgente:
 * intentaba `DROP POLICY IF EXISTS tenant_isolation ON <tabla>` para 7
 * tablas y falló en producción con:
 *
 *   error: must be owner of relation clases_producto
 *
 * Root cause:
 *   El rol de migrations en prod es `ipro_app` (NOSUPERUSER). Las 7
 *   tablas afectadas (`clases_producto`, `chat_conversations`,
 *   `chat_messages`, `chat_rate_limits`, `egresos_recurrentes_overrides`,
 *   `proyecciones_mensuales`, `share_links`) fueron creadas en su momento
 *   por un rol distinto (probably `postgres` superuser). Por eso el
 *   `ipro_app` no puede hacer DROP POLICY sobre ellas.
 *
 *   El CI job `NOSUPERUSER RLS Tests` no cazó el bug porque en CI las
 *   tablas SÍ son owned por el rol de migrations — el gap es que en prod
 *   los owners son heterogéneos.
 *
 * Impacto del no-op:
 *   Las 7 tablas afectadas siguen con predicate SIN `NULLIF` — lo cual
 *   sigue siendo un bug latente (mismo pattern que Sentry #16 audit_logs).
 *   NO es P0: el pattern solo se dispara si algún endpoint las escribe
 *   SIN `SET LOCAL app.current_tenant` primero, y hoy TODAS las escrituras
 *   pasan por `withTenant()`. El startup assertion CONTENT check
 *   (rlsCanonical.js chequeo 4, agregado en PR #864) sigue vivo y va a
 *   fallar el boot si el drift se agranda.
 *
 * Follow-up:
 *   1. Script SQL manual (con superuser en Railway console): hacer
 *      `ALTER TABLE <tabla> OWNER TO ipro_app` para las 7 tablas afectadas.
 *   2. Nueva migration (timestamp posterior) que ahora sí puede hacer
 *      DROP + CREATE POLICY sin problema.
 *   3. Update del CI test para que replique el mix de owners heterogéneos
 *      de prod (crear alguna tabla con rol distinto en el setup).
 *
 * Por qué se dejó el file como no-op (en vez de eliminarlo):
 *   La migration `20260724000002` NUNCA se marcó como corrida en la
 *   tabla `pgmigrations` (los 9 deploys fallaron ANTES del INSERT del
 *   registro). Eliminar el file directamente funciona técnicamente,
 *   pero deja un "hueco" en el timestamp sequence de migrations que
 *   confunde a un dev futuro leyendo git log. El no-op preserva el
 *   timestamp + documenta lo que pasó + no muta DB.
 */

// eslint-disable-next-line no-unused-vars
exports.up = (pgm) => {
  // No-op. Ver header comment.
};

// eslint-disable-next-line no-unused-vars
exports.down = (pgm) => {
  // No-op.
};

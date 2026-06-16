/**
 * Migration: users.email NOT NULL + UNIQUE case-insensitive (TANDA 1 hardening)
 *
 * Contexto:
 *   Antes de exponer `/signup` público (TANDA 2), necesitamos:
 *     1) email obligatorio: el flow de signup pide email para verificación,
 *        recovery, comunicación. NULL ya no tiene sentido en ese contexto.
 *     2) UNIQUE case-insensitive: hoy `Lucas@x.com` y `lucas@x.com` pueden
 *        coexistir (el partial index es case-sensitive). Para signup público,
 *        eso es un bug: misma persona se registra dos veces y termina con
 *        2 cuentas separadas. Solución: index sobre `LOWER(email)`.
 *
 * Pre-check (fail-fast):
 *   Si hay 2+ users activos con el mismo email en minúsculas, el CREATE UNIQUE
 *   fallaría con un error confuso. Detectamos primero y abortamos con mensaje
 *   claro pidiendo cleanup manual.
 *
 * Backfill:
 *   Users con email NULL (todos, incluso soft-deleted, porque NOT NULL afecta
 *   la columna entera) se backfillean con `user_<id>@placeholder.local`.
 *   Soft-deleted no impactan al index (partial WHERE deleted_at IS NULL), así
 *   que el placeholder ahí es solo para satisfacer el constraint.
 *   Emails existentes se LOWER-case para evitar duplicados latentes al crear
 *   el index nuevo. (No es destructivo: la dirección sigue siendo válida.)
 *
 * Idempotencia:
 *   - Backfill solo toca NULLs / mixed-case.
 *   - El DROP/CREATE INDEX usa IF EXISTS / IF NOT EXISTS.
 *
 * Down:
 *   Revierte el index (case-insensitive → case-sensitive) y quita el NOT NULL.
 *   NO restaura NULLs (no sabemos cuáles eran originales).
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- Pre-check: abortar si hay duplicados case-insensitive entre users activos.
    DO $$
    DECLARE
      dup_count int;
    BEGIN
      SELECT COUNT(*) INTO dup_count FROM (
        SELECT LOWER(email) AS lower_email
          FROM users
         WHERE deleted_at IS NULL AND email IS NOT NULL
         GROUP BY LOWER(email)
        HAVING COUNT(*) > 1
      ) d;
      IF dup_count > 0 THEN
        RAISE EXCEPTION 'Migration abortada: % grupos de users activos con email duplicado case-insensitive. Ejecutá manualmente: SELECT LOWER(email), array_agg(id) FROM users WHERE deleted_at IS NULL AND email IS NOT NULL GROUP BY LOWER(email) HAVING COUNT(*) > 1; y resolvé los conflictos antes de reintentar.', dup_count;
      END IF;
    END
    $$;

    -- Backfill 1: lowercase de emails existentes (idempotente — si ya están en
    -- minúsculas, no cambia nada).
    UPDATE users
       SET email = LOWER(email)
     WHERE email IS NOT NULL AND email <> LOWER(email);

    -- Backfill 2: emails NULL → placeholder único por id. Cubre tanto activos
    -- como soft-deleted (porque NOT NULL afecta la columna entera).
    UPDATE users
       SET email = 'user_' || id || '@placeholder.local'
     WHERE email IS NULL;

    -- Constraint NOT NULL.
    ALTER TABLE users ALTER COLUMN email SET NOT NULL;

    -- Reemplazar el index parcial case-sensitive por uno case-insensitive.
    DROP INDEX IF EXISTS uq_users_email_activo;
    CREATE UNIQUE INDEX uq_users_email_activo
      ON users (LOWER(email))
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Volver al index case-sensitive sobre email crudo.
    DROP INDEX IF EXISTS uq_users_email_activo;
    CREATE UNIQUE INDEX uq_users_email_activo
      ON users (email)
      WHERE deleted_at IS NULL AND email IS NOT NULL;

    -- Quitar NOT NULL (los placeholders generados quedan en la DB — el down
    -- no los puede distinguir de emails originales).
    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
  `);
};

/* eslint-disable camelcase */
/**
 * Migration: super_admin_invites — invitación a co-super-admins (#499).
 *
 * Hoy `is_super_admin=true` se otorga exclusivamente vía
 * `backend/scripts/setSuperAdmin.js` con acceso SSH a Railway. Escala mal
 * cuando queremos sumar co-fundadores, contadores o soporte al back-office.
 *
 * Este PR agrega UI en admin.tecnyapp.com para que un super-admin ya activo
 * invite a otra persona: se le manda un email con link de setup (48h TTL),
 * el invitado elige password y queda como super-admin. El guard S-25
 * (`requireSuperAdmin` exige 2FA activa) lo obliga a activar 2FA antes de
 * operar — flujo idéntico al owner original.
 *
 * Schema:
 *   - id                  PK
 *   - email + nombre      Del invitado (email lowercase-normalized)
 *   - token_hash          BYTEA con SHA-256 del token plaintext. Nunca guardamos
 *                         el plaintext; el email lo lleva y el backend lo hashea
 *                         para lookup. Pattern idéntico a password_reset_tokens
 *                         del auth/forgot-password.
 *   - invited_by          FK a users(id) del super-admin que emitió (ON DELETE
 *                         RESTRICT: no borramos el user emisor si tiene invites,
 *                         perdería trazabilidad).
 *   - invited_at + expires_at + accepted_at + revoked_at
 *   - accepted_user_id    FK al user creado al aceptar (ON DELETE SET NULL:
 *                         si borran el user, la invite queda como registro
 *                         histórico sin puntero muerto).
 *
 * Índices:
 *   - UNIQUE token_hash (por la column definition)
 *   - LOWER(email) para lookup en POST /invite (rechazar duplicados pending)
 *   - Parcial sobre expires_at WHERE pending — el listado GET / filtra
 *     "pending y no expirado" en cada request; con este índice el filtro
 *     es índice-solo aún con historial de invites acumulado.
 *
 * Sin RLS: la tabla es global (no per-tenant). El acceso lo gatea
 * `requireSuperAdmin` en los routes de superAdminTeam.js — mismo pattern
 * que `plan_prices`, `tc_defaults_pais` y `tenant_admin_actions`.
 *
 * Reversible. Down dropea tabla + índices.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE super_admin_invites (
      id                SERIAL PRIMARY KEY,
      email             TEXT NOT NULL,
      nombre            TEXT NOT NULL,
      token_hash        BYTEA NOT NULL UNIQUE,
      invited_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      invited_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ NOT NULL,
      accepted_at       TIMESTAMPTZ,
      accepted_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      revoked_at        TIMESTAMPTZ
    );

    COMMENT ON TABLE super_admin_invites IS
      '#499 (2026-07-01): invitaciones a co-super-admins. token_hash es SHA-256(token). Sin RLS: la gate es requireSuperAdmin en el route.';

    -- Lookup case-insensitive por email para POST /invite (rechazar
    -- duplicados pendientes). Mismo pattern que users.email.
    CREATE INDEX idx_super_admin_invites_email
      ON super_admin_invites (LOWER(email));

    -- Índice parcial sobre invites vigentes (pending & no expirado en runtime).
    -- expires_at incluido para el filtro "y no expirado" del listado.
    CREATE INDEX idx_super_admin_invites_pending
      ON super_admin_invites (expires_at)
      WHERE accepted_at IS NULL AND revoked_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_super_admin_invites_pending;
    DROP INDEX IF EXISTS idx_super_admin_invites_email;
    DROP TABLE IF EXISTS super_admin_invites;
  `);
};

/* eslint-disable camelcase */
/**
 * Migración — 2FA TOTP por usuario.
 *
 * Tabla `user_2fa`:
 *   - user_id            PK + FK users.id, 1:1 (un user, un secret)
 *   - secret_encrypted   bytea — TOTP secret cifrado con AES-256-GCM
 *                        usando TWOFA_ENCRYPTION_KEY (env). NUNCA en plain.
 *   - recovery_codes     text[] de bcrypt hashes — 8 codes one-time-use
 *                        para cuando pierde el cel. Se borran al usarse
 *                        (la lib reemplaza por null en su posición).
 *   - enabled_at         timestamptz — cuando completó el setup (verificó
 *                        el primer código). Antes de eso el secret existe
 *                        pero el login NO lo exige todavía.
 *   - last_used_at       timestamptz — para auditar / detectar abandono.
 *   - created_at         timestamptz default NOW().
 *
 * Política: opcional para todos los usuarios al inicio. Si `enabled_at IS
 * NULL`, el login normal funciona sin pedir código. Si está enabled, el
 * login requiere el código TOTP (o un recovery code) después del password.
 *
 * Sin soft-delete: si un user borra su 2FA, se elimina el row físicamente
 * (la integridad la mantiene el ON DELETE CASCADE de users.id).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS user_2fa (
      user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret_encrypted BYTEA NOT NULL,
      recovery_codes   TEXT[] NOT NULL DEFAULT '{}',
      enabled_at       TIMESTAMPTZ,
      last_used_at     TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Index sobre enabled_at para filtros "usuarios con 2FA activo" (dashboard
    -- admin). Partial index — solo entra al index si tiene fecha (not null).
    CREATE INDEX IF NOT EXISTS idx_user_2fa_enabled
      ON user_2fa (enabled_at)
      WHERE enabled_at IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_user_2fa_enabled;
    DROP TABLE IF EXISTS user_2fa;
  `);
};

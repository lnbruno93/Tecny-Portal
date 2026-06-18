/**
 * Migration: password reset infrastructure (TANDA 0 #321 forgot-password).
 *
 * Antes: el flow de "olvidé mi password" decía al user "pedile a un admin que
 * resetee". Para signup público (post-#312) el user ES admin de su tenant, así
 * que sin auto-servicio quedaba lockeado out permanentemente. BLOCKER de UX.
 *
 * Esta migration agrega la tabla `password_reset_tokens`, mirror exacto del
 * pattern de `email_verification_tokens` (migration 20260616000004):
 *   - id SERIAL PK
 *   - user_id FK → users(id) CASCADE delete
 *   - token TEXT UNIQUE NOT NULL — generado con crypto.randomBytes(32).toString('hex')
 *   - expires_at TIMESTAMPTZ NOT NULL — 1 hora post-creación por default (TTL más
 *     corto que verify email porque reset es path crítico; queremos minimizar
 *     ventana de exposición si el email leakea)
 *   - used_at TIMESTAMPTZ — set al consumirse; rechaza reuso (single-shot)
 *   - created_at TIMESTAMPTZ — auditoría
 *
 * Indexes:
 *   - Unique en `token` (auto via UNIQUE constraint) → lookup O(log n) en reset
 *   - Partial en `user_id WHERE used_at IS NULL` → para "tiene un token activo
 *     este user?" (defensa contra spam — si ya tiene uno reciente, reutilizamos)
 *
 * Sin tenant_id ni RLS: tabla auth-flow, no application data. Los tokens son
 * por user, no por tenant. El lookup ocurre antes del JWT y del SET LOCAL,
 * mismo patrón que email_verification_tokens.
 *
 * Idempotencia: IF NOT EXISTS en todas las definiciones.
 *
 * Down: drop la tabla. Tokens activos se pierden — users que estaban a mitad
 * del reset flow tendrán que pedir uno nuevo. Aceptable para revert.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token       TEXT        NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (expires_at > created_at)
    );

    -- Para detectar tokens activos del mismo user (rate-limit aplicativo:
    -- si ya pidió uno en los últimos N minutos, no generamos otro).
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
      ON password_reset_tokens (user_id) WHERE used_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_password_reset_tokens_user;
    DROP TABLE IF EXISTS password_reset_tokens;
  `);
};

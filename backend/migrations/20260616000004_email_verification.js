/**
 * Migration: email verification infrastructure (TANDA 2.1).
 *
 * Agrega:
 *   1) `users.email_verified_at TIMESTAMPTZ` — NULL hasta que el user verifica
 *      su email. El middleware `requireVerifiedEmail` (PR 2.1) bloquea escrituras
 *      con 403 si la columna está NULL. Lectura sigue permitida (bloqueo blando).
 *
 *   2) `email_verification_tokens` — tokens random one-shot:
 *      - id SERIAL PK
 *      - user_id FK → users(id) CASCADE delete
 *      - token TEXT UNIQUE NOT NULL — generado con crypto.randomBytes(32).toString('hex')
 *      - expires_at TIMESTAMPTZ NOT NULL — 24h post-creación por default
 *      - used_at TIMESTAMPTZ — set al consumirse; rechaza reuso (single-shot)
 *      - created_at TIMESTAMPTZ — auditoría
 *
 *      Index único en `token` para lookup O(log n). Sin tenant_id ni RLS:
 *      es una tabla auth-flow (no application data) y los tokens son por user,
 *      no por tenant. Lookup ocurre antes del JWT.
 *
 * Idempotencia: IF NOT EXISTS en todas las definiciones — re-correr la
 * migration en una DB ya parchada es no-op.
 *
 * Down: drop la tabla y la columna. Datos de verificación se pierden — los
 * users tendrán que re-verificar después de re-aplicar el up.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- 1) Flag de verificación en users.
    -- DEFAULT NOW(): cualquier INSERT que NO especifique email_verified_at
    -- arranca como verificado. Es el comportamiento correcto para:
    --   - Users existentes (backfill via UPDATE abajo).
    --   - Users creados por admin via POST /api/usuarios — el admin "vouches"
    --     por ellos, no necesitan verificación de email (son empleados conocidos).
    --   - Tests que insertan users vía pool.query directo (no se rompen).
    -- Solo el route /api/auth/signup (TANDA 2.1) inserta explícitamente con
    -- email_verified_at = NULL → necesita verificación.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ DEFAULT NOW();

    -- Backfill explícito para usuarios EXISTENTES con NULL (defensivo — el
    -- DEFAULT solo aplica a INSERTs nuevos, no a rows pre-ALTER).
    UPDATE users SET email_verified_at = NOW() WHERE email_verified_at IS NULL;

    -- 2) Tabla de tokens de verificación.
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token       TEXT        NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (expires_at > created_at)
    );

    -- Lookup primary: por token (verificación) y por user_id (resend / cleanup).
    CREATE INDEX IF NOT EXISTS idx_email_verif_tokens_user
      ON email_verification_tokens (user_id) WHERE used_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS email_verification_tokens;
    ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at;
  `);
};

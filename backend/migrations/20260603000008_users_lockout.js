/* eslint-disable camelcase */
/**
 * Migración — Lockout por usuario (Brute force resistance)
 *
 * Hallazgo de la auditoría ultra (mayo-2026, Seguridad P1-1):
 *   El loginLimiter actual solo limita por IP (10 fallos / 15 min). Un atacante
 *   con pool de IPs (proxies/IPv6/botnet) puede probar contraseñas ilimitadas
 *   contra un usuario específico. Sumado a la política de password mínima
 *   (8 chars, letra + número), brute force horizontal era factible.
 *
 * Fix: contador y ventana de lockout por usuario, complementario al rate
 * limit por IP existente.
 *
 *   failed_login_count → fallos consecutivos. Se resetea al login exitoso.
 *   lockout_until       → si > NOW(), el login se rechaza con 423 Locked.
 *
 * Política aplicada en routes/auth.js: 10 fallos → 15 min de bloqueo. Tras
 * el bloqueo el contador NO se resetea automáticamente; el siguiente fallo
 * post-bloqueo activa otro bloqueo (defensa contra atacante persistente).
 * El usuario legítimo recupera acceso al hacer login exitoso (resetea).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS failed_login_count INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lockout_until      TIMESTAMPTZ;

    COMMENT ON COLUMN users.failed_login_count IS
      'Fallos consecutivos de login. Se resetea al éxito.';
    COMMENT ON COLUMN users.lockout_until IS
      'Si > NOW(), el login está bloqueado hasta esta fecha.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS failed_login_count,
      DROP COLUMN IF EXISTS lockout_until;
  `);
};

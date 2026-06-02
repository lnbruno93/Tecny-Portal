/* eslint-disable camelcase */
/**
 * Migración — protección contra replay de TOTP en `user_2fa`.
 *
 * Problema (B2 de auditoría 2026-06):
 *   `verifyToken` (lib/twoFa.js) valida un código TOTP con window ±1 step
 *   (válido durante 90s). Si un atacante intercepta UN código (red wifi,
 *   phishing, log indiscreto, screen share), puede reusarlo varias veces
 *   dentro de ese window. Con 2 réplicas activas el problema empeora:
 *   las réplicas no se coordinan, ambas aceptan el mismo código.
 *
 * Solución:
 *   - Persistimos el último step TOTP consumido por user (`last_used_step`).
 *   - Cada step son 30s desde Unix epoch (Math.floor(now/30)).
 *   - La verificación es atómica: UPDATE ... WHERE last_used_step < $new
 *     RETURNING 1 — si rowCount = 0, otro request ya consumió ese (o uno
 *     posterior) y rechazamos.
 *
 * Sin esto, TOTP pasa a ser "factor con TTL 90s y reusos ilimitados",
 * que frente a un atacante con intercepción es ~equivalente a no tener 2FA.
 *
 * Backfill: 0 — todos los registros existentes quedan en step 0, lo que
 * permite el próximo TOTP válido. Cero impacto para usuarios existentes.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE user_2fa
      ADD COLUMN IF NOT EXISTS last_used_step BIGINT NOT NULL DEFAULT 0;

    -- Comentario en la columna para documentación auto-explicativa.
    COMMENT ON COLUMN user_2fa.last_used_step IS
      'Último step TOTP consumido (floor(unix_time/30)). UPDATE atómico con WHERE last_used_step < $new previene replay del mismo código.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE user_2fa DROP COLUMN IF EXISTS last_used_step;`);
};

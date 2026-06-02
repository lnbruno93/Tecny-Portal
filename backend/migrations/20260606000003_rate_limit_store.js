/* eslint-disable camelcase */
/**
 * Migración — `rate_limit_entries` para rate-limit compartido entre réplicas.
 *
 * Problema (P1 auditoría 2026-06):
 *   `express-rate-limit` por default usa MemoryStore — un contador in-memory
 *   por proceso. Con 2 réplicas activas (Railway), el loginLimiter de 10/15min
 *   efectivo se vuelve 20/15min (el LB reparte requests entre réplicas, ninguna
 *   ve los 10 acumulados). La defensa contra credential stuffing y brute force
 *   queda relajada al doble. El lockout per-user (H1) es defensa complementaria,
 *   pero el rate-limit por IP es la PRIMERA línea (antes del lockout).
 *
 * Solución:
 *   Store custom que persiste el contador en Postgres. Ambas réplicas leen/
 *   escriben la misma tabla → comportamiento consistente.
 *
 * Schema:
 *   - key         TEXT PRIMARY KEY — identificador del cliente (IP, user.id, etc.).
 *                 La key viene del `keyGenerator` del limiter.
 *   - hits        INTEGER NOT NULL — número de hits en el window actual.
 *   - expires_at  TIMESTAMPTZ NOT NULL — momento en que el window se resetea.
 *
 * Operaciones:
 *   - increment: UPSERT atómico que incrementa si el window está vigente, o
 *                resetea a 1 si expiró. Devuelve { totalHits, resetTime }.
 *   - decrement: --hits (cuando skipSuccessfulRequests deshace un hit OK).
 *   - resetKey:  DELETE de la fila.
 *
 * Cleanup:
 *   Las filas expiradas se purgan con un cron periódico (cada hora) usando
 *   withAdvisoryLock — una sola réplica ejecuta el DELETE.
 *
 * Index sobre `expires_at` para que el cleanup sea barato (range scan).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS rate_limit_entries (
      key         TEXT        PRIMARY KEY,
      hits        INTEGER     NOT NULL DEFAULT 0 CHECK (hits >= 0),
      expires_at  TIMESTAMPTZ NOT NULL
    );

    -- Index para que el cleanup periódico (DELETE WHERE expires_at < NOW())
    -- sea barato en lugar de full scan. Partial index sería marginal acá
    -- porque casi todas las filas eventualmente expiran.
    CREATE INDEX IF NOT EXISTS idx_rate_limit_entries_expires_at
      ON rate_limit_entries (expires_at);

    COMMENT ON TABLE rate_limit_entries IS
      'Counter store compartido para express-rate-limit. Cada fila = un cliente (IP o user.id) en una ventana de tiempo. Purgado periódicamente por cleanup job.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS rate_limit_entries;`);
};

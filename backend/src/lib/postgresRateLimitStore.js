// PostgresRateLimitStore — implementa el contract `Store` de express-rate-limit
// usando Postgres como backend compartido entre réplicas.
//
// Problema que resuelve (P1 auditoría 2026-06):
//   El MemoryStore default de express-rate-limit es process-local. Con 2
//   réplicas Railway, los counters viven separados → el límite efectivo es
//   2x el configurado, debilitando defense contra brute force.
//
// Trade-offs vs Redis:
//   + Cero infra extra (usa la DB que ya tenés)
//   + Consistencia exacta (transaccional)
//   + Survives Postgres restarts (Redis volatile por default)
//   - Mayor latencia por hit (~5-15ms vs <1ms Redis)
//   - Carga adicional a Postgres en endpoints con tráfico
//   - Cada hit es 1 query (no batched)
//
// Para Tecny a escala actual (~50 users): impacto irrelevante. El loginLimiter
// solo se aplica a /api/auth/login y el twoFaLimiter a /api/auth/2fa/* — ambos
// endpoints de tráfico bajo.
//
// Perf M3 auditoría 2026-06-06: también lo usa el globalLimiter (prefix 'global').
// Ese SÍ se aplica a TODOS los endpoints — pero a escala Tecny (~50 users → ~4
// req/sec) el costo es <1% del load PG (1 query UPSERT trivial por request).
// Si el tráfico crece 10×+ revisar; con 50 req/sec + el resto del workload
// considerar Redis para el global, manteniendo Postgres para login/2FA.
//
// Cumple el contract de express-rate-limit v7+ Store:
//   - localKeys: false → contadores compartidos (señal al middleware).
//   - init(options): recibe windowMs.
//   - increment(key): UPSERT atómico → { totalHits, resetTime }.
//   - decrement(key): -hits (para skipSuccessfulRequests/Failed).
//   - resetKey(key):  DELETE.

class PostgresRateLimitStore {
  /**
   * @param {object} opts
   * @param {object} opts.db        Pool de pg (o cliente con .query()).
   * @param {string} [opts.prefix]  Prefix opcional para las keys (útil si
   *                                varios limiters comparten DB, evita colisión).
   * @param {object} [opts.logger]  Logger pino-compatible (opcional).
   */
  constructor({ db, prefix = '', logger } = {}) {
    if (!db || typeof db.query !== 'function') {
      throw new Error('PostgresRateLimitStore: db con .query() es requerido');
    }
    this.db = db;
    this.prefix = prefix;
    this.logger = logger;
    this.windowMs = null; // se setea en init()
    // Señala al middleware que los keys son compartidos entre instancias.
    this.localKeys = false;
  }

  // Llamado por express-rate-limit una vez al setup. Capturamos windowMs para
  // calcular expires_at en increment().
  init(options) {
    this.windowMs = Math.max(1, Number(options?.windowMs) || 60 * 1000);
  }

  _prefixedKey(key) {
    return this.prefix ? `${this.prefix}:${key}` : String(key);
  }

  /**
   * UPSERT atómico:
   *   - Si la fila no existe O su window ya expiró: INSERT con hits=1.
   *   - Si la fila existe y vigente: hits += 1.
   * Devuelve el contador post-increment y el momento del reset.
   *
   * Atomicidad: el UPSERT corre en UNA SOLA query, sin race entre SELECT y
   * UPDATE. Si dos réplicas hacen increment del mismo key al mismo tiempo,
   * Postgres serializa el conflicto del PRIMARY KEY y ambos suman correctamente.
   */
  async increment(key) {
    const k = this._prefixedKey(key);
    const windowMs = this.windowMs || 60 * 1000;
    const { rows } = await this.db.query(
      `INSERT INTO rate_limit_entries (key, hits, expires_at)
       VALUES ($1, 1, NOW() + ($2::bigint * INTERVAL '1 millisecond'))
       ON CONFLICT (key) DO UPDATE
         SET hits       = CASE WHEN rate_limit_entries.expires_at < NOW() THEN 1
                               ELSE rate_limit_entries.hits + 1 END,
             expires_at = CASE WHEN rate_limit_entries.expires_at < NOW()
                                THEN NOW() + ($2::bigint * INTERVAL '1 millisecond')
                               ELSE rate_limit_entries.expires_at END
       RETURNING hits AS "totalHits", expires_at AS "resetTime"`,
      [k, windowMs]
    );
    return {
      totalHits: Number(rows[0].totalHits),
      resetTime: new Date(rows[0].resetTime),
    };
  }

  /**
   * Decrementa hits — usado cuando skipSuccessfulRequests:true para "deshacer"
   * el incremento de un request que resultó exitoso. No tocamos expires_at.
   * Si hits llega a 0 dejamos la fila — la próxima rotación o el cleanup la limpia.
   */
  async decrement(key) {
    const k = this._prefixedKey(key);
    await this.db.query(
      `UPDATE rate_limit_entries
          SET hits = GREATEST(hits - 1, 0)
        WHERE key = $1`,
      [k]
    );
  }

  /** Resetea el counter de un key específico (DELETE). */
  async resetKey(key) {
    const k = this._prefixedKey(key);
    await this.db.query('DELETE FROM rate_limit_entries WHERE key = $1', [k]);
  }

  /** Wipe completo (raramente útil — solo para tests). */
  async resetAll() {
    await this.db.query('DELETE FROM rate_limit_entries');
  }

  /**
   * Cleanup: borrar entries con window expirado. Pensado para correr
   * periódicamente desde un cron (cada 1h). Idempotente.
   *
   * Devuelve el número de filas borradas (útil para logging).
   */
  async cleanup() {
    const { rowCount } = await this.db.query(
      'DELETE FROM rate_limit_entries WHERE expires_at < NOW()'
    );
    if (this.logger && rowCount > 0) {
      this.logger.info({ rowCount, store: 'PostgresRateLimitStore' }, 'rate_limit cleanup ejecutado');
    }
    return rowCount;
  }
}

module.exports = PostgresRateLimitStore;

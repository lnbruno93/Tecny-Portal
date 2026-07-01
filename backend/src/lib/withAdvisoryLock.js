// withAdvisoryLock — helper para garantizar single-runner en multi-instancia.
//
// Problema que resuelve:
//   Cuando hay múltiples réplicas del backend corriendo (ej. Railway 2 réplicas),
//   cualquier `setInterval` interno corre 1 vez por instancia. Si ese interval
//   dispara un job global (DELETE masivo, evaluación de invariantes, agregación
//   nocturna, etc.), TODAS las instancias lo corren en paralelo:
//     · DELETE racing → lock contention severo en tablas grandes
//     · Alertas Sentry duplicadas → ruido operacional, dificulta diagnóstico
//     · Trabajo desperdiciado (computación redundante)
//
// Solución: Postgres advisory locks no bloqueantes (`pg_try_advisory_lock`).
//   - El lock es a nivel sesión del cliente PG (no transaccional).
//   - Si una instancia lo obtiene, las otras reciben `false` y saltan silently.
//   - Cuando termina el job, libera el lock con `pg_advisory_unlock`.
//
// Garantías:
//   · A lo sumo 1 instancia corre el job en un momento dado (cross-process).
//   · Si la instancia que tiene el lock muere mid-job, PG libera el lock al
//     cerrar la sesión (no quedan locks colgados zombies).
//   · `lockKey` es un BIGINT derivado de un identificador legible (hashtext).
//
// Uso:
//   await withAdvisoryLock('audit_purga', async () => { await purga(); });
//
// Si el lock no se obtiene, la función no se ejecuta y la promesa resuelve
// con `{ acquired: false }`. Si se ejecutó, resuelve con `{ acquired: true, result }`.

const db = require('../config/database');
const logger = require('./logger');

/**
 * Envuelve la ejecución de `fn` con un advisory lock global de Postgres.
 * Solo una instancia del proceso (entre todas las réplicas) puede correr
 * `fn` a la vez para una `lockName` dada.
 *
 * @param {string} lockName  Identificador legible del lock (ej. 'audit_purga').
 *                           Se hashea con `hashtext` para obtener el BIGINT.
 * @param {() => Promise<any>} fn  Función async a ejecutar bajo el lock.
 * @param {object} [options]
 * @param {boolean} [options.logSkip=true]  Logear debug cuando otra instancia tiene el lock.
 * @returns {Promise<{ acquired: boolean, result?: any, error?: Error }>}
 */
async function withAdvisoryLock(lockName, fn, { logSkip = true } = {}) {
  if (!lockName || typeof lockName !== 'string') {
    throw new Error('withAdvisoryLock: lockName debe ser string no vacío');
  }
  if (typeof fn !== 'function') {
    throw new Error('withAdvisoryLock: fn debe ser una función');
  }

  // Tomamos UNA conexión del pool y la mantenemos durante toda la ejecución.
  // Si soltáramos la conexión al pool entre el lock y el unlock, otro código
  // podría liberar el lock prematuramente (locks de sesión están atados a la
  // conexión, no al request).
  const client = await db.connect();
  let acquired = false;

  try {
    const lockResult = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [lockName]
    );
    acquired = lockResult.rows[0]?.acquired === true;

    if (!acquired) {
      if (logSkip) {
        // Auditoría 2026-06-30 seguimiento: era logger.info y en jobs de
        // alta frecuencia (audit_queue_worker cada 2s) saturaba Railway
        // (rate limit 500 logs/sec → mensajes descartados). Bajado a debug:
        // el valor operacional está en el log del RESULTADO del job (ej.
        // "audit_queue: batch procesado", "audit_logs drop_old_partitions
        // OK"), no en el hecho de que se adquirió/soltó el lock. Con
        // LOG_LEVEL=debug se sigue viendo para diagnóstico manual.
        logger.debug({ lockName }, 'advisory_lock: skip — otra instancia tiene el lock');
      }
      return { acquired: false };
    }

    // Tenemos el lock. Ejecutamos el job.
    // Auditoría 2026-06-30 seguimiento: ver comment en la rama del skip
    // más arriba — mismo motivo. El log del resultado del job (info) es
    // la señal operacional útil; "acquired" es puro diagnóstico.
    logger.debug({ lockName }, 'advisory_lock: acquired — ejecutando job');
    try {
      const result = await fn();
      return { acquired: true, result };
    } catch (err) {
      logger.error({ err, lockName }, 'advisory_lock: job falló dentro del lock');
      // Propagamos el error para que el caller lo maneje, pero asegurando
      // que el lock se libere en el finally.
      return { acquired: true, error: err };
    }
  } finally {
    // SIEMPRE intentamos liberar el lock antes de devolver la conexión al pool.
    // Si la conexión se rompe, PG libera el lock automáticamente al cerrar la
    // sesión — pero esto es defensa-en-profundidad.
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
        logger.debug({ lockName }, 'advisory_lock: released');
      } catch (err) {
        // Si falla el unlock, PG igualmente liberará al cerrar la sesión.
        logger.warn({ err, lockName }, 'advisory_lock: error al liberar (PG lo libera al cerrar sesión)');
      }
    }
    client.release();
  }
}

module.exports = withAdvisoryLock;

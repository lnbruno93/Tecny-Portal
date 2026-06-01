// withAdvisoryLock — ejecuta `fn` solo si esta instancia logra adquirir un
// pg_advisory_lock con el nombre dado. Si otra instancia ya lo tiene, hace
// no-op (devuelve null) y loguea el skip.
//
// Para qué sirve: los crons internos (audit purga, invariants check) corren
// vía setInterval en cada proceso. Con 1 replica eso es fine. Con >1 replica
// los crons corren N veces simultáneamente — duplican alertas Sentry, hacen
// el doble de DB load, y en casos extremos pueden generar race conditions
// (ej. dos invariant checks reportando el mismo drift como issue separado).
//
// El lock es session-level: vive mientras el client de pg esté connected.
// `client.release()` lo libera automáticamente, pero llamamos a
// pg_advisory_unlock explícito antes para garantizar la liberación incluso
// si la connection se reusa del pool por otro caller después.
//
// Uso:
//   await withAdvisoryLock('ipro-job-invariants', async () => {
//     await runInvariantsCheck();
//   });
//
// `lockName` se hashea con hashtext() (built-in Postgres) para encajar en el
// bigint que requiere pg_advisory_lock.

const db = require('../config/database');
const logger = require('./logger');

async function withAdvisoryLock(lockName, fn) {
  const client = await db.connect();
  let acquired = false;
  try {
    // pg_try_advisory_lock: intenta tomar el lock. Devuelve true si lo obtuvo,
    // false si está tomado por otra session. NO bloquea.
    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [lockName]
    );
    acquired = rows[0].locked === true;
    if (!acquired) {
      logger.info({ lockName }, 'advisory lock skipped — otra instancia lo tiene');
      return null;
    }
    return await fn();
  } finally {
    if (acquired) {
      // Liberar el lock explícitamente antes de devolver el client al pool.
      // Si esta query falla (ej. connection corrupta), no propagamos — el lock
      // se liberará automáticamente cuando el client se cierre.
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
      } catch (err) {
        logger.warn({ err, lockName }, 'advisory_unlock falló — connection drop liberará');
      }
    }
    client.release();
  }
}

module.exports = { withAdvisoryLock };

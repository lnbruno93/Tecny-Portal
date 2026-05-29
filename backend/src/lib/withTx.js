/**
 * Helper para envolver lógica en una transacción Postgres con manejo seguro
 * de connect/release/ROLLBACK. Reemplaza el patrón repetido en ~32 endpoints:
 *
 *   const client = await db.connect();
 *   try {
 *     await client.query('BEGIN');
 *     ...lógica...
 *     await client.query('COMMIT');
 *   } catch (e) {
 *     await client.query('ROLLBACK');
 *     next(e);  // <-- handlers olvidan release acá
 *   } finally {
 *     client.release();
 *   }
 *
 * Auditoría #R-02. Beneficios:
 *   - El `finally` siempre libera la conexión, incluso si el catch tira.
 *   - El ROLLBACK también va en .catch(() => {}) para que un fallo de
 *     ROLLBACK no oculte el error original.
 *   - El error sale "naturalmente" — el caller hace `next(e)` o tira a
 *     express-async-handler.
 *
 * Uso:
 *
 *   router.post('/algo', async (req, res, next) => {
 *     try {
 *       const result = await withTx(db, async (client) => {
 *         await client.query('INSERT ...');
 *         await client.query('UPDATE ...');
 *         return { ok: true };
 *       });
 *       res.status(201).json(result);
 *     } catch (err) { next(err); }
 *   });
 *
 * Para los retornos tempranos por validación (ej. 404, 409), se puede
 * lanzar un Error con .status y el caller traduce a res.status(N).json(...).
 */
async function withTx(db, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // El catch swallow garantiza que un fallo de ROLLBACK no oculte
    // el error original (que es lo que importa para el caller).
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = withTx;

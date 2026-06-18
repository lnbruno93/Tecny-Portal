/**
 * Tests para la instrumentación de int-cast errors en `config/database.js`.
 *
 * Contexto:
 *   En 2026-06-17 vimos un 500 con `err.routine: 'pg_strtoint32_safe'` en
 *   staging. La investigación no encontró el call site exacto. Para que la
 *   próxima recurrencia sea procesable, instrumentamos `pool.query` para
 *   loguear SQL + params cuando aparece este routine error.
 *
 * Estos tests verifican que la instrumentación:
 *   - Detecta y loguea cuando ocurre pg_strtoint{16,32,64}_safe.
 *   - Respeta el shape estructurado esperado (campos: err, sql, params_preview, stack_short).
 *   - Trunca el SQL y los params para no inundar el log si son enormes.
 *   - NO loguea para errores que NO son de int cast (selectividad — evita ruido).
 *   - Re-tira el error tal cual (zero behavior change para los callers).
 */

const db = require('../src/config/database');
const logger = require('../src/lib/logger');

describe('database.js — instrumentación int-cast errors', () => {
  let errorSpy;

  beforeEach(() => {
    // Capturamos logger.error sin imprimirlo en consola del test.
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('loguea estructurado cuando pg dispara pg_strtoint32_safe', async () => {
    // `''::int4` dispara pg_strtoint32_safe — exactamente el bug del staging.
    await expect(
      db.query('SELECT $1::int4 AS id', [''])
    ).rejects.toMatchObject({
      routine: 'pg_strtoint32_safe',
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logArgs, msg] = errorSpy.mock.calls[0];
    expect(msg).toMatch(/int_cast_error/);
    expect(logArgs).toMatchObject({
      err: expect.objectContaining({
        routine: 'pg_strtoint32_safe',
        message: expect.stringContaining('invalid input syntax for type integer'),
      }),
      sql: expect.stringContaining('$1::int4'),
      params_preview: expect.stringContaining('""'),
      stack_short: expect.any(String),
    });
  });

  it('loguea estructurado para pg_strtoint64_safe (bigint)', async () => {
    await expect(
      db.query('SELECT $1::int8 AS id', [''])
    ).rejects.toMatchObject({ routine: 'pg_strtoint64_safe' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0].err.routine).toBe('pg_strtoint64_safe');
  });

  it('NO loguea para errores que no son de int cast (selectividad)', async () => {
    // Tabla inexistente → error con routine ≠ pg_strtoint. No queremos
    // contaminar el log con errors no relacionados al bug que cazamos.
    await expect(
      db.query('SELECT * FROM tabla_que_no_existe_12345')
    ).rejects.toThrow();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('acepta el shape de query objeto { text, values }', async () => {
    await expect(
      db.query({ text: 'SELECT $1::int4 AS id', values: [''] })
    ).rejects.toMatchObject({ routine: 'pg_strtoint32_safe' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logArgs] = errorSpy.mock.calls[0];
    expect(logArgs.sql).toContain('$1::int4');
    expect(logArgs.params_preview).toContain('""');
  });

  it('trunca SQL extremadamente largo a 500 chars', async () => {
    // SELECT con WHERE muy largo que termine en un cast malo.
    const padding = 'x'.repeat(2000);
    const longSql = `SELECT $1::int4 AS id /* ${padding} */`;
    await expect(db.query(longSql, [''])).rejects.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logArgs] = errorSpy.mock.calls[0];
    expect(logArgs.sql.length).toBeLessThanOrEqual(500);
  });

  it('re-tira el error tal cual (callers ven el mismo error que sin instrumentación)', async () => {
    let caught;
    try {
      await db.query('SELECT $1::int4', ['']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.routine).toBe('pg_strtoint32_safe');
    // El error debe ser el original de pg, no envuelto.
    expect(caught.message).toMatch(/invalid input syntax for type integer/);
    // Debe tener las propiedades estándar de DatabaseError de pg.
    expect(caught.code).toBe('22P02');  // invalid_text_representation
  });

  it('queries exitosas pasan sin tocar el logger', async () => {
    const result = await db.query('SELECT 42::int4 AS answer');
    expect(result.rows[0].answer).toBe(42);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('database.js — instrumentación en client.query (vía pool.connect)', () => {
  // 2026-06-18: extensión post-mortem. La instrumentación original solo
  // cubría pool.query. Si el bug pg_strtoint vive en una query de tx (que usa
  // client.query del pool.connect), nunca lo cazaríamos. Esta suite valida
  // que el wrapper también captura desde client.query.

  let errorSpy;

  beforeEach(() => {
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('loguea int_cast_error cuando client.query dispara pg_strtoint32_safe', async () => {
    const client = await db.connect();
    try {
      await expect(
        client.query('SELECT $1::int4 AS id', [''])
      ).rejects.toMatchObject({ routine: 'pg_strtoint32_safe' });
    } finally {
      client.release();
    }

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logArgs, msg] = errorSpy.mock.calls[0];
    expect(msg).toMatch(/int_cast_error/);
    expect(logArgs).toMatchObject({
      err: expect.objectContaining({ routine: 'pg_strtoint32_safe' }),
      sql: expect.stringContaining('$1::int4'),
      params_preview: expect.stringContaining('""'),
      stack_short: expect.any(String),
    });
  });

  it('no loguea si client.query falla con otro routine no int-cast', async () => {
    const client = await db.connect();
    try {
      await expect(
        client.query('SELECT * FROM tabla_inexistente_xyz')
      ).rejects.toThrow();
    } finally {
      client.release();
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('client reusado del pool mantiene instrumentación idempotente', async () => {
    // Sacamos un client, lo devolvemos al pool, lo volvemos a sacar.
    // La instrumentación debe seguir activa pero no debe duplicarse
    // (sino veríamos 2 logs por una sola query mala).
    const client1 = await db.connect();
    client1.release();

    const client2 = await db.connect();
    try {
      await expect(
        client2.query('SELECT $1::int4', [''])
      ).rejects.toMatchObject({ routine: 'pg_strtoint32_safe' });
    } finally {
      client2.release();
    }

    // Una sola entrada de log, no dos (idempotencia del wrapper).
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('transacción manual (BEGIN/ROLLBACK) preserva instrumentación', async () => {
    // Simula el patrón change-password: connect + BEGIN + query + COMMIT/ROLLBACK.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query('SELECT $1::int4 AS id', [''])
      ).rejects.toMatchObject({ routine: 'pg_strtoint32_safe' });
      await client.query('ROLLBACK').catch(() => {});
    } finally {
      client.release();
    }

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0].sql).toContain('$1::int4');
  });
});

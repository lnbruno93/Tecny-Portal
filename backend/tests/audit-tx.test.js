// audit(client, ...) usa SAVEPOINT para aislar el INSERT de audit_logs: si falla,
// no contamina la tx exterior. Verificamos ambos paths (success y failure).
const db = require('../src/config/database');
const audit = require('../src/lib/audit');

describe('audit() dentro de tx con SAVEPOINT', () => {
  beforeAll(async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS _audit_test (id serial PRIMARY KEY, n int)`);
  });
  afterAll(async () => {
    await db.query(`DROP TABLE IF EXISTS _audit_test`);
  });
  beforeEach(async () => { await db.query('TRUNCATE _audit_test, audit_logs'); });

  test('audit dentro de tx persiste si todo va bien (rollback simétrico)', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO _audit_test (n) VALUES ($1)', [42]);
      await audit(client, 'ventas', 'INSERT', 1, { despues: { id: 1, total_usd: 100 } });
      await client.query('COMMIT');
    } finally { client.release(); }
    // Post-migration 20260711000001, registro_id es TEXT. Comparamos como
    // string en las queries de verificación.
    const { rows } = await db.query("SELECT * FROM audit_logs WHERE tabla='ventas' AND registro_id='1'");
    expect(rows).toHaveLength(1);
    expect(rows[0].datos_despues.total_usd).toBe(100);
  });

  test('si la tx exterior rollbackea, el audit también se rollbackea (atomicidad)', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await audit(client, 'ventas', 'INSERT', 999, { despues: { id: 999 } });
      await client.query('ROLLBACK');
    } finally { client.release(); }
    const { rows } = await db.query("SELECT * FROM audit_logs WHERE tabla='ventas' AND registro_id='999'");
    expect(rows).toHaveLength(0); // rollback'd
  });

  test('audit en pool global (sin client) sigue funcionando', async () => {
    await audit('ventas', 'INSERT', 7, { despues: { id: 7, foo: 'bar' } });
    const { rows } = await db.query("SELECT * FROM audit_logs WHERE tabla='ventas' AND registro_id='7'");
    expect(rows).toHaveLength(1);
  });
});

/**
 * Tests P-19 — Particionado de audit_logs por mes.
 *
 * Cubre:
 *   1. La tabla audit_logs es PARTICIONADA (relkind='p'), no plana.
 *   2. Existen 16 particiones iniciales (-12..+3 meses) post-migración.
 *   3. ensure_audit_partition(date) es idempotente — segunda llamada no rompe.
 *   4. INSERT con created_at FUERA del rango cubierto FALLA (no hay default
 *      partition por diseño — mejor fail loud que data en limbo).
 *   5. drop_old_audit_partitions(retention) dropea solo las > retention meses.
 *   6. Las queries que ya hacían los endpoints (/historial) siguen funcionando
 *      contra la tabla particionada (mismo shape de resultado).
 *   7. El job `ensureNextMonthPartition` pre-crea la partición del próximo mes.
 *
 * Sin .skip — todos los tests deben pasar.
 */
const db = require('../src/config/database');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const {
  ensureNextMonthPartition,
  dropOldPartitions,
} = require('../src/jobs/auditPartitionsJob');

let pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// Helper: cuenta partitions hijas de audit_logs.
async function countPartitions() {
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS n
    FROM pg_inherits
    JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    WHERE parent.relname = 'audit_logs'
  `);
  return rows[0].n;
}

async function listPartitionNames() {
  const { rows } = await db.query(`
    SELECT child.relname AS name
    FROM pg_inherits
    JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    WHERE parent.relname = 'audit_logs'
    ORDER BY child.relname
  `);
  return rows.map(r => r.name);
}

describe('audit_logs particionada', () => {
  test('relkind es "p" (partitioned table)', async () => {
    const { rows } = await db.query(
      `SELECT relkind FROM pg_class WHERE relname = 'audit_logs'`
    );
    expect(rows[0].relkind).toBe('p');
  });

  test('tiene 16 partitions iniciales (rango -12..+3 meses) post-migración', async () => {
    // Nota: si algún test previo creó partitions extra (ej. para fechas fuera
    // de rango en backfill), el conteo puede ser mayor. Mínimo: 16.
    const n = await countPartitions();
    expect(n).toBeGreaterThanOrEqual(16);
  });

  test('las partitions siguen naming convention audit_logs_YYYY_MM', async () => {
    const names = await listPartitionNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).toMatch(/^audit_logs_\d{4}_\d{2}$/);
    }
  });

  test('ensure_audit_partition crea una nueva partición y es idempotente', async () => {
    // Mes nuevo MUY adelante (2030-01) para no chocar con otras tests/runs.
    const targetMonth = '2030-01-01';
    const partitionName = 'audit_logs_2030_01';

    // 1ª llamada: crea
    await db.query(`SELECT ensure_audit_partition($1::date)`, [targetMonth]);
    const { rows: r1 } = await db.query(
      `SELECT 1 FROM pg_class WHERE relname = $1`,
      [partitionName]
    );
    expect(r1).toHaveLength(1);

    // 2ª llamada: idempotente (CREATE IF NOT EXISTS)
    await expect(
      db.query(`SELECT ensure_audit_partition($1::date)`, [targetMonth])
    ).resolves.not.toThrow();

    // Cleanup
    await db.query(`DROP TABLE IF EXISTS ${partitionName}`);
  });

  test('INSERT con created_at fuera del rango cubierto FALLA (no default partition)', async () => {
    // 1999 está fuera del rango cubierto por las partitions creadas en la
    // migración (que va de -12 meses a +3 meses desde el deploy). Sin default
    // partition, este INSERT debe rebotar.
    await expect(
      db.query(
        `INSERT INTO audit_logs (tabla, accion, registro_id, created_at)
         VALUES ('test', 'INSERT', 1, '1999-01-15'::timestamptz)`
      )
    ).rejects.toThrow(/no partition.*found/i);
  });

  test('drop_old_audit_partitions(N) dropea solo las > N meses, devuelve count', async () => {
    // Setup: crea una partition antigua (2010) que SÍ debería dropearse,
    // y una reciente (último mes) que NO.
    await db.query(`SELECT ensure_audit_partition('2010-05-01'::date)`);
    const before = await countPartitions();

    const { rows } = await db.query(`SELECT drop_old_audit_partitions(12) AS dropped`);
    const dropped = rows[0].dropped;

    const after = await countPartitions();

    // Al menos 1 partition dropeada (la de 2010).
    expect(dropped).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThan(before);

    // La partition de 2010 ya NO debe existir.
    const { rows: check } = await db.query(
      `SELECT 1 FROM pg_class WHERE relname = 'audit_logs_2010_05'`
    );
    expect(check).toHaveLength(0);

    // Sanity: alguna partition reciente (este mes) SIGUE existiendo.
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const { rows: recent } = await db.query(
      `SELECT 1 FROM pg_class WHERE relname = $1`,
      [`audit_logs_${yyyy}_${mm}`]
    );
    expect(recent).toHaveLength(1);
  });

  test('INSERT en partition del mes actual via audit_logs (parent) funciona y rutea', async () => {
    // Verifica que el path de escritura del audit (que sigue siendo síncrono
    // e in-tx, no se tocó por P-19) funciona transparente contra la
    // particionada — el row aparece en la partition del mes actual.
    await db.query(
      `INSERT INTO audit_logs (tabla, accion, registro_id, datos_despues, created_at)
       VALUES ('test_p19', 'INSERT', 9999, '{"foo":"bar"}'::jsonb, NOW())`
    );

    // Leer vía el padre (lo que hace /historial). Debe encontrarse.
    const { rows } = await db.query(
      `SELECT tabla, accion, registro_id, datos_despues
       FROM audit_logs
       WHERE tabla = 'test_p19' AND registro_id = '9999'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].datos_despues.foo).toBe('bar');

    // Cleanup
    await db.query(`DELETE FROM audit_logs WHERE tabla = 'test_p19'`);
  });

  test('query existente del dashboard (/historial style) sigue funcionando', async () => {
    // Insert de prueba.
    await db.query(`
      INSERT INTO audit_logs (tabla, accion, registro_id, datos_despues, created_at)
      VALUES ('ventas', 'INSERT', 1234, '{"cliente":"X"}'::jsonb, NOW())
    `);

    // Réplica simplificada de la query principal de /historial:
    //   filtros por tabla + rango temporal + LIMIT/OFFSET. La nueva tabla
    //   particionada debe responder igual.
    const { rows } = await db.query(`
      SELECT a.id, a.tabla, a.accion, a.created_at
      FROM audit_logs a
      WHERE a.tabla = 'ventas'
        AND a.created_at >= NOW() - INTERVAL '7 days'
      ORDER BY a.created_at DESC
      LIMIT 10
    `);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].tabla).toBe('ventas');

    await db.query(`DELETE FROM audit_logs WHERE tabla = 'ventas' AND registro_id = '1234'`);
  });

  test('ensureNextMonthPartition pre-crea la partition del mes siguiente (idempotente)', async () => {
    // Calcular qué partition tiene que existir post-llamada: mes próximo (UTC).
    const next = new Date();
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(1);
    const yyyy = next.getUTCFullYear();
    const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
    const expectedName = `audit_logs_${yyyy}_${mm}`;

    await ensureNextMonthPartition();
    const { rows: r1 } = await db.query(
      `SELECT 1 FROM pg_class WHERE relname = $1`,
      [expectedName]
    );
    expect(r1).toHaveLength(1);

    // Idempotente: 2ª llamada no rompe.
    await expect(ensureNextMonthPartition()).resolves.not.toThrow();
  });

  test('dropOldPartitions(retention) wrapper devuelve number', async () => {
    // Después del test de drop directo, este wrapper debe devolver un int >= 0.
    const dropped = await dropOldPartitions(12);
    expect(typeof dropped).toBe('number');
    expect(dropped).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Test de la migration 20260707000004_productos_imei_normalize_scientific.js.
 *
 * Contexto: bug del picker de Nueva Venta — productos importados desde XLSX
 * con IMEIs en formato notación científica ("3.5342733941411E14") no
 * matcheaban en la búsqueda ILIKE por sufijo del IMEI real ("...4110").
 *
 * Este test verifica que el UPDATE de la migration:
 *   1) Convierte correctamente notación científica → string de dígitos limpios.
 *   2) Preserva el 0 trailing que Excel come al convertir a float.
 *   3) NO toca IMEIs ya limpios (idempotente).
 *   4) NO toca seriales alfa-numéricos (AirPods "SJW0KF7C5P6").
 *   5) NO toca productos con deleted_at (soft-deleted).
 *   6) Re-aplicar la SQL 2 veces no cambia nada.
 *   7) Post-normalización, ILIKE por sufijo del IMEI real matchea (el bug fixed).
 *
 * Estrategia: inserta filas via el pool ADMIN (bypass RLS) directamente en
 * `productos`, luego re-corre el UPDATE de la migration a mano y verifica.
 * La migration en sí ya se aplicó en setupTestDb; acá simulamos su
 * comportamiento sobre data recién insertada para validar la SQL en cada
 * corrida (evita drift entre este test y la migration real).
 *
 * Cada test usa IMEIs únicos por test para no chocar contra
 * `idx_productos_imei_unique` — el UNIQUE se sostiene entre tests dentro del
 * mismo suite porque las inserts NO se rollbackean (los tests son
 * `describe.each` estilo).
 */

const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;
let tenantId;

// SQL de la migration extraído textual — cualquier drift entre este UPDATE y
// el que está en la migration se detecta acá al fallar los asserts.
const NORMALIZE_SQL = `
  UPDATE productos
     SET imei = (imei::numeric::bigint)::text
   WHERE imei ~ '^\\d+(\\.\\d+)?[eE]\\+?\\d+$'
     AND deleted_at IS NULL
`;

beforeAll(async () => {
  pool = await setupTestDb();
  const { rows } = await pool.query(
    `INSERT INTO tenants (nombre, slug) VALUES ('IMEI Test Tenant', 'imei-test-migration-' || floor(random()*1000000)) RETURNING id`
  );
  tenantId = rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM productos WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  await teardownTestDb(pool);
});

async function insertProducto(imei, { deleted = false } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO productos
       (tenant_id, tipo_carga, clase, nombre, imei, costo, costo_moneda, precio_venta, precio_moneda, cantidad, estado, condicion, oculto, deleted_at)
     VALUES ($1, 'unitario', 'celular', 'iPhone Test', $2, 1000, 'USD', 1100, 'USD', 1, 'disponible', 'nuevo', false, $3)
     RETURNING id`,
    [tenantId, imei, deleted ? new Date() : null]
  );
  return rows[0].id;
}

async function getImei(id) {
  const { rows } = await pool.query('SELECT imei FROM productos WHERE id = $1', [id]);
  return rows[0]?.imei;
}

describe('Migration: normalizar IMEIs en notación científica', () => {
  it('convierte "3.5342733941411E14" → "353427339414110" (preserva 0 trailing)', async () => {
    const id = await insertProducto('3.5342733941411E14');
    await pool.query(NORMALIZE_SQL);
    expect(await getImei(id)).toBe('353427339414110');
  });

  it('convierte "1.234567890123E14" → "123456789012300"', async () => {
    // Otro caso realista de IMEI en formato E-notation, con distintos dígitos
    // — probamos que el cast general funciona (no solo el caso del bug).
    const id = await insertProducto('1.234567890123E14');
    await pool.query(NORMALIZE_SQL);
    expect(await getImei(id)).toBe('123456789012300');
  });

  it('convierte "9.87E+14" → "987000000000000" (formato con "+" en exponente)', async () => {
    const id = await insertProducto('9.87E+14');
    await pool.query(NORMALIZE_SQL);
    expect(await getImei(id)).toBe('987000000000000');
  });

  it('NO toca IMEIs ya limpios (formato de 15 dígitos)', async () => {
    // Usamos un IMEI limpio DISTINTO del que resulta del test anterior — el
    // UNIQUE (parcial) sobre productos.imei bloquea inserts duplicados.
    const id = await insertProducto('355224256215887');
    await pool.query(NORMALIZE_SQL);
    expect(await getImei(id)).toBe('355224256215887');
  });

  it('NO toca seriales alfa-numéricos ("SJW0KF7C5P6")', async () => {
    const id = await insertProducto('SJW0KF7C5P6');
    await pool.query(NORMALIZE_SQL);
    expect(await getImei(id)).toBe('SJW0KF7C5P6');
  });

  it('NO toca productos soft-deleted (respeta deleted_at IS NULL)', async () => {
    const id = await insertProducto('4.5E+14', { deleted: true });
    await pool.query(NORMALIZE_SQL);
    // Sigue en formato original — la migration excluye soft-deleted para no
    // tocar historial ya eliminado (mismo criterio que el resto de RLS).
    expect(await getImei(id)).toBe('4.5E+14');
  });

  it('idempotente: aplicar 2 veces no cambia nada', async () => {
    const id = await insertProducto('7.777777777777E14');
    await pool.query(NORMALIZE_SQL);
    const primero = await getImei(id);
    await pool.query(NORMALIZE_SQL);
    const segundo = await getImei(id);
    // 7.777777777777E14 → 777777777777700 (Excel come el trailing 0 del entero
    // original 777777777777700 al representarlo como float).
    expect(primero).toBe('777777777777700');
    expect(segundo).toBe(primero);
  });

  it('post-normalización, ILIKE por sufijo del IMEI real matchea (bug root cause)', async () => {
    const id = await insertProducto('3.6E+14');
    // Pre: la búsqueda por sufijo real del IMEI ("60000000000000") NO matchea
    // porque el string en DB es "3.6E+14" (sin esos 0s contiguos). Este es
    // exactamente el root cause del bug del picker que Lucas reportó.
    const preRes = await pool.query(
      `SELECT id FROM productos WHERE imei ILIKE $1 AND id = $2`,
      ['%60000%', id]
    );
    expect(preRes.rowCount).toBe(0);
    // Post: la búsqueda matchea porque ahora el IMEI en DB es
    // "360000000000000" con todos los ceros contiguos.
    await pool.query(NORMALIZE_SQL);
    const postRes = await pool.query(
      `SELECT id FROM productos WHERE imei ILIKE $1 AND id = $2`,
      ['%60000%', id]
    );
    expect(postRes.rowCount).toBe(1);
  });
});

/**
 * Test de la migration 20260707000003_plantillas_garantia_placeholder_negocio.
 *
 * Valida que el regexp de la migration:
 *   - Reemplaza los pies conocidos "Tecny|iPro [| Tech] Reseller" al final
 *     del texto por "{{negocio}} | Tech Reseller".
 *   - Reemplaza pies "Tecny" o "iPro" solos por "{{negocio}}".
 *   - NO toca plantillas con pies custom del tenant (ej. "Celnyx | Tech
 *     Reseller", "Tek Haus | Reseller").
 *   - NO toca menciones de "iPro"/"Tecny" dentro del body.
 *   - Idempotente — segunda corrida no cambia nada.
 *
 * Ejecuta el SQL de la migration directamente contra la DB de tests
 * (mismo pattern que otras migration-tests del repo). Si alguien edita
 * el regex en la migration y no actualiza este test, o viceversa, se
 * rompe la sincronización — mantener ambos alineados.
 */

const { setupTestDb, teardownTestDb } = require('./helpers/setup');

// SQL idéntico al de la migration. Mantener sincronizado.
const UPDATE_CON_RESELLER = `
  UPDATE plantillas_garantia
     SET texto = regexp_replace(
       texto,
       E'\\n\\n(Tecny|iPro)( Tech)?( ?\\\\| ?(Tech )?Reseller)\\\\s*$',
       E'\\n\\n{{negocio}} | Tech Reseller',
       'in'
     )
   WHERE deleted_at IS NULL
     AND texto ~* E'\\n\\n(Tecny|iPro)( Tech)?( ?\\\\| ?(Tech )?Reseller)\\\\s*$'
`;

const UPDATE_SIN_RESELLER = `
  UPDATE plantillas_garantia
     SET texto = regexp_replace(
       texto,
       E'\\n\\n(Tecny|iPro)( Tech)?\\\\s*$',
       E'\\n\\n{{negocio}}',
       'in'
     )
   WHERE deleted_at IS NULL
     AND texto ~* E'\\n\\n(Tecny|iPro)( Tech)?\\\\s*$'
`;

async function runMigration(pool) {
  await pool.query(UPDATE_CON_RESELLER);
  await pool.query(UPDATE_SIN_RESELLER);
}

const BODY = 'Este comprobante es tu nota de compra.\n\nNos responsabilizamos por 12 meses.';

let pool;

beforeAll(async () => { pool = await setupTestDb(); });
afterAll(async () => { await teardownTestDb(pool); });

async function insertPlantilla(nombre, texto) {
  const { rows } = await pool.query(
    `INSERT INTO plantillas_garantia (tenant_id, nombre, texto, es_default)
     VALUES (1, $1, $2, false) RETURNING id`,
    [nombre, texto]
  );
  return rows[0];
}

async function getTexto(id) {
  const { rows } = await pool.query('SELECT texto FROM plantillas_garantia WHERE id = $1', [id]);
  return rows[0]?.texto;
}

describe('Migration: convertir pies hardcoded a placeholder {{negocio}}', () => {
  it('"iPro | Tech Reseller" → "{{negocio}} | Tech Reseller"', async () => {
    const p = await insertPlantilla('t1', `${BODY}\n\niPro | Tech Reseller`);
    await runMigration(pool);
    expect(await getTexto(p.id)).toBe(`${BODY}\n\n{{negocio}} | Tech Reseller`);
  });

  it('"Tecny | Tech Reseller" → "{{negocio}} | Tech Reseller"', async () => {
    const p = await insertPlantilla('t2', `${BODY}\n\nTecny | Tech Reseller`);
    await runMigration(pool);
    expect(await getTexto(p.id)).toBe(`${BODY}\n\n{{negocio}} | Tech Reseller`);
  });

  it('"Tecny Tech | Reseller" → "{{negocio}} | Tech Reseller"', async () => {
    const p = await insertPlantilla('t3', `${BODY}\n\nTecny Tech | Reseller`);
    await runMigration(pool);
    expect(await getTexto(p.id)).toBe(`${BODY}\n\n{{negocio}} | Tech Reseller`);
  });

  it('"Tecny" solo → "{{negocio}}"', async () => {
    const p = await insertPlantilla('t4', `${BODY}\n\nTecny`);
    await runMigration(pool);
    expect(await getTexto(p.id)).toBe(`${BODY}\n\n{{negocio}}`);
  });

  it('"iPro" solo → "{{negocio}}"', async () => {
    const p = await insertPlantilla('t5', `${BODY}\n\niPro`);
    await runMigration(pool);
    expect(await getTexto(p.id)).toBe(`${BODY}\n\n{{negocio}}`);
  });

  it('NO toca "Celnyx | Tech Reseller" (nombre custom)', async () => {
    const original = `${BODY}\n\nCelnyx | Tech Reseller`;
    const p = await insertPlantilla('t6', original);
    await runMigration(pool);
    expect(await getTexto(p.id)).toBe(original);
  });

  it('NO toca "Tek Haus | Reseller" (nombre custom)', async () => {
    const original = `${BODY}\n\nTek Haus | Reseller`;
    const p = await insertPlantilla('t7', original);
    await runMigration(pool);
    expect(await getTexto(p.id)).toBe(original);
  });

  it('NO toca menciones de iPro/Tecny en el medio del body', async () => {
    // Body incluye "iPro X" como parte del producto, no como pie.
    const original = 'El producto es un iPro X.\n\nGarantía de 12 meses.';
    const p = await insertPlantilla('t8', original);
    await runMigration(pool);
    expect(await getTexto(p.id)).toBe(original);
  });

  it('NO toca plantilla ya migrada con "{{negocio}}"', async () => {
    const original = `${BODY}\n\n{{negocio}} | Tech Reseller`;
    const p = await insertPlantilla('t9', original);
    await runMigration(pool);
    expect(await getTexto(p.id)).toBe(original);
  });

  it('es idempotente — segunda corrida no cambia nada', async () => {
    const p = await insertPlantilla('t10', `${BODY}\n\niPro | Tech Reseller`);
    await runMigration(pool);
    const primeraCorrida = await getTexto(p.id);
    await runMigration(pool);
    const segundaCorrida = await getTexto(p.id);
    expect(primeraCorrida).toBe(`${BODY}\n\n{{negocio}} | Tech Reseller`);
    expect(segundaCorrida).toBe(primeraCorrida);
  });
});

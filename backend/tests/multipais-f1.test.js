/**
 * Multi-país (Pesos UY) — F1: tests del schema + helpers.
 *
 * Cubre las 3 migrations + los 3 helpers nuevos de `src/lib/money.js`:
 *
 *   Schema:
 *     · tenants.pais (default 'AR', CHECK IN ('AR','UY'))
 *     · tc_defaults_pais (seed AR=1400, UY=40, CHECK pais + valor > 0,
 *       ON DELETE SET NULL para updated_by, PK (pais, par))
 *     · CHECK moneda ampliado a UYU en productos.{costo,precio}_moneda
 *
 *   Helpers (puros, sin DB):
 *     · isMonedaValidaParaPais(moneda, pais)
 *     · getMonedaLocalPais(pais)
 *
 *   Helper con DB:
 *     · getTcDefaultPais(client, pais) — lookup en tc_defaults_pais
 *
 * Caveat de testing local: el pool de tests corre con un user superuser
 * de Postgres (default en macOS), así que no probamos GRANTs específicos
 * acá — los roles `tecny_admin` y `ipro_app` no existen en dev/CI y la
 * migration 3 skipea los GRANTs (ver bloque DO IF EXISTS pg_roles).
 *
 * Test ID: F1 multi-país UY.
 */

const {
  isMonedaValidaParaPais,
  getMonedaLocalPais,
  getTcDefaultPais,
  MONEDAS_POR_PAIS,
  TODAS_LAS_MONEDAS,
} = require('../src/lib/money');

const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── Helpers puros (sin DB) ─────────────────────────────────────────────

describe('money.js — isMonedaValidaParaPais (unit puro)', () => {
  // Argentina: ARS local + USD/USDT universales.
  it('AR habilita ARS', () => {
    expect(isMonedaValidaParaPais('ARS', 'AR')).toBe(true);
  });
  it('AR rechaza UYU', () => {
    expect(isMonedaValidaParaPais('UYU', 'AR')).toBe(false);
  });
  it('AR habilita USD (universal)', () => {
    expect(isMonedaValidaParaPais('USD', 'AR')).toBe(true);
  });
  it('AR habilita USDT (universal)', () => {
    expect(isMonedaValidaParaPais('USDT', 'AR')).toBe(true);
  });

  // Uruguay: UYU local + USD/USDT universales.
  it('UY habilita UYU', () => {
    expect(isMonedaValidaParaPais('UYU', 'UY')).toBe(true);
  });
  it('UY rechaza ARS', () => {
    expect(isMonedaValidaParaPais('ARS', 'UY')).toBe(false);
  });
  it('UY habilita USD (universal)', () => {
    expect(isMonedaValidaParaPais('USD', 'UY')).toBe(true);
  });
  it('UY habilita USDT (universal)', () => {
    expect(isMonedaValidaParaPais('USDT', 'UY')).toBe(true);
  });

  // País desconocido: fallback permisivo solo para monedas globales (USD/USDT).
  it('país XX desconocido + USD → true (fallback global)', () => {
    expect(isMonedaValidaParaPais('USD', 'XX')).toBe(true);
  });
  it('país XX desconocido + USDT → true (fallback global)', () => {
    expect(isMonedaValidaParaPais('USDT', 'XX')).toBe(true);
  });
  it('país XX desconocido + ARS → false', () => {
    expect(isMonedaValidaParaPais('ARS', 'XX')).toBe(false);
  });
  it('país XX desconocido + UYU → false', () => {
    expect(isMonedaValidaParaPais('UYU', 'XX')).toBe(false);
  });
});

describe('money.js — getMonedaLocalPais (unit puro)', () => {
  it('AR → ARS', () => {
    expect(getMonedaLocalPais('AR')).toBe('ARS');
  });
  it('UY → UYU', () => {
    expect(getMonedaLocalPais('UY')).toBe('UYU');
  });
});

describe('money.js — matriz país↔monedas (exports)', () => {
  it('MONEDAS_POR_PAIS expone AR y UY', () => {
    expect(MONEDAS_POR_PAIS).toHaveProperty('AR');
    expect(MONEDAS_POR_PAIS).toHaveProperty('UY');
    expect(MONEDAS_POR_PAIS.AR).toEqual(expect.arrayContaining(['ARS', 'USD', 'USDT']));
    expect(MONEDAS_POR_PAIS.UY).toEqual(expect.arrayContaining(['UYU', 'USD', 'USDT']));
  });
  it('TODAS_LAS_MONEDAS contiene las 4 monedas habilitadas', () => {
    expect(TODAS_LAS_MONEDAS.sort()).toEqual(['ARS', 'USD', 'USDT', 'UYU']);
  });
});

// ─── Schema: tenants.pais ───────────────────────────────────────────────

describe('Schema — tenants.pais', () => {
  // Tenant IDs altos para no chocar con tenant 1 ni con otros suites.
  const TENANT_AR = 9701;
  const TENANT_UY = 9702;
  const TENANT_NOPAIS = 9703;

  afterAll(async () => {
    await pool.query(`DELETE FROM tenants WHERE id IN ($1,$2,$3)`,
      [TENANT_AR, TENANT_UY, TENANT_NOPAIS]);
  });

  it('INSERT con pais=UY persiste', async () => {
    await pool.query(
      `INSERT INTO tenants (id, nombre, slug, plan, pais) VALUES ($1, $2, $3, 'starter', 'UY')`,
      [TENANT_UY, 'Multi País UY', 'multi-pais-uy']
    );
    const { rows } = await pool.query(`SELECT pais FROM tenants WHERE id = $1`, [TENANT_UY]);
    expect(rows[0].pais).toBe('UY');
  });

  it('INSERT con pais=XX inválido → CHECK violation', async () => {
    await expect(
      pool.query(
        `INSERT INTO tenants (id, nombre, slug, plan, pais) VALUES ($1, $2, $3, 'starter', 'XX')`,
        [9999, 'Multi País XX', 'multi-pais-xx']
      )
    ).rejects.toThrow(/check constraint|tenants_pais_check/i);
  });

  it('INSERT sin pais → default AR', async () => {
    await pool.query(
      `INSERT INTO tenants (id, nombre, slug, plan) VALUES ($1, $2, $3, 'starter')`,
      [TENANT_NOPAIS, 'Multi País Default', 'multi-pais-default']
    );
    const { rows } = await pool.query(`SELECT pais FROM tenants WHERE id = $1`, [TENANT_NOPAIS]);
    expect(rows[0].pais).toBe('AR');
  });
});

// ─── Schema: tc_defaults_pais ───────────────────────────────────────────

describe('Schema — tc_defaults_pais', () => {
  it('seed inicial tiene 2 rows: AR ARS/USD=1400 + UY UYU/USD=40', async () => {
    const { rows } = await pool.query(
      `SELECT pais, par, valor FROM tc_defaults_pais ORDER BY pais`
    );
    // El TRUNCATE de setupTestDb NO incluye tc_defaults_pais (no es tenant-data),
    // pero CASCADE de users → updated_by puede setearla a NULL sin borrar la fila.
    // El seed inicial sigue ahí.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const ar = rows.find(r => r.pais === 'AR' && r.par === 'ARS/USD');
    const uy = rows.find(r => r.pais === 'UY' && r.par === 'UYU/USD');
    expect(ar).toBeDefined();
    expect(uy).toBeDefined();
    expect(Number(ar.valor)).toBe(1400);
    expect(Number(uy.valor)).toBe(40);
  });

  it('INSERT con pais=XX → CHECK violation', async () => {
    await expect(
      pool.query(
        `INSERT INTO tc_defaults_pais (pais, par, valor) VALUES ('XX', 'XX/USD', 100)`
      )
    ).rejects.toThrow(/check constraint|tc_defaults_pais_pais_check/i);
  });

  it('INSERT con valor=0 → CHECK violation (valor > 0)', async () => {
    await expect(
      pool.query(
        `INSERT INTO tc_defaults_pais (pais, par, valor) VALUES ('AR', 'TEST/USD', 0)`
      )
    ).rejects.toThrow(/check constraint|tc_defaults_pais_valor_check/i);
  });

  it('UPDATE setea updated_by a user existente OK + DELETE del user → updated_by NULL (ON DELETE SET NULL)', async () => {
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash('tcdefpass_x', 4);
    // Crear user efímero, setearlo como updated_by, borrarlo y verificar la cascada.
    const { rows: ru } = await pool.query(
      `INSERT INTO users (nombre, username, email, password_hash, role) VALUES ($1,$2,$3,$4,'admin') RETURNING id`,
      ['TC Def User', 'tcdef_user', 'tcdef_user@test.local', hash]
    );
    const userId = ru[0].id;

    // Insertar un par de TC ad-hoc apuntando al user creado.
    await pool.query(
      `INSERT INTO tc_defaults_pais (pais, par, valor, updated_by) VALUES ('AR', 'TC_DEF_TEST/USD', 99.99, $1)`,
      [userId]
    );
    const { rows: pre } = await pool.query(
      `SELECT updated_by FROM tc_defaults_pais WHERE pais='AR' AND par='TC_DEF_TEST/USD'`
    );
    expect(pre[0].updated_by).toBe(userId);

    // Borrar el user. La FK con ON DELETE SET NULL debe nullificar updated_by.
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    const { rows: post } = await pool.query(
      `SELECT updated_by FROM tc_defaults_pais WHERE pais='AR' AND par='TC_DEF_TEST/USD'`
    );
    expect(post[0].updated_by).toBeNull();

    // Cleanup.
    await pool.query(`DELETE FROM tc_defaults_pais WHERE pais='AR' AND par='TC_DEF_TEST/USD'`);
  });
});

// ─── Helper getTcDefaultPais (con DB) ───────────────────────────────────

describe('money.js — getTcDefaultPais (con DB)', () => {
  it('AR → 1400', async () => {
    const tc = await getTcDefaultPais(pool, 'AR');
    expect(tc).toBe(1400);
  });
  it('UY → 40', async () => {
    const tc = await getTcDefaultPais(pool, 'UY');
    expect(tc).toBe(40);
  });
  it('país inexistente → null', async () => {
    // Pasa CHECK constraint (no llega a INSERT, sólo SELECT). Aún si el par
    // no existe, el helper devuelve null en vez de tirar.
    const tc = await getTcDefaultPais(pool, 'AR_NOPE');
    expect(tc).toBeNull();
  });
});

// ─── CHECK moneda ampliado en productos ─────────────────────────────────

describe('Schema — CHECK moneda en productos extendido a UYU', () => {
  // El test admin crea categorias + depositos automáticamente vía setupTestDb.
  // Usamos un producto efímero con tenant_id=1.
  it('INSERT producto con costo_moneda=UYU y precio_moneda=UYU → OK', async () => {
    const { rows } = await pool.query(
      `INSERT INTO productos (nombre, costo, costo_moneda, precio_venta, precio_moneda, tenant_id)
       VALUES ($1, $2, 'UYU', $3, 'UYU', 1) RETURNING id`,
      ['Multipais UYU prod', 500, 800]
    );
    expect(rows[0].id).toBeDefined();
    await pool.query(`DELETE FROM productos WHERE id = $1`, [rows[0].id]);
  });

  it('INSERT producto con costo_moneda=XX inválido → CHECK violation', async () => {
    await expect(
      pool.query(
        `INSERT INTO productos (nombre, costo, costo_moneda, precio_venta, precio_moneda, tenant_id)
         VALUES ($1, $2, 'XX', $3, 'USD', 1)`,
        ['Multipais XX prod', 500, 800]
      )
    ).rejects.toThrow(/check constraint|productos_costo_moneda_check/i);
  });
});

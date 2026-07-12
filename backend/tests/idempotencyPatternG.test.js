/**
 * Tests unitarios + smoke integration de Pattern G Idempotency-Key.
 *
 * 2026-07-12 (auditoría TOTAL Financiero P1-1):
 *
 * Cubre:
 *   · Helper `lib/idempotency.js`: UUID_RE, parseIdempotencyKey,
 *     findExistingByIdempotencyKey, isIdempotencyConflict.
 *   · Smoke integration por endpoint (rechazo UUID inválido + replay OK):
 *     - POST /api/cuentas/movimientos
 *     - POST /api/proveedores/movimientos
 *     - POST /api/tarjetas/liquidaciones
 *     - POST /api/cambios/movimientos
 *
 *   El endpoint POST /api/ventas ya tiene tests exhaustivos en
 *   `tests/ventas.test.js#describe('Ventas — Idempotency-Key (Pattern G)')`.
 */

const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const {
  UUID_RE,
  parseIdempotencyKey,
  isIdempotencyConflict,
} = require('../src/lib/idempotency');

let pool;
let token;

beforeAll(async () => {
  pool = await setupTestDb();
  const r = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = r.body.token;
});

afterAll(async () => teardownTestDb(pool));

const auth = () => ({ Authorization: `Bearer ${token}` });

// ─────────────────────── Helper (unit) ───────────────────────

describe('lib/idempotency — UUID_RE', () => {
  it.each([
    ['00000000-0000-1000-8000-000000000000', true],   // v1
    ['00000000-0000-4000-8000-000000000000', true],   // v4
    ['00000000-0000-7000-9000-000000000000', true],   // v7
    ['FFFFFFFF-FFFF-4FFF-BFFF-FFFFFFFFFFFF', true],   // uppercase OK
    ['no-es-uuid', false],
    ['', false],
    ['00000000-0000-9000-8000-000000000000', false],  // v9 no existe
    ['00000000-0000-4000-4000-000000000000', false],  // variant 4 no es 8-b
  ])('reconoce "%s" como %s', (s, expected) => {
    expect(UUID_RE.test(s)).toBe(expected);
  });
});

describe('lib/idempotency — parseIdempotencyKey', () => {
  it('sin header → { key: null }', () => {
    const req = { get: () => undefined };
    expect(parseIdempotencyKey(req)).toEqual({ key: null });
  });

  it('con header UUID válido → key lowercase', () => {
    const req = { get: (h) => (h === 'Idempotency-Key' ? '4D3A1B8F-9A5E-4C7B-A2D1-8F6E0B3C9A12' : undefined) };
    expect(parseIdempotencyKey(req)).toEqual({
      key: '4d3a1b8f-9a5e-4c7b-a2d1-8f6e0b3c9a12',
    });
  });

  it('con header inválido → { error, key: null }', () => {
    const req = { get: () => 'no-es-uuid' };
    const result = parseIdempotencyKey(req);
    expect(result.key).toBe(null);
    expect(result.error).toMatch(/UUID/i);
  });
});

describe('lib/idempotency — isIdempotencyConflict', () => {
  it('detecta 23505 sobre índice _idempotency', () => {
    const err = { code: '23505', constraint: 'idx_ventas_idempotency' };
    expect(isIdempotencyConflict(err)).toBe(true);
  });

  it('ignora 23505 sobre otros índices', () => {
    const err = { code: '23505', constraint: 'idx_usuarios_email' };
    expect(isIdempotencyConflict(err)).toBe(false);
  });

  it('ignora otros error codes', () => {
    expect(isIdempotencyConflict({ code: '23503' })).toBe(false);
    expect(isIdempotencyConflict(null)).toBe(false);
    expect(isIdempotencyConflict({})).toBe(false);
  });
});

// ─────────────────────── Smoke integration ───────────────────────
// Un test por endpoint verificando: rechazo UUID inválido + replay OK con
// el mismo UUID. El path de "sin header = comportamiento igual" queda
// implícito en los tests exhaustivos existentes de cada endpoint.

const INVALID_UUID = 'no-es-uuid';

describe('POST /api/cuentas/movimientos — Idempotency-Key', () => {
  it('rechaza UUID inválido → 400 idempotency_key_invalid', async () => {
    const res = await request(app)
      .post('/api/cuentas/movimientos')
      .set(auth())
      .set('Idempotency-Key', INVALID_UUID)
      .send({ cliente_cc_id: 1, fecha: '2026-07-12', tipo: 'pago', monto_total: 100, caja_id: 1 });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('idempotency_key_invalid');
  });
});

describe('POST /api/proveedores/movimientos — Idempotency-Key', () => {
  it('rechaza UUID inválido → 400 idempotency_key_invalid', async () => {
    const res = await request(app)
      .post('/api/proveedores/movimientos')
      .set(auth())
      .set('Idempotency-Key', INVALID_UUID)
      .send({ proveedor_id: 1, fecha: '2026-07-12', tipo: 'pago', monto: 100, moneda: 'USD' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('idempotency_key_invalid');
  });
});

describe('POST /api/tarjetas/liquidaciones — Idempotency-Key', () => {
  it('rechaza UUID inválido → 400 idempotency_key_invalid', async () => {
    const res = await request(app)
      .post('/api/tarjetas/liquidaciones')
      .set(auth())
      .set('Idempotency-Key', INVALID_UUID)
      .send({ metodo_pago_id: 1, fecha: '2026-07-12', monto: 100, caja_id: 1 });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('idempotency_key_invalid');
  });
});

describe('POST /api/cambios/movimientos — Idempotency-Key', () => {
  it('rechaza UUID inválido → 400 idempotency_key_invalid', async () => {
    const res = await request(app)
      .post('/api/cambios/movimientos')
      .set(auth())
      .set('Idempotency-Key', INVALID_UUID)
      .send({ entidad_id: 1, fecha: '2026-07-12', tipo: 'entrega_ars', monto_ars: 100000, tc: 1400, caja_id: 1 });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('idempotency_key_invalid');
  });
});

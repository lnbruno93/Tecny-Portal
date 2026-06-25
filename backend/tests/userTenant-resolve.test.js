/**
 * Tests del helper resolveUserTenant (lib/userTenant.js).
 *
 * 2026-06-24 SEG-2 (audit pre-live): el fallback fail-OPEN
 * `{ tenant_id: 1, rol: 'member' }` se convirtió en throw NO_TENANT.
 * Antes el user sin tenant_users podía leer data del tenant del owner
 * (data leak). Ahora la función falla cerrada con 401.
 *
 * Tests lockean:
 *   1. Happy path: user con tenant_users devuelve la row, sin warn.
 *   2. Edge path: user sin tenant_users → throw con status=401 y
 *      code='NO_TENANT'. El warn sigue emitiéndose (para Sentry).
 */

const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const { resolveUserTenant } = require('../src/lib/userTenant');
const logger = require('../src/lib/logger');

describe('resolveUserTenant', () => {
  let pool;
  let warnSpy;

  beforeAll(async () => {
    pool = await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb(pool);
  });

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('user con tenant_users → devuelve la row, sin warn', async () => {
    // setupTestDb crea Test Admin (user_id=1) vinculado a tenant_id=1 vía
    // la migration multitenant_schema (backfill INSERT en tenant_users).
    const result = await resolveUserTenant(1);

    expect(result).toMatchObject({
      tenant_id: 1,
      // rol depende del bootstrap (owner para el user con id mínimo).
      rol: expect.stringMatching(/^(owner|admin|member)$/),
    });

    // Crítico: el warn NO debe dispararse en el happy path.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('SEG-2 user sin tenant_users → throw NO_TENANT (fail-closed)', async () => {
    // Usamos un user_id que sabemos que NO existe (no creamos tenant_users
    // para él). El throw debe dispararse.
    const NONEXISTENT_USER_ID = 999999;

    await expect(resolveUserTenant(NONEXISTENT_USER_ID)).rejects.toMatchObject({
      status: 401,
      code: 'NO_TENANT',
    });

    // El warn sigue emitiéndose para alerta en Sentry — el caller (login)
    // se encarga de convertir el throw en 401 al cliente.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload, msg] = warnSpy.mock.calls[0];
    expect(payload).toMatchObject({ userId: NONEXISTENT_USER_ID });
    expect(msg).toMatch(/tenant_users|NO_TENANT/i);
  });
});

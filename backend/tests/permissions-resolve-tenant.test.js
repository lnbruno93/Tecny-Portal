/**
 * Tests del helper resolveUserTenant (lib/permissions.js).
 *
 * 2026-06-18 #319 hygiene: el fallback `{ tenant_id: 1, rol: 'member' }`
 * cuando un user no tiene tenant_users row es un potencial data leak. Ahora
 * se loggea como WARN para que dispare alerta en Sentry. Estos tests lockean:
 *
 *   1. Happy path: user con tenant_users devuelve la row, sin warn.
 *   2. Edge path: user sin tenant_users devuelve fallback + emite warn con
 *      el userId, para que OPS pueda identificar al user afectado.
 */

const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const { resolveUserTenant } = require('../src/lib/permissions');
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

  it('#319 user sin tenant_users → devuelve fallback + emite warn con userId', async () => {
    // Usamos un user_id que sabemos que NO existe (no creamos tenant_users
    // para él). El fallback debe disparar.
    const NONEXISTENT_USER_ID = 999999;

    const result = await resolveUserTenant(NONEXISTENT_USER_ID);

    expect(result).toEqual({ tenant_id: 1, rol: 'member' });

    // El warn debe haberse llamado UNA vez con el userId que falló y el
    // tenant_id de fallback. El mensaje debe mencionar "tenant_users" o
    // "data leak" para que OPS lo identifique en logs/Sentry.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload, msg] = warnSpy.mock.calls[0];
    expect(payload).toMatchObject({
      userId: NONEXISTENT_USER_ID,
      fallback_tenant_id: 1,
    });
    expect(msg).toMatch(/tenant_users|data leak/i);
  });
});

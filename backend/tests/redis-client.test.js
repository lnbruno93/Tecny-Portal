// Tests del wrapper redisClient — verifican que las operaciones sean
// fault-tolerant: timeouts, errores, y client null devuelven fallback en
// vez de tirar excepciones que tumben requests.
//
// Usa mock inyectado via `_setClientForTest`. NO necesita Redis real.
const redis = require('../src/lib/redisClient');

describe('redisClient — fallback graceful', () => {
  afterEach(() => {
    redis._setClientForTest(null);
  });

  test('get() devuelve null si no hay client (REDIS_URL no set)', async () => {
    redis._setClientForTest(null);
    expect(await redis.get('any-key')).toBeNull();
  });

  test('setEx() devuelve false si no hay client', async () => {
    redis._setClientForTest(null);
    expect(await redis.setEx('k', 60, 'v')).toBe(false);
  });

  test('del() devuelve false si no hay client', async () => {
    redis._setClientForTest(null);
    expect(await redis.del('k')).toBe(false);
  });

  test('ping() devuelve false si no hay client', async () => {
    redis._setClientForTest(null);
    expect(await redis.ping()).toBe(false);
  });

  test('isEnabled() devuelve false en NODE_ENV=test sin importar REDIS_URL', async () => {
    // El módulo se carga con NODE_ENV=test desde jest, ENABLED es false desde el constructor.
    expect(redis.isEnabled()).toBe(false);
  });

  test('get() con timeout: si el client tarda más de 500ms, devuelve null sin colgar', async () => {
    // Mock que nunca resuelve.
    const slowMock = {
      get: jest.fn(() => new Promise(() => {})), // never resolves
    };
    redis._setClientForTest(slowMock);

    const start = Date.now();
    const result = await redis.get('k');
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // Debe haber timeouteado en ~500ms, NO esperado para siempre.
    expect(elapsed).toBeLessThan(800);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  }, 2000);

  test('get() con error: si el client tira, devuelve null sin propagar', async () => {
    const errMock = {
      get: jest.fn(() => Promise.reject(new Error('connection refused'))),
    };
    redis._setClientForTest(errMock);

    const result = await redis.get('k');
    expect(result).toBeNull();
  });

  test('setEx() valor exitoso: devuelve true cuando SETEX devuelve "OK"', async () => {
    const okMock = {
      setex: jest.fn(async () => 'OK'),
    };
    redis._setClientForTest(okMock);

    expect(await redis.setEx('k', 60, 'v')).toBe(true);
    expect(okMock.setex).toHaveBeenCalledWith('k', 60, 'v');
  });

  test('setEx() falla en network: devuelve false', async () => {
    const failMock = {
      setex: jest.fn(() => Promise.reject(new Error('connection lost'))),
    };
    redis._setClientForTest(failMock);

    expect(await redis.setEx('k', 60, 'v')).toBe(false);
  });

  test('del() exitoso: devuelve true', async () => {
    const okMock = {
      del: jest.fn(async () => 1),
    };
    redis._setClientForTest(okMock);

    expect(await redis.del('k')).toBe(true);
  });

  test('ping() exitoso devuelve true', async () => {
    const okMock = {
      ping: jest.fn(async () => 'PONG'),
    };
    redis._setClientForTest(okMock);

    expect(await redis.ping()).toBe(true);
  });

  test('ping() respuesta inesperada (no PONG) devuelve false', async () => {
    const badMock = {
      ping: jest.fn(async () => 'NOT-PONG'),
    };
    redis._setClientForTest(badMock);

    expect(await redis.ping()).toBe(false);
  });
});

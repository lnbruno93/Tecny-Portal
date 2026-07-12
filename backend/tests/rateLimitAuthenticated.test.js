/**
 * Tests unitarios del helper `validateAndGetJwtUserId` — base del rate
 * limiter secundario per user.id (Pattern A cross-track, auditoría TOTAL
 * 2026-07-12).
 *
 * Cierra el gap identificado por 3 tracks distintos (Plataforma P0-2 +
 * Auth P1-8 + Externa P1-2): antes, un JWT firmado válido skippeaba TODO
 * el rate limiter global — un token robado con TTL 8h podía burnear budget
 * de OCR/Anthropic o saturar el pool DB. Ahora los authenticated caen a
 * un limiter secundario per user.id (1000/15min).
 *
 * El helper `validateAndGetJwtUserId` es el core: verifica firma HS256,
 * decodifica el payload, extrae user.id, y cachea el resultado en `req`
 * para que los 2 limiters (skip del global + keyGenerator del authenticated)
 * no dupliquen el jwt.verify.
 *
 * NOTA: los tests del rate limiter en sí (429 tras N requests) requerirían
 * mockear `isTestEnv` que está hard-cached en app.js — no es viable sin un
 * refactor mayor. La verificación end-to-end se hace via smoke test en
 * staging/prod (documentado en el PR).
 */
const jwt = require('jsonwebtoken');
// 2026-07-12: importamos del módulo puro `lib/jwtVerify.js` en vez de app.js.
// Cargar app.js abre pool DB, Redis, jobs — handles que pueden dejar el proceso
// jest colgado con exit code 1 en CI. El módulo lib es sin side-effects.
const { validateAndGetJwtUserId, hasValidSignedJwt } = require('../src/lib/jwtVerify');

const JWT_SECRET = process.env.JWT_SECRET;

function mockReq(overrides = {}) {
  return {
    headers: {},
    ...overrides,
  };
}

describe('validateAndGetJwtUserId (Pattern A JWT rate limiter helper)', () => {
  it('sin Authorization header → null', () => {
    const req = mockReq();
    expect(validateAndGetJwtUserId(req)).toBeNull();
  });

  it('Authorization sin prefix "Bearer " → null', () => {
    const req = mockReq({ headers: { authorization: 'Basic abcd' } });
    expect(validateAndGetJwtUserId(req)).toBeNull();
  });

  it('token vacío después de "Bearer " → null', () => {
    const req = mockReq({ headers: { authorization: 'Bearer ' } });
    expect(validateAndGetJwtUserId(req)).toBeNull();
  });

  it('token con firma inválida → null (no throw)', () => {
    const req = mockReq({ headers: { authorization: 'Bearer xxx.yyy.zzz' } });
    expect(validateAndGetJwtUserId(req)).toBeNull();
  });

  it('token válido con user.id → devuelve el id como Number', () => {
    const token = jwt.sign({ id: 42, username: 'test' }, JWT_SECRET, { algorithm: 'HS256' });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(validateAndGetJwtUserId(req)).toBe(42);
  });

  it('token válido con id como string → devuelve Number(id)', () => {
    // Defensive: si el token tiene id: "42" en vez de id: 42, castear.
    const token = jwt.sign({ id: '42', username: 'test' }, JWT_SECRET, { algorithm: 'HS256' });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(validateAndGetJwtUserId(req)).toBe(42);
  });

  it('token válido SIN user.id (payload roto) → null', () => {
    const token = jwt.sign({ username: 'test' }, JWT_SECRET, { algorithm: 'HS256' });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(validateAndGetJwtUserId(req)).toBeNull();
  });

  it('token firmado con algorithm distinto (RS256) → null (rechaza alg confusion)', () => {
    // Crítico: el helper explícita algorithms: ['HS256']. Un token firmado
    // con otro alg (aunque el secret sea el mismo string) NO se acepta.
    // Esto previene el ataque "alg: none" o RS256 con pubkey.
    // NOTE: jwt.sign con HS256 firma OK; probamos con "none" que no requiere secret.
    const noneToken = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJpZCI6NDJ9.';
    const req = mockReq({ headers: { authorization: `Bearer ${noneToken}` } });
    expect(validateAndGetJwtUserId(req)).toBeNull();
  });

  it('cache: 2 llamadas al mismo req NO re-ejecutan jwt.verify', () => {
    const token = jwt.sign({ id: 7 }, JWT_SECRET, { algorithm: 'HS256' });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const first = validateAndGetJwtUserId(req);
    expect(first).toBe(7);
    // Modificar el header a algo inválido — el cache debe seguir devolviendo 7.
    req.headers.authorization = 'Bearer garbage';
    const second = validateAndGetJwtUserId(req);
    expect(second).toBe(7);
    // Y el flag interno queda seteado.
    expect(req._validatedJwtUserId).toBe(7);
  });

  it('cache: llamada previa con null también se cachea (evita re-verify)', () => {
    const req = mockReq({ headers: { authorization: 'Bearer garbage' } });
    const first = validateAndGetJwtUserId(req);
    expect(first).toBeNull();
    // Ahora agregamos un token válido — el cache debería seguir devolviendo null.
    const token = jwt.sign({ id: 99 }, JWT_SECRET, { algorithm: 'HS256' });
    req.headers.authorization = `Bearer ${token}`;
    const second = validateAndGetJwtUserId(req);
    expect(second).toBeNull();
  });
});

describe('hasValidSignedJwt (compat wrapper)', () => {
  it('token válido → true', () => {
    const token = jwt.sign({ id: 1 }, JWT_SECRET, { algorithm: 'HS256' });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(hasValidSignedJwt(req)).toBe(true);
  });

  it('token inválido → false', () => {
    const req = mockReq({ headers: { authorization: 'Bearer xxx' } });
    expect(hasValidSignedJwt(req)).toBe(false);
  });

  it('sin header → false', () => {
    const req = mockReq();
    expect(hasValidSignedJwt(req)).toBe(false);
  });
});

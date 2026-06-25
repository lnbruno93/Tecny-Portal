/**
 * Tests del helper hCaptcha verifyCaptcha.
 *
 * Cubre:
 *   - NODE_ENV=test bypass (default).
 *   - HCAPTCHA_FORCE_IN_TESTS=1 fuerza verificación incluso en test.
 *   - HCAPTCHA_ENABLED!='true' bypass.
 *   - HCAPTCHA_ENABLED='true' sin SECRET → config_error.
 *   - Token vacío/null → invalid_token.
 *   - Mock fetch happy path (success).
 *   - Mock fetch fail con error-codes → categorizado correctamente.
 *   - Network error → network_error.
 *   - HTTP no-2xx → http_error.
 */

const { verifyCaptcha } = require('../src/lib/captcha');

// Backup env vars que vamos a mutar.
const origEnv = {
  NODE_ENV: process.env.NODE_ENV,
  HCAPTCHA_ENABLED: process.env.HCAPTCHA_ENABLED,
  HCAPTCHA_SECRET: process.env.HCAPTCHA_SECRET,
  HCAPTCHA_FORCE_IN_TESTS: process.env.HCAPTCHA_FORCE_IN_TESTS,
  HCAPTCHA_VERIFY_URL: process.env.HCAPTCHA_VERIFY_URL,
  HCAPTCHA_OUTAGE_BYPASS: process.env.HCAPTCHA_OUTAGE_BYPASS,
};

afterEach(() => {
  process.env.NODE_ENV = origEnv.NODE_ENV;
  process.env.HCAPTCHA_ENABLED = origEnv.HCAPTCHA_ENABLED;
  process.env.HCAPTCHA_SECRET = origEnv.HCAPTCHA_SECRET;
  process.env.HCAPTCHA_FORCE_IN_TESTS = origEnv.HCAPTCHA_FORCE_IN_TESTS;
  process.env.HCAPTCHA_VERIFY_URL = origEnv.HCAPTCHA_VERIFY_URL;
  process.env.HCAPTCHA_OUTAGE_BYPASS = origEnv.HCAPTCHA_OUTAGE_BYPASS;
  if (origEnv.HCAPTCHA_OUTAGE_BYPASS === undefined) delete process.env.HCAPTCHA_OUTAGE_BYPASS;
  jest.restoreAllMocks();
});

describe('verifyCaptcha — bypass paths', () => {
  it('NODE_ENV=test bypass por default (no llama fetch)', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.HCAPTCHA_FORCE_IN_TESTS;
    process.env.HCAPTCHA_ENABLED = 'true';
    process.env.HCAPTCHA_SECRET = 'secret';
    const fetchSpy = jest.spyOn(global, 'fetch');
    const r = await verifyCaptcha('any', '1.2.3.4');
    expect(r).toEqual({ success: true, bypassed: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // SEG-4 (auditoría pre-live 2026-06): el bypass anterior dejaba el signup
  // abierto a bots en prod si HCAPTCHA_ENABLED no estaba seteado. Ahora
  // fail-closed en NODE_ENV=production.
  it('SEG-4: HCAPTCHA_ENABLED!=true en NODE_ENV=production → config_error (fail-closed)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.HCAPTCHA_ENABLED = 'false';
    process.env.HCAPTCHA_SECRET = 'secret';
    process.env.HCAPTCHA_FORCE_IN_TESTS = '1'; // forzar que NODE_ENV=test no bypasse
    const fetchSpy = jest.spyOn(global, 'fetch');
    const r = await verifyCaptcha('any', '1.2.3.4');
    expect(r).toEqual({ success: false, error: 'config_error' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SEG-4: HCAPTCHA_ENABLED!=true en NODE_ENV=development → bypass (dev_bypass)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.HCAPTCHA_ENABLED = 'false';
    delete process.env.HCAPTCHA_FORCE_IN_TESTS;
    const fetchSpy = jest.spyOn(global, 'fetch');
    const r = await verifyCaptcha('any', '1.2.3.4');
    expect(r).toMatchObject({ success: true, bypassed: true, reason: 'dev_bypass' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SEG-4: HCAPTCHA_OUTAGE_BYPASS=true → bypass aunque NODE_ENV=production (kill-switch deliberado)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.HCAPTCHA_ENABLED = 'true';
    process.env.HCAPTCHA_SECRET = 'secret';
    process.env.HCAPTCHA_OUTAGE_BYPASS = 'true';
    process.env.HCAPTCHA_FORCE_IN_TESTS = '1';
    const fetchSpy = jest.spyOn(global, 'fetch');
    const r = await verifyCaptcha('any', '1.2.3.4');
    expect(r).toMatchObject({ success: true, bypassed: true, reason: 'outage_bypass' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('verifyCaptcha — verificación activa', () => {
  beforeEach(() => {
    // Para estos tests forzamos la verificación real (con fetch mockeado).
    process.env.NODE_ENV = 'test';
    process.env.HCAPTCHA_FORCE_IN_TESTS = '1';
    process.env.HCAPTCHA_ENABLED = 'true';
    process.env.HCAPTCHA_SECRET = 'test-secret';
  });

  it('falta SECRET con ENABLED=true → config_error (fail-closed)', async () => {
    delete process.env.HCAPTCHA_SECRET;
    const r = await verifyCaptcha('tok', '1.2.3.4');
    expect(r).toEqual({ success: false, error: 'config_error' });
  });

  it('token vacío → invalid_token sin llamar fetch', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const r = await verifyCaptcha('', '1.2.3.4');
    expect(r).toEqual({ success: false, error: 'invalid_token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('token null → invalid_token', async () => {
    const r = await verifyCaptcha(null);
    expect(r).toEqual({ success: false, error: 'invalid_token' });
  });

  it('respuesta success=true → { success: true }', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, hostname: 'staging.tecnyapp.com' }),
    });
    const r = await verifyCaptcha('tok', '1.2.3.4');
    expect(r).toEqual({ success: true });
  });

  it('respuesta success=false con expired-input-response → expired', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['expired-input-response'] }),
    });
    const r = await verifyCaptcha('tok');
    expect(r).toEqual({ success: false, error: 'expired' });
  });

  it('respuesta success=false con already-seen-response → duplicate', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['already-seen-response'] }),
    });
    const r = await verifyCaptcha('tok');
    expect(r).toEqual({ success: false, error: 'duplicate' });
  });

  it('respuesta success=false con error-codes random → invalid_token', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
    });
    const r = await verifyCaptcha('tok');
    expect(r).toEqual({ success: false, error: 'invalid_token' });
  });

  it('fetch lanza (network) → network_error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await verifyCaptcha('tok');
    expect(r).toEqual({ success: false, error: 'network_error' });
  });

  it('HTTP 500 → http_error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const r = await verifyCaptcha('tok');
    expect(r).toEqual({ success: false, error: 'http_error' });
  });

  it('body POST incluye secret + response + remoteip', async () => {
    let capturedBody;
    jest.spyOn(global, 'fetch').mockImplementationOnce(async (url, opts) => {
      capturedBody = opts.body;
      return { ok: true, json: async () => ({ success: true }) };
    });
    await verifyCaptcha('mytoken', '8.8.8.8');
    expect(capturedBody).toMatch(/secret=test-secret/);
    expect(capturedBody).toMatch(/response=mytoken/);
    expect(capturedBody).toMatch(/remoteip=8\.8\.8\.8/);
  });
});

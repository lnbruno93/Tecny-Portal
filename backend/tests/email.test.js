/**
 * Tests para lib/email.js (TANDA 2.2 Fase B — Resend integration).
 *
 * Cubren los 3 modos:
 *   1. Test mode (NODE_ENV=test) → guarda en _testQueue, no llama a Resend.
 *   2. Stub mode (NODE_ENV=production, sin RESEND_API_KEY) → loguea + retorna ok.
 *   3. Resend mode (con RESEND_API_KEY) → mockea el SDK y verifica que se
 *      pasa el payload correcto.
 *
 * Por qué mockeamos Resend en lugar de un test E2E real:
 *   - No queremos depender de la red en CI.
 *   - No queremos consumir cuota de envíos por test.
 *   - El smoke E2E real lo hacemos en staging manualmente con un signup real.
 */

const path = require('path');

describe('lib/email.js — TANDA 2.2 Fase B', () => {
  // ── Test mode ─────────────────────────────────────────────────────────
  describe('NODE_ENV=test (queue mode)', () => {
    beforeAll(() => {
      // NODE_ENV ya es 'test' en jest; reseteamos el módulo para asegurar.
      jest.resetModules();
    });

    beforeEach(() => {
      const email = require('../src/lib/email');
      email._resetTestQueue();
    });

    test('sendVerificationEmail encola el payload', async () => {
      const email = require('../src/lib/email');
      const res = await email.sendVerificationEmail({
        to:        'user@test.local',
        name:      'Lucas',
        verifyUrl: 'https://staging.ipro/verify-email?token=abc',
      });
      expect(res.ok).toBe(true);
      expect(res.deliveryId).toMatch(/^test-/);
      const q = email._getTestQueue();
      expect(q).toHaveLength(1);
      expect(q[0].type).toBe('verification');
      expect(q[0].to).toBe('user@test.local');
      expect(q[0].verifyUrl).toBe('https://staging.ipro/verify-email?token=abc');
    });

    test('sendWelcomeEmail encola el payload', async () => {
      const email = require('../src/lib/email');
      const res = await email.sendWelcomeEmail({
        to:   'user@test.local',
        name: 'Lucas',
      });
      expect(res.ok).toBe(true);
      const q = email._getTestQueue();
      expect(q).toHaveLength(1);
      expect(q[0].type).toBe('welcome');
    });

    test('sendVerificationEmail valida inputs requeridos', async () => {
      const email = require('../src/lib/email');
      await expect(email.sendVerificationEmail({})).rejects.toThrow(/requeridos/);
      await expect(email.sendVerificationEmail({ to: 'a@b.com' })).rejects.toThrow(/requeridos/);
    });

    test('sendWelcomeEmail valida `to` requerido', async () => {
      const email = require('../src/lib/email');
      await expect(email.sendWelcomeEmail({})).rejects.toThrow(/requerido/);
    });
  });

  // ── Stub mode (production sin key) ────────────────────────────────────
  // Forzamos NODE_ENV=production y borramos la API key para validar el
  // fallback a stub. Importante: jest.resetModules() entre subset de tests
  // para que el flag NODE_ENV se re-lea.
  describe('NODE_ENV=production, sin RESEND_API_KEY (stub mode)', () => {
    let originalNodeEnv;
    let originalKey;

    beforeAll(() => {
      originalNodeEnv = process.env.NODE_ENV;
      originalKey = process.env.RESEND_API_KEY;
      process.env.NODE_ENV = 'production';
      delete process.env.RESEND_API_KEY;
      jest.resetModules();
    });

    afterAll(() => {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalKey !== undefined) process.env.RESEND_API_KEY = originalKey;
      jest.resetModules();
    });

    test('sendVerificationEmail sin API key → stub mode (no rompe)', async () => {
      const email = require('../src/lib/email');
      const res = await email.sendVerificationEmail({
        to:        'user@test.local',
        name:      'Lucas',
        verifyUrl: 'https://staging.ipro/verify-email?token=abc',
      });
      expect(res.ok).toBe(true);
      expect(res.deliveryId).toMatch(/^stub-/);
    });

    test('sendWelcomeEmail sin API key → stub mode', async () => {
      const email = require('../src/lib/email');
      const res = await email.sendWelcomeEmail({
        to:   'user@test.local',
        name: 'Lucas',
      });
      expect(res.ok).toBe(true);
      expect(res.deliveryId).toMatch(/^stub-/);
    });
  });

  // ── Resend mode (con key, SDK mockeado) ───────────────────────────────
  // Mockeamos el módulo `resend` antes de require email.js, así el código
  // bajo test usa nuestro mock en lugar del SDK real.
  describe('NODE_ENV=production con RESEND_API_KEY (Resend mode)', () => {
    let originalNodeEnv;
    let mockSend;

    beforeAll(() => {
      originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      process.env.RESEND_API_KEY = 're_fake_for_test';
      jest.resetModules();
      mockSend = jest.fn(async () => ({ data: { id: 'mock-delivery-123' }, error: null }));
      jest.doMock('resend', () => ({
        Resend: jest.fn(() => ({ emails: { send: mockSend } })),
      }));
    });

    beforeEach(() => {
      mockSend.mockClear();
    });

    afterAll(() => {
      process.env.NODE_ENV = originalNodeEnv;
      delete process.env.RESEND_API_KEY;
      jest.dontMock('resend');
      jest.resetModules();
    });

    test('sendVerificationEmail llama a Resend con payload correcto', async () => {
      const email = require('../src/lib/email');
      const res = await email.sendVerificationEmail({
        to:        'lucas@example.com',
        name:      'Lucas',
        verifyUrl: 'https://staging.ipro/verify-email?token=abc123',
      });
      expect(res.ok).toBe(true);
      expect(res.deliveryId).toBe('mock-delivery-123');
      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call.to).toBe('lucas@example.com');
      expect(call.subject).toMatch(/Verific/);
      expect(call.html).toContain('https://staging.ipro/verify-email?token=abc123');
      expect(call.html).toContain('Hola Lucas');
      expect(call.text).toContain('https://staging.ipro/verify-email?token=abc123');
    });

    test('sendVerificationEmail propaga error de Resend sin throw', async () => {
      mockSend.mockImplementationOnce(async () => ({
        data: null,
        error: { message: 'Invalid API key', name: 'validation_error' },
      }));
      const email = require('../src/lib/email');
      const res = await email.sendVerificationEmail({
        to:        'lucas@example.com',
        name:      'Lucas',
        verifyUrl: 'https://staging.ipro/verify-email?token=abc',
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('Invalid API key');
    });

    test('sendVerificationEmail captura excepciones de red', async () => {
      mockSend.mockImplementationOnce(async () => {
        throw new Error('ECONNREFUSED');
      });
      const email = require('../src/lib/email');
      const res = await email.sendVerificationEmail({
        to:        'lucas@example.com',
        name:      'Lucas',
        verifyUrl: 'https://staging.ipro/verify-email?token=abc',
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('ECONNREFUSED');
    });

    test('sendWelcomeEmail llama a Resend con subject correcto', async () => {
      const email = require('../src/lib/email');
      await email.sendWelcomeEmail({ to: 'lucas@example.com', name: 'Lucas' });
      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call.subject).toMatch(/Bienvenido/);
      expect(call.html).toContain('Hola Lucas');
    });

    test('HTML escapea caracteres especiales en el nombre (XSS hardening)', async () => {
      const email = require('../src/lib/email');
      await email.sendVerificationEmail({
        to:        'a@b.com',
        name:      '<script>alert(1)</script>',
        verifyUrl: 'https://staging.ipro/verify-email?token=x',
      });
      const html = mockSend.mock.calls[0][0].html;
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});

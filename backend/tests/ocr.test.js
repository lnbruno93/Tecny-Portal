/**
 * Tests del endpoint /api/ocr — primero test del módulo en producción.
 *
 * Mock de `@anthropic-ai/sdk`: no queremos llamar a Anthropic en CI (costo +
 * lentitud + dependencia de API key). Mockeamos antes del require de `app`.
 */

// Mock GLOBAL del SDK de Anthropic. Tiene que ir ANTES de cualquier require
// que cargue routes/ocr.js (que importa el SDK al top-level).
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  // El SDK exporta como default + nombrado en distintas versiones; soportamos
  // ambas formas devolviendo una clase con `messages.create`.
  return jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } }));
});

const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

// Imagen base64 mínima (1×1 PNG transparente)
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeAll(async () => {
  // Setear la API key para tests — el endpoint chequea presencia en cada request,
  // y el SDK está mockeado, así que el valor no importa.
  if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'test-key';
  pool = await setupTestDb();
  const r = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  token = r.body.token;
});
afterAll(async () => { await teardownTestDb(pool); });

beforeEach(() => {
  mockCreate.mockReset();
});

describe('POST /api/ocr', () => {
  it('extrae el monto cuando Anthropic devuelve un número limpio', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: '15000' }] });
    const res = await request(app).post('/api/ocr').set(auth())
      .send({ imageData: TINY_PNG, mediaType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.monto).toBe('15000');
  });

  it('devuelve monto null cuando Anthropic dice "null"', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: 'null' }] });
    const res = await request(app).post('/api/ocr').set(auth())
      .send({ imageData: TINY_PNG, mediaType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.monto).toBeNull();
  });

  it('sanitiza la respuesta: deja solo dígitos y punto', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: '$ 1.234,56 ARS' }] });
    const res = await request(app).post('/api/ocr').set(auth())
      .send({ imageData: TINY_PNG, mediaType: 'image/png' });
    expect(res.status).toBe(200);
    // Solo dígitos y puntos: "1.234.56" (el regex elimina la coma y el símbolo)
    expect(res.body.monto).toMatch(/^[\d.]+$/);
  });

  it('soporta application/pdf como mediaType (bloque document)', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: '500' }] });
    const res = await request(app).post('/api/ocr').set(auth())
      .send({ imageData: TINY_PNG, mediaType: 'application/pdf' });
    expect(res.status).toBe(200);
    // Verificamos que el bloque enviado a Anthropic fue 'document', no 'image'.
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content[0].type).toBe('document');
  });

  it('soporta el prefijo "data:..." en imageData (se strippea)', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: '100' }] });
    const dataUrl = 'data:image/png;base64,' + TINY_PNG;
    const res = await request(app).post('/api/ocr').set(auth())
      .send({ imageData: dataUrl, mediaType: 'image/png' });
    expect(res.status).toBe(200);
    // El base64 pasado a Anthropic no debe incluir el prefijo
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content[0].source.data).toBe(TINY_PNG);
    expect(call.messages[0].content[0].source.data.startsWith('data:')).toBe(false);
  });

  it('si Anthropic tira un error → 502 con mensaje genérico', async () => {
    mockCreate.mockRejectedValue(new Error('Anthropic API down'));
    const res = await request(app).post('/api/ocr').set(auth())
      .send({ imageData: TINY_PNG, mediaType: 'image/png' });
    expect(res.status).toBe(502);
    // El mensaje al cliente NO debe filtrar el error crudo del proveedor.
    expect(res.body.error).not.toMatch(/Anthropic/i);
  });

  it('rechaza mediaType no soportado → 400 (Zod)', async () => {
    const res = await request(app).post('/api/ocr').set(auth())
      .send({ imageData: TINY_PNG, mediaType: 'image/svg+xml' });
    expect(res.status).toBe(400);
  });

  it('rechaza sin imageData → 400', async () => {
    const res = await request(app).post('/api/ocr').set(auth())
      .send({ mediaType: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('rechaza sin auth → 401', async () => {
    const res = await request(app).post('/api/ocr').send({ imageData: TINY_PNG, mediaType: 'image/png' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/ocr — configuración', () => {
  it('si ANTHROPIC_API_KEY no está → 503', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await request(app).post('/api/ocr').set(auth())
        .send({ imageData: TINY_PNG, mediaType: 'image/png' });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/configurado/i);
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

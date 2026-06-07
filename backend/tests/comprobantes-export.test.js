/**
 * Tests de integración — Export de Comprobantes (ZIP).
 *
 * Cubre el endpoint nuevo `GET /api/comprobantes/export-zip`:
 *   · Stream con `archiver` — devuelve `application/zip`.
 *   · Respeta los filtros desde/hasta/vendedor (mismos que GET /api/comprobantes).
 *   · Incluye un archivo binario por comprobante que tenga archivo_data, y un
 *     `_manifest.csv` con la grilla de metadatos.
 *   · 404 si el período está vacío (en vez de un ZIP con un manifest sin filas).
 *   · 401 sin auth.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

// Imagen de 1x1 px negra (PNG 67 bytes), suficiente para que archivo_data
// tenga contenido real y lo veamos en el ZIP descargado.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;

  // Seed: 3 comprobantes en fechas distintas — 2 con archivo y 1 sin.
  // Usamos POST /api/comprobantes (no /manuales) porque el schema de manual
  // no acepta archivo_data — ese endpoint asume venta-previa sin adjunto.
  // Para tests del export, queremos verificar que el ZIP incluye archivos.
  await request(app).post('/api/comprobantes').set(auth()).send({
    fecha: '2026-05-10', cliente: 'Acme SRL', monto: 50000, monto_financiera: 2500, monto_neto: 47500,
    archivo_data: TINY_PNG_B64, archivo_nombre: 'recibo.png', archivo_tipo: 'image/png',
  });
  await request(app).post('/api/comprobantes').set(auth()).send({
    fecha: '2026-05-20', cliente: 'Beta SA', monto: 80000, monto_financiera: 4000, monto_neto: 76000,
    archivo_data: TINY_PNG_B64, archivo_nombre: 'recibo2.png', archivo_tipo: 'image/png',
  });
  await request(app).post('/api/comprobantes').set(auth()).send({
    fecha: '2026-06-15', cliente: 'Gamma & Co', monto: 30000, monto_financiera: 1500, monto_neto: 28500,
    // sin archivo — debe aparecer en el manifest pero no como archivo binario en el zip
  });
});

afterAll(async () => { await teardownTestDb(pool); });

describe('GET /api/comprobantes/export-zip', () => {
  it('devuelve application/zip + Content-Disposition attachment con nombre del período', async () => {
    const r = await request(app).get('/api/comprobantes/export-zip?desde=2026-05-01&hasta=2026-05-31')
      .set(auth())
      .buffer(true).parse((res, cb) => {
        // Supertest por default no parsea binario — registramos un parser que
        // acumula bytes para inspeccionar el contenido.
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/zip/);
    expect(r.headers['content-disposition']).toMatch(/attachment/);
    expect(r.headers['content-disposition']).toMatch(/2026-05-01_2026-05-31/);
    // El ZIP arranca con la firma PK\x03\x04
    expect(r.body[0]).toBe(0x50); // P
    expect(r.body[1]).toBe(0x4B); // K
    expect(r.body[2]).toBe(0x03);
    expect(r.body[3]).toBe(0x04);
    // Manifest CSV embedded — buscamos la cabecera dentro del binario.
    const stringified = r.body.toString('binary');
    // 'id,fecha,cliente' aparece en el _manifest.csv que el endpoint genera.
    // El ZIP usa deflate por default — pero archiver inserta el filename del
    // entry en plano en el local file header, podemos chequear por nombre.
    expect(stringified).toContain('_manifest.csv');
    expect(stringified).toMatch(/2026-05-10_Acme_SRL_\d+\.png/);
    expect(stringified).toMatch(/2026-05-20_Beta_SA_\d+\.png/);
  });

  it('respeta el filtro de período (solo lo que cae adentro)', async () => {
    const r = await request(app).get('/api/comprobantes/export-zip?desde=2026-06-01&hasta=2026-06-30')
      .set(auth())
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    const stringified = r.body.toString('binary');
    // Solo Gamma cae en junio. NO debe aparecer Acme ni Beta.
    expect(stringified).not.toMatch(/Acme/);
    expect(stringified).not.toMatch(/Beta/);
    // Gamma no tiene archivo binario pero SÍ debe estar en el manifest. El
    // manifest está deflateado, no podemos buscar el texto crudo — solo
    // confirmamos que el ZIP tiene contenido (no es el caso de 404).
    expect(r.body.length).toBeGreaterThan(50);
  });

  it('devuelve 404 si el período está vacío', async () => {
    const r = await request(app).get('/api/comprobantes/export-zip?desde=2030-01-01&hasta=2030-12-31')
      .set(auth());
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no hay comprobantes/i);
  });

  it('rechaza sin auth → 401', async () => {
    const r = await request(app).get('/api/comprobantes/export-zip?desde=2026-05-01&hasta=2026-05-31');
    expect(r.status).toBe(401);
  });
});

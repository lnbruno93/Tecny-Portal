/**
 * Tests de integración — Comprobante de venta retail por email (#475).
 *
 * Cubre:
 *   - PDF helper: generación, magic bytes, contenido básico
 *   - POST /api/ventas con enviar_comprobante_email + cliente_email → envío
 *     fire-and-forget post-COMMIT + row en venta_emails_enviados
 *   - POST /api/ventas/:id/enviar-comprobante (alta manual)
 *   - POST /api/ventas/:id/enviar-comprobante (reenvío encadenado)
 *   - GET /api/ventas/:id/emails-enviados (historial)
 *   - Email inválido → 400
 *   - Venta no existe → 404 (cross-tenant cubierto por RLS)
 *   - UPSERT contactos.email si no tenía email previo
 */

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/database');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const emailLib = require('../src/lib/email');
const { generarComprobantePdf } = require('../src/lib/comprobantePdf');

let pool, token, catBase, prodBase;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy = new Date().toISOString().split('T')[0];

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth())
    .send({ nombre: 'Base Comp Email' });
  catBase = cat.body.id;
  const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
    tipo_carga: 'unitario', clase: 'celular', categoria_id: catBase,
    nombre: 'iPhone 15 Comp Email', costo: 800, precio_venta: 950, cantidad: 1,
  });
  prodBase = prod.body;
});

afterAll(async () => { await teardownTestDb(pool); });

// Helper para crear venta de test simple.
async function crearVentaRetail(over = {}) {
  // Necesitamos un producto fresco para cada venta (descontamos stock).
  const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
    tipo_carga: 'unitario', clase: 'celular', categoria_id: catBase,
    nombre: `Test ${Date.now()}-${Math.random()}`,
    costo: 800, precio_venta: 950, cantidad: 1,
  });
  const payload = {
    fecha: hoy,
    cliente_nombre: 'Juan Test',
    estado: 'acreditado',
    items: [{ producto_id: prod.body.id, descripcion: prod.body.nombre, cantidad: 1, precio_vendido: 950, costo: 800, moneda: 'USD' }],
    pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 950, moneda: 'USD' }],
    ...over,
  };
  const res = await request(app).post('/api/ventas').set(auth()).send(payload);
  expect(res.status).toBe(201);
  return res.body;
}

beforeEach(() => {
  emailLib._resetTestQueue();
});

describe('lib/comprobantePdf', () => {
  it('genera PDF con magic bytes válidos y tamaño razonable', async () => {
    const buf = await generarComprobantePdf({
      venta: {
        id: 1, order_id: 'ORD-26-test01', fecha: hoy,
        total_usd: 950, tc_venta: null, cliente_nombre: 'Test Cliente',
        items: [{ descripcion: 'iPhone 15', cantidad: 1, precio_vendido: 950, moneda: 'USD' }],
        pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 950, moneda: 'USD' }],
      },
      tenant: { id: 1, nombre: 'Test Store', pais: 'AR' },
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    // %PDF magic bytes
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    // Razonable: entre 1KB y 100KB para un comprobante simple.
    expect(buf.length).toBeGreaterThan(1024);
    expect(buf.length).toBeLessThan(100_000);
  });

  it('genera PDF con footer custom del tenant inyectado', async () => {
    // No verificamos el texto en el buffer porque pdfkit usa font encoding
    // propio (PDF Type 1) + posible zlib compression que reescribe los
    // caracteres — no quedan como string literal en latin1/utf8 del raw
    // buffer (testeado: ni con `compress:false` aparece "MI FOOTER" en
    // grep directo del Buffer). En su lugar verificamos via side-effect
    // observable: dos PDFs idénticos salvo footer custom deben diferir
    // en tamaño (el con footer es más grande porque escribe N chars
    // adicionales + un nuevo content stream entry).
    const ventaArgs = {
      id: 2, order_id: 'ORD-26-test02', fecha: hoy, total_usd: 100,
      items: [{ descripcion: 'Item', cantidad: 1, precio_vendido: 100, moneda: 'USD' }],
      pagos: [],
    };
    const sinFooter = await generarComprobantePdf({
      venta: ventaArgs,
      tenant: { id: 1, nombre: 'Test', pais: 'AR' },
    });
    // Footer GIGANTE — pdfkit + zlib compresión + font encoding hace que
    // 123 chars solo agreguen ~45 bytes al PDF (medido en CI). Para
    // garantizar diff visible >50 bytes, usar payload mucho mayor.
    const conFooterLargo = await generarComprobantePdf({
      venta: ventaArgs,
      tenant: { id: 1, nombre: 'Test', pais: 'AR',
        comprobante_email_footer: 'X'.repeat(1000) },
    });
    // El PDF con footer de 1000 chars debe ser claramente más grande.
    // Threshold 30 bytes — con 1000 chars típicamente se ven ~100+ bytes
    // de diferencia (zlib + font encoding lo comprime bastante pero no
    // a cero).
    expect(conFooterLargo.length).toBeGreaterThan(sinFooter.length + 30);
  });
});

describe('POST /api/ventas con enviar_comprobante_email', () => {
  it('alta venta con enviar=true + email válido → encola email + row en historial', async () => {
    const venta = await crearVentaRetail({
      enviar_comprobante_email: true,
      cliente_email: 'cliente@test.com',
    });

    // setImmediate dispatch: esperamos un tick para que corra.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 50));

    const queue = emailLib._getTestQueue();
    const sent = queue.find(p => p.type === 'comprobante_venta');
    expect(sent).toBeTruthy();
    expect(sent.to).toBe('cliente@test.com');
    expect(sent.pdfSize).toBeGreaterThan(1024);

    // Row en venta_emails_enviados.
    const { rows } = await pool.query(
      'SELECT * FROM venta_emails_enviados WHERE venta_id = $1',
      [venta.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email_to).toBe('cliente@test.com');
    expect(rows[0].status).toBe('sent');
    expect(rows[0].reenvio_de_id).toBeNull();
  });

  it('alta venta sin enviar_comprobante_email → NO encola email', async () => {
    await crearVentaRetail({ cliente_email: 'sin-check@test.com' });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 50));
    const queue = emailLib._getTestQueue();
    expect(queue.find(p => p.type === 'comprobante_venta')).toBeFalsy();
  });

  it('alta venta cancelada con enviar=true → skip silencioso', async () => {
    // estado='cancelado' = no descuenta stock, no envía comprobante.
    const venta = await crearVentaRetail({
      estado: 'cancelado',
      enviar_comprobante_email: true,
      cliente_email: 'cancelado@test.com',
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 50));
    expect(emailLib._getTestQueue().find(p => p.type === 'comprobante_venta')).toBeFalsy();
    // No persiste row.
    const { rows } = await pool.query(
      'SELECT 1 FROM venta_emails_enviados WHERE venta_id = $1',
      [venta.id]
    );
    expect(rows).toHaveLength(0);
  });

  it('email inválido en alta → 400 (Zod rebota)', async () => {
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario', clase: 'celular', categoria_id: catBase,
      nombre: `EmailInvalid ${Date.now()}`, costo: 800, precio_venta: 950, cantidad: 1,
    });
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      items: [{ producto_id: prod.body.id, descripcion: 'X', cantidad: 1, precio_vendido: 950, costo: 800, moneda: 'USD' }],
      enviar_comprobante_email: true,
      cliente_email: 'no-es-un-email',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/ventas/:id/enviar-comprobante (envío manual / reenvío)', () => {
  it('reenvío sobre venta existente → nuevo row con reenvio_de_id apuntando al primero', async () => {
    const venta = await crearVentaRetail({
      enviar_comprobante_email: true,
      cliente_email: 'primero@test.com',
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 50));

    // Primer row (del alta) ya está. Hacemos reenvío.
    const res = await request(app)
      .post(`/api/ventas/${venta.id}/enviar-comprobante`)
      .set(auth())
      .send({ email: 'reenvio@test.com' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.email_to).toBe('reenvio@test.com');

    const { rows } = await pool.query(
      'SELECT * FROM venta_emails_enviados WHERE venta_id = $1 ORDER BY sent_at ASC',
      [venta.id]
    );
    expect(rows).toHaveLength(2);
    // Primer envío: reenvio_de_id = NULL
    expect(rows[0].reenvio_de_id).toBeNull();
    expect(rows[0].email_to).toBe('primero@test.com');
    // Segundo: reenvio_de_id apunta al primero
    expect(rows[1].reenvio_de_id).toBe(rows[0].id);
    expect(rows[1].email_to).toBe('reenvio@test.com');
  });

  it('venta inexistente → 404', async () => {
    const res = await request(app)
      .post('/api/ventas/99999999/enviar-comprobante')
      .set(auth())
      .send({ email: 'x@test.com' });
    expect(res.status).toBe(404);
  });

  it('email inválido → 400', async () => {
    const venta = await crearVentaRetail();
    const res = await request(app)
      .post(`/api/ventas/${venta.id}/enviar-comprobante`)
      .set(auth())
      .send({ email: 'invalid-email' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/ventas/:id/emails-enviados', () => {
  it('lista historial ordenado por sent_at DESC', async () => {
    const venta = await crearVentaRetail({
      enviar_comprobante_email: true,
      cliente_email: 'historial@test.com',
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 50));

    // Hacer un reenvío para tener 2 entries.
    await request(app)
      .post(`/api/ventas/${venta.id}/enviar-comprobante`)
      .set(auth())
      .send({ email: 'reenv2@test.com' });

    const res = await request(app)
      .get(`/api/ventas/${venta.id}/emails-enviados`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.emails)).toBe(true);
    expect(res.body.emails.length).toBeGreaterThanOrEqual(2);
    // El más reciente primero — el reenvío.
    expect(res.body.emails[0].email_to).toBe('reenv2@test.com');
  });

  it('venta sin envíos → emails: []', async () => {
    const venta = await crearVentaRetail();
    const res = await request(app)
      .get(`/api/ventas/${venta.id}/emails-enviados`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.emails).toEqual([]);
  });

  it('venta inexistente → 404', async () => {
    const res = await request(app)
      .get('/api/ventas/99999999/emails-enviados')
      .set(auth());
    expect(res.status).toBe(404);
  });
});

describe('UPSERT contactos.email post-envío exitoso', () => {
  it('contacto sin email previo + envío OK → contacto queda con el email del envío', async () => {
    // Crear contacto sin email.
    const cli = await request(app).post('/api/contactos').set(auth()).send({
      nombre: 'Cliente Sin Email', tipo: 'cliente', telefono: '11111',
    });
    expect(cli.status).toBeLessThan(300);
    const contactoId = cli.body.id;

    // Venta vinculada a ese contacto + envío.
    const venta = await crearVentaRetail({
      cliente_id: contactoId,
      enviar_comprobante_email: true,
      cliente_email: 'nuevo@test.com',
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 100));

    // Verificar venta_emails_enviados está OK (sanity).
    const { rows: emails } = await pool.query(
      'SELECT * FROM venta_emails_enviados WHERE venta_id = $1',
      [venta.id]
    );
    expect(emails).toHaveLength(1);
    expect(emails[0].status).toBe('sent');

    // Ahora verificar que contactos.email se UPSERTeo.
    const { rows: contactoAfter } = await pool.query(
      'SELECT email FROM contactos WHERE id = $1',
      [contactoId]
    );
    expect(contactoAfter[0].email).toBe('nuevo@test.com');
  });

  it('contacto con email previo NO se sobrescribe', async () => {
    const cli = await request(app).post('/api/contactos').set(auth()).send({
      nombre: 'Cliente Con Email', tipo: 'cliente',
      email: 'previo@test.com',
    });
    const contactoId = cli.body.id;

    const venta = await crearVentaRetail({
      cliente_id: contactoId,
      enviar_comprobante_email: true,
      cliente_email: 'nuevo-diferente@test.com',
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 100));

    // El email viejo del contacto debe preservarse (no pisamos lo que cargó
    // el operador a mano antes).
    const { rows } = await pool.query(
      'SELECT email FROM contactos WHERE id = $1',
      [contactoId]
    );
    expect(rows[0].email).toBe('previo@test.com');

    // Pero el envío fue al email del POST (no al del contacto) — el operador
    // mandó explícitamente a "nuevo-diferente@test.com".
    const { rows: emails } = await pool.query(
      'SELECT email_to FROM venta_emails_enviados WHERE venta_id = $1',
      [venta.id]
    );
    expect(emails[0].email_to).toBe('nuevo-diferente@test.com');
  });
});

// Marcar variable como usada para evitar warning de linter — prodBase se usa
// implicit en helpers (catBase) pero queremos mantenerlo legible.
void prodBase;
void db;

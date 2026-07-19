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
const { generarComprobantePdf, sumPagosUsd, sumCanjesUsd } = require('../src/lib/comprobantePdf');

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
    tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBase,
    nombre: 'iPhone 15 Comp Email', costo: 800, precio_venta: 950, cantidad: 1,
  });
  prodBase = prod.body;
});

afterAll(async () => { await teardownTestDb(pool); });

// 2026-07-19 fix flake: los tests originales usaban `setImmediate + setTimeout(50)`
// para esperar que el dispatch async del email persista la row en DB. En CI con
// carga variable, 50ms no siempre alcanza y el SELECT posterior encuentra 0
// filas. Este helper polling reemplaza el sleep fijo con un chequeo cada 50ms
// hasta 5s — cuando el INSERT completa rápido (happy path local), sale al
// primer chequeo (~5ms overhead). Cuando el CI está saturado, extiende la
// espera hasta que la row aparezca o hasta el timeout.
//
// IMPORTANTE: usar SOLO para tests que esperan APARICIÓN. Para tests que
// verifican AUSENCIA (que NO se encoló, que NO hay row), mantener sleep fijo —
// el polling no puede probar un negativo.
async function waitForRows(query, params, minCount = 1, { maxMs = 5000, stepMs = 50 } = {}) {
  const start = Date.now();
  let rows;
  while (Date.now() - start < maxMs) {
    ({ rows } = await pool.query(query, params));
    if (rows.length >= minCount) return rows;
    await new Promise(r => setTimeout(r, stepMs));
  }
  // Timeout: devolver la última lectura para que el expect() del caller de
  // el mensaje de error real (Expected length: N, Received length: <last>).
  return rows || [];
}

async function waitForQueueItem(predicate, { maxMs = 5000, stepMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const item = emailLib._getTestQueue().find(predicate);
    if (item) return item;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return undefined;
}

// Helper para crear venta de test simple.
async function crearVentaRetail(over = {}) {
  // Necesitamos un producto fresco para cada venta (descontamos stock).
  const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
    tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBase,
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

  // 2026-07-19 (bug Tek Haus): canjes en el PDF backend. Frontend ya los tenía
  // (task #140), pero backend no → los comprobantes por email ocultaban el
  // equipo entregado + subestimaban total_cobrado.
  describe('canjes en el comprobante', () => {
    describe('sumPagosUsd', () => {
      it('suma pagos en USD directo', () => {
        expect(sumPagosUsd([{ monto: 500, moneda: 'USD' }, { monto: 200, moneda: 'USD' }])).toBe(700);
      });
      it('convierte ARS a USD con tc_venta', () => {
        expect(sumPagosUsd([{ monto: 100000, moneda: 'ARS' }], 1000)).toBe(100);
      });
      it('convierte UYU a USD con tc_venta', () => {
        expect(sumPagosUsd([{ monto: 4000, moneda: 'UYU' }], 40)).toBe(100);
      });
      it('prefiere monto_usd pre-computado si viene del backend', () => {
        expect(sumPagosUsd([{ monto: 100000, moneda: 'ARS', monto_usd: 95 }], 1000)).toBe(95);
      });
      it('array vacío o inválido → 0', () => {
        expect(sumPagosUsd([])).toBe(0);
        expect(sumPagosUsd(null)).toBe(0);
        expect(sumPagosUsd(undefined)).toBe(0);
      });
      it('moneda distinta sin tc_venta → toma como USD (defensive)', () => {
        // Sin tc_venta y en ARS: no puede convertir. Comportamiento matcheado
        // con el frontend — asume USD para no romper el cálculo.
        expect(sumPagosUsd([{ monto: 100, moneda: 'ARS' }])).toBe(100);
      });
    });

    describe('sumCanjesUsd', () => {
      it('suma canjes en USD directo', () => {
        expect(sumCanjesUsd([{ valor_toma: 400, moneda: 'USD' }])).toBe(400);
      });
      it('convierte ARS a USD con tc_venta', () => {
        expect(sumCanjesUsd([{ valor_toma: 400000, moneda: 'ARS' }], 1000)).toBe(400);
      });
      it('convierte UYU a USD con tc_venta', () => {
        expect(sumCanjesUsd([{ valor_toma: 16000, moneda: 'UYU' }], 40)).toBe(400);
      });
      it('array vacío o inválido → 0', () => {
        expect(sumCanjesUsd([])).toBe(0);
        expect(sumCanjesUsd(null)).toBe(0);
      });
      it('canje con valor_toma=0 → 0 (no revienta)', () => {
        expect(sumCanjesUsd([{ valor_toma: 0, moneda: 'USD' }])).toBe(0);
      });
    });

    // Nota sobre metodología: pdfkit usa Type 1 font encoding + text streams
    // que NO conservan el texto como literal en el buffer (mismo motivo que el
    // test "genera PDF con footer custom del tenant inyectado" arriba usa
    // diff de tamaño en vez de grep). Para tests de contenido usamos el mismo
    // approach: comparamos el tamaño del PDF con canje vs sin canje. Si el
    // renderizado ejecuta las líneas de canje, escribe más text streams →
    // buffer más grande.
    const ventaBase = {
      id: 42, order_id: 'ORD-26-test', fecha: hoy,
      total_usd: 950, tc_venta: null, cliente_nombre: 'Tek Haus Cliente',
      items: [{ descripcion: 'iPhone 15', cantidad: 1, precio_vendido: 950, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 500, moneda: 'USD', monto_usd: 500 }],
    };
    const tenantBase = { id: 1, nombre: 'Test Store', pais: 'AR' };

    it('PDF con canje pesa notablemente más que sin canje (sección + total cobrado)', async () => {
      const sinCanje = await generarComprobantePdf({
        venta: { ...ventaBase,
          pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 950, moneda: 'USD', monto_usd: 950 }],
          canjes: [],
        },
        tenant: tenantBase,
        _compress: false,
      });
      const conCanje = await generarComprobantePdf({
        venta: { ...ventaBase,
          canjes: [{
            descripcion: 'iPhone 13 Pro',
            imei: '351234567890123',
            gb: 256, color: 'Sierra Blue', bateria: 87,
            valor_toma: 450, moneda: 'USD',
          }],
        },
        tenant: tenantBase,
        _compress: false,
      });
      // Con canje agregamos: título de sección, línea del canje con precio,
      // sub-línea con IMEI + GB + color + batería, línea "Total cobrado",
      // (dif = 0 en este fixture — Total cobrado = 950). Threshold conservador
      // 150 bytes — el canje real agrega ~200-400 bytes de text streams.
      expect(conCanje.length).toBeGreaterThan(sinCanje.length + 150);
    });

    it('PDF con canje ARS convertido a USD por tc_venta: total cobrado incluye la conversión', async () => {
      // Venta USD 500. Pago USD 200 + canje ARS 300000 @ tc 1000 = USD 300.
      // Total cobrado = 500 → dif = 0 → NO se agrega línea "Diferencia".
      const conCanjeArs = await generarComprobantePdf({
        venta: {
          ...ventaBase,
          total_usd: 500, tc_venta: 1000,
          items: [{ descripcion: 'iPad', cantidad: 1, precio_vendido: 500, moneda: 'USD' }],
          pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 200, moneda: 'USD', monto_usd: 200 }],
          canjes: [{ descripcion: 'iPad viejo', valor_toma: 300000, moneda: 'ARS' }],
        },
        tenant: tenantBase,
        _compress: false,
      });
      expect(Buffer.isBuffer(conCanjeArs)).toBe(true);
      expect(conCanjeArs.slice(0, 5).toString()).toBe('%PDF-');
      // Verificación del cálculo por vía del helper puro (los tests
      // sumPagosUsd/sumCanjesUsd ya lo cubren, este es el smoke E2E).
      const totalCobrado = sumPagosUsd([{ monto: 200, moneda: 'USD', monto_usd: 200 }], 1000)
                         + sumCanjesUsd([{ valor_toma: 300000, moneda: 'ARS' }], 1000);
      expect(totalCobrado).toBe(500);
    });

    it('PDF con canje que genera diferencia positiva: aparece línea "Diferencia (a favor)"', async () => {
      // Total venta USD 950, pago 500 + canje 500 = 1000 → dif +50 a favor.
      // Comparamos con el mismo PDF sin la diferencia (pago exacto): el que
      // tiene diferencia debe pesar más porque agrega una línea extra.
      const sinDif = await generarComprobantePdf({
        venta: { ...ventaBase,
          canjes: [{ descripcion: 'iPhone 12', valor_toma: 450, moneda: 'USD' }],
        },
        tenant: tenantBase,
        _compress: false,
      });
      const conDif = await generarComprobantePdf({
        venta: { ...ventaBase,
          canjes: [{ descripcion: 'iPhone 12', valor_toma: 500, moneda: 'USD' }],
        },
        tenant: tenantBase,
        _compress: false,
      });
      // 30 bytes threshold: la línea "Diferencia (a favor): USD 50,00" agrega
      // ~40-80 bytes al PDF.
      expect(conDif.length).toBeGreaterThan(sinDif.length + 30);
    });
  });
});

describe('POST /api/ventas con enviar_comprobante_email', () => {
  it('alta venta con enviar=true + email válido → encola email + row en historial', async () => {
    const venta = await crearVentaRetail({
      enviar_comprobante_email: true,
      cliente_email: 'cliente@test.com',
    });

    // Esperamos que el dispatch async encole el email + persista la row.
    // Polling en vez de sleep fijo evita flakes en CI cuando el INSERT
    // tarda >50ms bajo carga.
    const sent = await waitForQueueItem(p => p.type === 'comprobante_venta');
    expect(sent).toBeTruthy();
    expect(sent.to).toBe('cliente@test.com');
    expect(sent.pdfSize).toBeGreaterThan(1024);

    // Row en venta_emails_enviados.
    const rows = await waitForRows(
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
      tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBase,
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
  it('reenvío sobre venta existente → 202 pending + UPDATE async a sent + reenvio_de_id apunta al primero', async () => {
    // Auditoría 2026-06-30 E-03: el endpoint ahora responde 202 con
    // status='pending' y el envío real corre vía setImmediate. La row aparece
    // primero en 'pending' y se actualiza a 'sent'/'failed' después.
    const venta = await crearVentaRetail({
      enviar_comprobante_email: true,
      cliente_email: 'primero@test.com',
    });
    // Esperamos a que el primer envío (del alta) persista antes del reenvío.
    await waitForRows(
      'SELECT id FROM venta_emails_enviados WHERE venta_id = $1',
      [venta.id]
    );

    // Primer row (del alta) ya está. Hacemos reenvío.
    const res = await request(app)
      .post(`/api/ventas/${venta.id}/enviar-comprobante`)
      .set(auth())
      .send({ email: 'reenvio@test.com' });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('pending');
    expect(res.body.email_to).toBe('reenvio@test.com');
    expect(typeof res.body.sent_id).toBe('number');

    // Inmediatamente después del 202, la row ya existe en 'pending'.
    const { rows: pendingRows } = await pool.query(
      'SELECT status, email_to FROM venta_emails_enviados WHERE id = $1',
      [res.body.sent_id]
    );
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0].email_to).toBe('reenvio@test.com');
    // Status puede ser 'pending' o 'sent' dependiendo del timing del setImmediate.
    expect(['pending', 'sent']).toContain(pendingRows[0].status);

    // Esperamos a que el setImmediate del reenvío persista la 2da row + haga
    // el UPDATE de 'pending' → 'sent'.
    const rows = await waitForRows(
      `SELECT * FROM venta_emails_enviados WHERE venta_id = $1
        AND status = 'sent' ORDER BY sent_at ASC`,
      [venta.id],
      2
    );
    expect(rows).toHaveLength(2);
    // Primer envío (del alta): reenvio_de_id = NULL
    expect(rows[0].reenvio_de_id).toBeNull();
    expect(rows[0].email_to).toBe('primero@test.com');
    // Segundo (reenvío): reenvio_de_id apunta al primero, status terminal
    expect(rows[1].reenvio_de_id).toBe(rows[0].id);
    expect(rows[1].email_to).toBe('reenvio@test.com');
    expect(rows[1].status).toBe('sent');
  });

  it('reenvío responde 202 con sent_id inmediato + row pending visible (E-03)', async () => {
    // Test focal del nuevo flujo: el endpoint NO espera al envío.
    const venta = await crearVentaRetail({ cliente_email: 'x@x.com' });
    const t0 = Date.now();
    const res = await request(app)
      .post(`/api/ventas/${venta.id}/enviar-comprobante`)
      .set(auth())
      .send({ email: 'rapido@test.com' });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.sent_id).toBeTruthy();
    // El response NO debe esperar al PDF + Resend (típicamente 200-1500ms).
    // Threshold generoso (1s) para tolerar CI lento — local da <100ms.
    expect(elapsed).toBeLessThan(1000);

    // La row YA está creada con status pending o sent (depende si el
    // setImmediate alcanzó a correr antes de esta query — ambos son válidos).
    const { rows } = await pool.query(
      'SELECT status FROM venta_emails_enviados WHERE id = $1',
      [res.body.sent_id]
    );
    expect(rows).toHaveLength(1);
    expect(['pending', 'sent', 'failed']).toContain(rows[0].status);
  });

  it('reenvío sobre venta cancelada → 400 sin insertar row', async () => {
    const venta = await crearVentaRetail({ estado: 'cancelado' });
    const res = await request(app)
      .post(`/api/ventas/${venta.id}/enviar-comprobante`)
      .set(auth())
      .send({ email: 'cancelado@test.com' });

    expect(res.status).toBe(400);
    const { rows } = await pool.query(
      'SELECT 1 FROM venta_emails_enviados WHERE venta_id = $1',
      [venta.id]
    );
    expect(rows).toHaveLength(0);
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
    // Esperamos que el primer envío persista antes del reenvío.
    await waitForRows(
      'SELECT id FROM venta_emails_enviados WHERE venta_id = $1',
      [venta.id]
    );

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
    // Esperar row del envío en status 'sent' (el UPSERT contactos corre
    // en el mismo callback, después del INSERT venta_emails_enviados).
    const emails = await waitForRows(
      `SELECT * FROM venta_emails_enviados WHERE venta_id = $1 AND status = 'sent'`,
      [venta.id]
    );
    expect(emails).toHaveLength(1);
    expect(emails[0].status).toBe('sent');

    // Ahora verificar que contactos.email se UPSERTeo.
    // Polling por si el UPDATE de contactos corre unos ms después del INSERT
    // de venta_emails_enviados (mismo callback pero query separada).
    const contactoAfter = await waitForRows(
      `SELECT email FROM contactos WHERE id = $1 AND email = 'nuevo@test.com'`,
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
    // Esperar que el envío haya persistido (después de esto, el UPSERT
    // contactos ya corrió o corrió su no-op silencioso).
    const emails = await waitForRows(
      `SELECT email_to FROM venta_emails_enviados WHERE venta_id = $1 AND status = 'sent'`,
      [venta.id]
    );
    expect(emails[0].email_to).toBe('nuevo-diferente@test.com');

    // El email viejo del contacto debe preservarse (no pisamos lo que cargó
    // el operador a mano antes). Query directa — no polling porque queremos
    // verificar que NO cambió (probando estabilidad, no aparición).
    const { rows } = await pool.query(
      'SELECT email FROM contactos WHERE id = $1',
      [contactoId]
    );
    expect(rows[0].email).toBe('previo@test.com');
  });
});

// Marcar variable como usada para evitar warning de linter — prodBase se usa
// implicit en helpers (catBase) pero queremos mantenerlo legible.
void prodBase;
void db;

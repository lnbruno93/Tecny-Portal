/**
 * Tests del módulo Chat Assistant (#340 Fase 1).
 *
 * Cubre:
 *   - getTodayWindowStartArtIso() devuelve un timestamp consistente con
 *     medianoche en ART (UTC-3).
 *   - CRUD básico: POST /conversations, GET /conversations, DELETE.
 *   - Auth: sin token → 401.
 *   - Multi-tenant isolation: user de tenant 2 NO ve conv de tenant 1.
 *   - Within-tenant isolation: user A de tenant 1 NO ve conv de user B
 *     del mismo tenant (chat es PERSONAL).
 *   - runChatTurn con SDK mockeado: persiste user msg + assistant msg,
 *     setea titulo desde primer texto, devuelve tokens del usage.
 *   - Tool loop: si Anthropic responde con tool_use, el dispatcher ejecuta
 *     y vuelve a llamar con tool_result hasta convergir.
 *
 * Nota: el rate-limit de prod (5/min/user, 50/día/user, 150/día/tenant) NO
 * se ejercita acá — en NODE_ENV=test ambos middlewares se skipean para no
 * acoplar tests a la tabla `chat_rate_limits` (que sí se truncea en setup
 * para evitar leak entre suites). Lógica del window_start se cubre via
 * test unitario directo. El dispatch real de los limits se valida en
 * staging vía smoke test manual.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// Mock @anthropic-ai/sdk ANTES de require('../src/app') — el require de
// app.js eventualmente carga chat-tools que importa el SDK. Si no
// mockeamos, intentaría hitear la API real en cada test.
jest.mock('@anthropic-ai/sdk', () => {
  // Stub controlable: cada test setea `mockResponses` con una secuencia de
  // payloads que el SDK irá devolviendo. Si la cola se vacía, devuelve un
  // end_turn vacío. Si quiere devolver tool_use, primero el caller pushea
  // una entrada con `stop_reason:'tool_use'` y luego una final con texto.
  const mockResponses = [];
  function MockAnthropic() {
    return {
      messages: {
        create: jest.fn(async (params) => {
          MockAnthropic.lastCallParams = params;
          if (mockResponses.length === 0) {
            return {
              id: 'msg_default',
              content: [{ type: 'text', text: 'OK' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 5 },
            };
          }
          return mockResponses.shift();
        }),
      },
    };
  }
  MockAnthropic.__queueResponse = (r) => mockResponses.push(r);
  MockAnthropic.__resetQueue = () => { mockResponses.length = 0; };
  MockAnthropic.lastCallParams = null;
  return MockAnthropic;
});

const app = require('../src/app');
const Anthropic = require('@anthropic-ai/sdk');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const chatRoute = require('../src/routes/chat');
const chatLib = require('../src/lib/chat');
const { executeTool } = require('../src/lib/chat-tools');

let pool;
let user1Tenant1Token;   // testadmin original
let user2Tenant1Token;   // otro user del mismo tenant 1
let user1Tenant2Token;   // user de tenant 2

beforeAll(async () => {
  pool = await setupTestDb();

  // Asegurar que ANTHROPIC_API_KEY esté seteada para que el cliente se
  // inicialice (el SDK está mockeado, pero el wrapper chequea env var).
  process.env.ANTHROPIC_API_KEY = 'sk-test-mock';

  // user1 (testadmin) ya creado por setupTestDb — id=1, tenant 1.
  user1Tenant1Token = jwt.sign(
    {
      id: 1, username: TEST_USER.username, email: TEST_USER.email,
      role: TEST_USER.role, tenant_id: 1, tenant_rol: 'owner',
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  // Crear user2 en tenant 1.
  const hash = await bcrypt.hash('pass1234', 10);
  const { rows: u2Rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role)
     VALUES ('User2 Tenant1', 'user2t1', 'u2t1@test.local', $1, 'admin')
     RETURNING id`,
    [hash]
  );
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'admin')`,
    [u2Rows[0].id]
  );
  user2Tenant1Token = jwt.sign(
    {
      id: u2Rows[0].id, username: 'user2t1', email: 'u2t1@test.local',
      role: 'admin', tenant_id: 1, tenant_rol: 'admin', iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  // Crear tenant 2 + user dentro.
  await pool.query(
    `INSERT INTO tenants (id, nombre, slug) VALUES (2, 'Tenant 2', 'tenant-2')
       ON CONFLICT (id) DO NOTHING`
  );
  // CRÍTICO: avanzar tenants_id_seq al MAX(id) actual. Sin esto, signup.test.js
  // (corre después alfabéticamente) genera nuevos tenants vía secuencia, recibe
  // id=2, choca con la fila acá → INSERT falla con 23505 → endpoint devuelve
  // 409. Mismo pattern que multitenant-isolation.test.js#53.
  // (Setval no es CASCADE — la secuencia persiste entre TRUNCATEs hasta que
  // alguien la resetee, así que este SELECT es defensivo cada vez.)
  await pool.query(
    `SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1))`
  );
  const { rows: u3Rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role)
     VALUES ('User1 Tenant2', 'u1t2', 'u1t2@test.local', $1, 'admin')
     RETURNING id`,
    [hash]
  );
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (2, $1, 'owner')`,
    [u3Rows[0].id]
  );
  user1Tenant2Token = jwt.sign(
    {
      id: u3Rows[0].id, username: 'u1t2', email: 'u1t2@test.local',
      role: 'admin', tenant_id: 2, tenant_rol: 'owner', iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
});

afterAll(async () => { await teardownTestDb(pool); });

beforeEach(async () => {
  Anthropic.__resetQueue();
  await pool.query(`TRUNCATE chat_messages, chat_conversations, chat_rate_limits RESTART IDENTITY CASCADE`);
});

// ─────────────────────────────────────────────────────────────────────────
// Unit: getTodayWindowStartArtIso()
// ─────────────────────────────────────────────────────────────────────────
describe('getTodayWindowStartArtIso', () => {
  it('devuelve un ISO que representa medianoche ART (UTC-3)', () => {
    const iso = chatRoute.getTodayWindowStartArtIso();
    const d = new Date(iso);
    // Si convertimos el instant de vuelta a ART (UTC-3), debe ser 00:00:00.
    const artHours = (d.getUTCHours() - 3 + 24) % 24;
    expect(artHours).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
  });

  it('es estable dentro del mismo día', () => {
    const a = chatRoute.getTodayWindowStartArtIso();
    const b = chatRoute.getTodayWindowStartArtIso();
    expect(a).toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Auth + CRUD básico
// ─────────────────────────────────────────────────────────────────────────
describe('Chat — auth & CRUD', () => {
  it('sin token → 401 en POST /conversations', async () => {
    const r = await request(app).post('/api/chat/conversations').send({});
    expect(r.status).toBe(401);
  });

  it('crea conversación vacía con titulo NULL', async () => {
    const r = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});
    expect(r.status).toBe(201);
    // chat_conversations.id es BIGSERIAL — node-postgres lo devuelve como
    // string para preservar precisión de bigint. Convertimos para validar.
    expect(Number(r.body.id)).toBeGreaterThan(0);
    expect(r.body.created_at).toBeDefined();

    // Verificar en DB
    const { rows } = await pool.query(
      `SELECT id, tenant_id, user_id, titulo FROM chat_conversations WHERE id = $1`,
      [r.body.id]
    );
    expect(rows[0].tenant_id).toBe(1);
    expect(rows[0].user_id).toBe(1);
    expect(rows[0].titulo).toBeNull();
  });

  it('lista solo conversaciones del user del JWT (no de compañeros del mismo tenant)', async () => {
    // user1 crea una.
    const r1 = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});
    // user2 (mismo tenant 1) crea otra.
    await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user2Tenant1Token}`)
      .send({});

    const listU1 = await request(app)
      .get('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`);
    expect(listU1.status).toBe(200);
    expect(listU1.body).toHaveLength(1);
    expect(listU1.body[0].id).toBe(r1.body.id);
  });

  it('GET /conversations/:id devuelve 404 si pertenece a otro user del MISMO tenant', async () => {
    const r1 = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});

    const get = await request(app)
      .get(`/api/chat/conversations/${r1.body.id}`)
      .set('Authorization', `Bearer ${user2Tenant1Token}`);
    expect(get.status).toBe(404);
  });

  it('GET /conversations/:id devuelve 404 cross-tenant (RLS bloquea)', async () => {
    const r1 = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});

    const get = await request(app)
      .get(`/api/chat/conversations/${r1.body.id}`)
      .set('Authorization', `Bearer ${user1Tenant2Token}`);
    expect(get.status).toBe(404);
  });

  it('DELETE no permite borrar conv ajena (404)', async () => {
    const r1 = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});
    const del = await request(app)
      .delete(`/api/chat/conversations/${r1.body.id}`)
      .set('Authorization', `Bearer ${user2Tenant1Token}`);
    expect(del.status).toBe(404);

    // Sigue existiendo para el dueño.
    const get = await request(app)
      .get(`/api/chat/conversations/${r1.body.id}`)
      .set('Authorization', `Bearer ${user1Tenant1Token}`);
    expect(get.status).toBe(200);
  });

  it('DELETE del dueño borra + cascada a mensajes', async () => {
    const r1 = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});
    // Inserción directa de mensaje en DB para verificar cascada
    await pool.query(
      `INSERT INTO chat_messages (conversation_id, tenant_id, role, content)
       VALUES ($1, 1, 'user', '[{"type":"text","text":"hola"}]'::jsonb)`,
      [r1.body.id]
    );
    const del = await request(app)
      .delete(`/api/chat/conversations/${r1.body.id}`)
      .set('Authorization', `Bearer ${user1Tenant1Token}`);
    expect(del.status).toBe(204);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM chat_messages WHERE conversation_id = $1`,
      [r1.body.id]
    );
    expect(rows[0].c).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /messages (runChatTurn con Anthropic mockeado)
// ─────────────────────────────────────────────────────────────────────────
describe('Chat — POST /messages (con SDK mockeado)', () => {
  it('persiste user msg + assistant msg, setea titulo, devuelve texto + tokens', async () => {
    Anthropic.__queueResponse({
      id: 'msg_1',
      content: [{ type: 'text', text: 'Hoy vendiste $0 (todavía).' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
    });

    const conv = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});

    const r = await request(app)
      .post(`/api/chat/conversations/${conv.body.id}/messages`)
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({ text: '¿Cuánto vendí hoy?' });

    expect(r.status).toBe(200);
    expect(r.body.text).toBe('Hoy vendiste $0 (todavía).');
    expect(r.body.model).toBe('claude-sonnet-4-5');
    expect(r.body.tokens.input).toBe(100);
    expect(r.body.tokens.output).toBe(20);
    expect(r.body.tool_calls).toBe(0);

    // Verificar persistencia: 2 mensajes en chat_messages
    const { rows: msgs } = await pool.query(
      `SELECT role, content, model FROM chat_messages
        WHERE conversation_id = $1 ORDER BY id`,
      [conv.body.id]
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toEqual([{ type: 'text', text: '¿Cuánto vendí hoy?' }]);
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].model).toBe('claude-sonnet-4-5');

    // Titulo seteado del primer user msg
    const { rows: convRows } = await pool.query(
      `SELECT titulo FROM chat_conversations WHERE id = $1`,
      [conv.body.id]
    );
    expect(convRows[0].titulo).toBe('¿Cuánto vendí hoy?');
  });

  it('ejecuta tool loop: tool_use → tool_result → respuesta final', async () => {
    // Primera respuesta: tool_use de get_kpis_hoy
    Anthropic.__queueResponse({
      id: 'msg_1',
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'get_kpis_hoy', input: {} },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 200, output_tokens: 30 },
    });
    // Segunda respuesta: texto final con los datos
    Anthropic.__queueResponse({
      id: 'msg_2',
      content: [{ type: 'text', text: 'Vendiste $0 hoy (sin movimientos).' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 150, output_tokens: 25 },
    });

    const conv = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});
    const r = await request(app)
      .post(`/api/chat/conversations/${conv.body.id}/messages`)
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({ text: '¿Cómo vamos hoy?' });

    expect(r.status).toBe(200);
    expect(r.body.text).toBe('Vendiste $0 hoy (sin movimientos).');
    expect(r.body.tool_calls).toBe(1);
    // tokens acumulados de ambos calls
    expect(r.body.tokens.input).toBe(350);
    expect(r.body.tokens.output).toBe(55);
  });

  it('rechaza body sin text', async () => {
    const conv = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});
    const r = await request(app)
      .post(`/api/chat/conversations/${conv.body.id}/messages`)
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('rechaza text con solo espacios', async () => {
    const conv = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});
    const r = await request(app)
      .post(`/api/chat/conversations/${conv.body.id}/messages`)
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({ text: '    ' });
    expect(r.status).toBe(400);
  });

  it('404 si conv no pertenece al user', async () => {
    const conv = await request(app)
      .post('/api/chat/conversations')
      .set('Authorization', `Bearer ${user1Tenant1Token}`)
      .send({});
    const r = await request(app)
      .post(`/api/chat/conversations/${conv.body.id}/messages`)
      .set('Authorization', `Bearer ${user2Tenant1Token}`)
      .send({ text: 'hola' });
    expect(r.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// chatLib directo (sin route)
// ─────────────────────────────────────────────────────────────────────────
describe('chatLib.runChatTurn — validaciones', () => {
  it('throw si conversationId inválido', async () => {
    await expect(
      chatLib.runChatTurn({ conversationId: -1, userText: 'x', ctx: { tenantId: 1, userId: 1 } })
    ).rejects.toThrow('conversationId inválido');
  });

  it('throw si userText vacío', async () => {
    await expect(
      chatLib.runChatTurn({ conversationId: 1, userText: '', ctx: { tenantId: 1, userId: 1 } })
    ).rejects.toThrow('userText vacío');
  });

  it('throw si tenantId falta', async () => {
    await expect(
      chatLib.runChatTurn({ conversationId: 1, userText: 'x', ctx: { userId: 1 } })
    ).rejects.toThrow('ctx.tenantId requerido');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tools Tier 1 — handlers invocados directo (no via route ni Anthropic)
// Validan que las queries SQL devuelven números correctos contra datos
// seedeados en el setup. Cada test limpia + inserta lo que necesita.
// ─────────────────────────────────────────────────────────────────────────
const T1_CTX = { tenantId: 1, userId: 1 };

describe('Tools Tier 1 — get_ventas_periodo', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM ventas WHERE tenant_id = 1`);
    await pool.query(`DELETE FROM movimientos_cc WHERE cliente_cc_id IN (SELECT id FROM clientes_cc WHERE tenant_id = 1)`);
  });

  it('cuenta ventas retail acreditadas + pendientes del día y skipea canceladas', async () => {
    // 2 acreditadas + 1 pendiente + 1 cancelada (NO debe contar)
    await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, ganancia_usd, comision_total_metodos, tenant_id)
       VALUES
         ('o1', CURRENT_DATE, 'A', 'acreditado', 100, 30, 5,  1),
         ('o2', CURRENT_DATE, 'B', 'acreditado', 200, 60, 10, 1),
         ('o3', CURRENT_DATE, 'C', 'pendiente',  150, 40, 0,  1),
         ('o4', CURRENT_DATE, 'D', 'cancelado',  999, 0,  0,  1)`
    );
    const r = await executeTool('get_ventas_periodo', { periodo: 'hoy' }, T1_CTX);
    expect(r.retail.ventas_count).toBe(3); // cancelada no cuenta
    expect(r.retail.acreditadas).toBe(2);
    expect(r.retail.pendientes).toBe(1);
    expect(Number(r.retail.ingresos_usd)).toBe(450); // 100+200+150
    expect(Number(r.retail.ganancia_acreditada_usd)).toBe(90); // 30+60
    expect(Number(r.consolidado.costo_financiero_usd)).toBe(15); // solo acreditadas: 5+10
    expect(Number(r.consolidado.ganancia_neta_usd)).toBe(75); // 90 - 15
    expect(Number(r.consolidado.ticket_promedio_usd)).toBe(150); // 450/3
  });

  it('filtra por rango: ventas fuera del período no cuentan', async () => {
    await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, ganancia_usd, tenant_id)
       VALUES
         ('hoy',  CURRENT_DATE,                       'X', 'acreditado', 100, 10, 1),
         ('ayer', CURRENT_DATE - INTERVAL '1 day',    'Y', 'acreditado', 200, 20, 1),
         ('viejo',CURRENT_DATE - INTERVAL '60 days',  'Z', 'acreditado', 999, 99, 1)`
    );
    const r = await executeTool('get_ventas_periodo', { periodo: 'hoy' }, T1_CTX);
    expect(r.retail.ventas_count).toBe(1);
    expect(Number(r.retail.ingresos_usd)).toBe(100);

    const semana = await executeTool('get_ventas_periodo', { periodo: 'semana' }, T1_CTX);
    expect(semana.retail.ventas_count).toBe(2); // hoy + ayer
  });

  it('skipea ventas soft-deleted', async () => {
    await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, tenant_id, deleted_at)
       VALUES
         ('live', CURRENT_DATE, 'L', 'acreditado', 50, 1, NULL),
         ('dead', CURRENT_DATE, 'D', 'acreditado', 99, 1, NOW())`
    );
    const r = await executeTool('get_ventas_periodo', { periodo: 'hoy' }, T1_CTX);
    expect(r.retail.ventas_count).toBe(1);
    expect(Number(r.retail.ingresos_usd)).toBe(50);
  });

  it('incluye B2B (movimientos_cc tipo=compra) en consolidado', async () => {
    const { rows: cc } = await pool.query(
      `INSERT INTO clientes_cc (nombre, tenant_id) VALUES ('B2B Co', 1) RETURNING id`
    );
    await pool.query(
      `INSERT INTO movimientos_cc (cliente_cc_id, fecha, tipo, monto_total)
       VALUES
         ($1, CURRENT_DATE, 'compra', 300),
         ($1, CURRENT_DATE, 'compra', 200),
         ($1, CURRENT_DATE, 'pago',   100)  -- pago NO cuenta como venta`,
      [cc[0].id]
    );
    const r = await executeTool('get_ventas_periodo', { periodo: 'hoy' }, T1_CTX);
    expect(r.b2b.ventas_count).toBe(2);
    expect(Number(r.b2b.ingresos_usd)).toBe(500);
    expect(Number(r.consolidado.ingresos_usd)).toBe(500); // sin retail
  });

  it('período custom acepta desde/hasta', async () => {
    await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, tenant_id)
       VALUES ('c1', '2026-03-15', 'X', 'acreditado', 100, 1)`
    );
    const r = await executeTool(
      'get_ventas_periodo',
      { periodo: 'custom', desde: '2026-03-01', hasta: '2026-03-31' },
      T1_CTX
    );
    expect(r.retail.ventas_count).toBe(1);
    expect(r.periodo.label).toContain('2026-03-01');
  });

  it('devuelve error friendly si período es inválido (no rompe el chat)', async () => {
    const r = await executeTool('get_ventas_periodo', { periodo: 'siglo' }, T1_CTX);
    expect(r.error).toBeDefined();
    expect(r.error).toMatch(/datos/i);
  });
});

describe('Tools Tier 1 — get_envios_activos', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM envios WHERE tenant_id = 1`);
  });

  it('cuenta Pendiente + En camino, excluye Entregado y Cancelado', async () => {
    await pool.query(
      `INSERT INTO envios (fecha, cliente, direccion, total_cobrado, estado, tenant_id)
       VALUES
         (CURRENT_DATE, 'C1', 'd1', 100, 'Pendiente', 1),
         (CURRENT_DATE, 'C2', 'd2', 200, 'En camino', 1),
         (CURRENT_DATE, 'C3', 'd3', 300, 'Entregado', 1),
         (CURRENT_DATE, 'C4', 'd4', 999, 'Cancelado', 1)`
    );
    const r = await executeTool('get_envios_activos', {}, T1_CTX);
    expect(r.resumen.total).toBe(2);
    expect(r.resumen.pendientes).toBe(1);
    expect(r.resumen.en_camino).toBe(1);
    expect(Number(r.resumen.total_a_cobrar)).toBe(300);
    expect(r.items).toHaveLength(2);
  });

  it('ordena por prioridad Alta > Media > sin, después fecha asc', async () => {
    await pool.query(
      `INSERT INTO envios (fecha, cliente, direccion, total_cobrado, estado, prioridad, tenant_id)
       VALUES
         (CURRENT_DATE,                    'media',  'x', 100, 'Pendiente', 'Media', 1),
         (CURRENT_DATE - INTERVAL '5 days','alta',   'x', 100, 'Pendiente', 'Alta',  1),
         (CURRENT_DATE,                    'normal', 'x', 100, 'Pendiente', NULL,    1)`
    );
    const r = await executeTool('get_envios_activos', { limit: 10 }, T1_CTX);
    expect(r.items.map((e) => e.cliente)).toEqual(['alta', 'media', 'normal']);
  });

  it('respeta limit (default 10, max 50)', async () => {
    const inserts = Array.from({ length: 15 }, (_, i) =>
      `(CURRENT_DATE, 'C${i}', 'd', 0, 'Pendiente', 1)`
    ).join(',');
    await pool.query(
      `INSERT INTO envios (fecha, cliente, direccion, total_cobrado, estado, tenant_id) VALUES ${inserts}`
    );
    const r1 = await executeTool('get_envios_activos', {}, T1_CTX);
    expect(r1.items).toHaveLength(10);
    expect(r1.resumen.total).toBe(15); // resumen no limita

    const r2 = await executeTool('get_envios_activos', { limit: 5 }, T1_CTX);
    expect(r2.items).toHaveLength(5);
  });
});

describe('Tools Tier 1 — get_saldos_cajas', () => {
  it('calcula saldo = saldo_inicial + ingresos - egresos por caja', async () => {
    const { rows } = await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, saldo_inicial, activo)
       VALUES ('CajaUSD Test', 'USD', 1000, true)
       RETURNING id`
    );
    const cajaId = rows[0].id;
    await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto)
       VALUES
         ($1, CURRENT_DATE, 'ingreso', 500, 500, 'ajuste', 'manual', 0, 'ing test'),
         ($1, CURRENT_DATE, 'egreso',  200, 200, 'ajuste', 'manual', 0, 'eg test')`,
      [cajaId]
    );
    const r = await executeTool('get_saldos_cajas', {}, T1_CTX);
    const caja = r.cajas.find((c) => c.id === cajaId);
    expect(caja).toBeDefined();
    expect(Number(caja.saldo)).toBe(1300); // 1000 + 500 - 200
    expect(Number(r.totales_por_moneda.USD)).toBeGreaterThanOrEqual(1300);
  });

  it('agrupa USDT con USD, ARS aparte', async () => {
    await pool.query(`DELETE FROM caja_movimientos WHERE caja_id IN (SELECT id FROM metodos_pago WHERE nombre LIKE 'AgrupTest%')`);
    await pool.query(`DELETE FROM metodos_pago WHERE nombre LIKE 'AgrupTest%'`);
    await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, saldo_inicial, activo)
       VALUES
         ('AgrupTest USD', 'USD',  100, true),
         ('AgrupTest USDT','USDT', 50,  true),
         ('AgrupTest ARS', 'ARS',  1000, true)`
    );
    const r = await executeTool('get_saldos_cajas', {}, T1_CTX);
    const usd = r.cajas.find((c) => c.nombre === 'AgrupTest USD');
    const usdt = r.cajas.find((c) => c.nombre === 'AgrupTest USDT');
    const ars = r.cajas.find((c) => c.nombre === 'AgrupTest ARS');
    expect(Number(usd.saldo)).toBe(100);
    expect(Number(usdt.saldo)).toBe(50);
    expect(Number(ars.saldo)).toBe(1000);
    // El total USD del tenant debe incluir USDT.
    // (No assertamos valor exacto del total porque hay cajas del seed compartidas.)
    expect(Object.keys(r.totales_por_moneda).sort()).toEqual(['ARS', 'USD']);
  });
});

describe('Tools Tier 1 — get_alertas', () => {
  it('cuenta stock bajo y cajas en negativo', async () => {
    // Caja en negativo
    const { rows: cajaRows } = await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, saldo_inicial, activo)
       VALUES ('AlertaCaja Test', 'USD', 0, true)
       RETURNING id`
    );
    await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto)
       VALUES ($1, CURRENT_DATE, 'egreso', 50, 50, 'ajuste', 'manual', 0, 'forzar negativo')`,
      [cajaRows[0].id]
    );
    // Producto con stock bajo (umbral default 5, ponemos 2)
    await pool.query(
      `INSERT INTO productos (nombre, cantidad, oculto, condicion, tenant_id)
       VALUES ('ProdBajoStock', 2, false, 'nuevo', 1)`
    );

    const r = await executeTool('get_alertas', {}, T1_CTX);
    expect(r.total).toBeGreaterThanOrEqual(2);
    const cajaNeg = r.grupos.find((g) => g.tipo === 'caja_negativa');
    expect(cajaNeg.count).toBeGreaterThanOrEqual(1);
    const stock = r.grupos.find((g) => g.tipo === 'stock_bajo');
    expect(stock.count).toBeGreaterThanOrEqual(1);
    expect(stock.items.some((i) => i.descripcion === 'ProdBajoStock')).toBe(true);
  });
});

describe('Tools Tier 1 — get_dashboard_mensual', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM ventas WHERE tenant_id = 1`);
  });

  it('devuelve mes actual + mes anterior + deltas', async () => {
    // Una venta mes actual + una mes anterior con números distintos.
    await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, ganancia_usd, comision_total_metodos, tenant_id)
       VALUES
         ('act', CURRENT_DATE,                            'A', 'acreditado', 200, 50, 5, 1),
         ('ant', CURRENT_DATE - INTERVAL '35 days',       'B', 'acreditado', 100, 20, 0, 1)`
    );
    const r = await executeTool('get_dashboard_mensual', {}, T1_CTX);
    expect(Number(r.mes_actual.ingresos_usd)).toBe(200);
    // Mes anterior puede no caer exactamente 35 días atrás dependiendo de calendario,
    // pero al menos validamos shape + deltas.
    expect(r.deltas).toBeDefined();
    expect(r.deltas.ingresos_usd).toHaveProperty('absoluto');
    expect(r.deltas.ingresos_usd).toHaveProperty('porcentual');
  });

  it('delta 100% si mes anterior fue 0 y mes actual > 0', async () => {
    await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, tenant_id)
       VALUES ('act', CURRENT_DATE, 'A', 'acreditado', 100, 1)`
    );
    const r = await executeTool('get_dashboard_mensual', {}, T1_CTX);
    expect(r.deltas.ingresos_usd.porcentual).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tools Tier 2 — handlers contra DB con datos sembrados (PR #3)
// ─────────────────────────────────────────────────────────────────────────
describe('Tools Tier 2 — get_top_productos', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM venta_items WHERE venta_id IN (SELECT id FROM ventas WHERE tenant_id = 1)`);
    await pool.query(`DELETE FROM ventas WHERE tenant_id = 1`);
  });

  it('agrupa por descripcion y ordena por qty desc + ingreso desc', async () => {
    const { rows: [v] } = await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, tenant_id)
       VALUES ('o1', CURRENT_DATE, 'C', 'acreditado', 500, 1) RETURNING id`
    );
    await pool.query(
      `INSERT INTO venta_items (venta_id, descripcion, cantidad, precio_vendido, costo, moneda)
       VALUES
         ($1, 'iPhone 15', 3, 100, 50, 'USD'),
         ($1, 'iPhone 15', 2, 100, 50, 'USD'),
         ($1, 'AirPods',   5, 30,  10, 'USD')`,
      [v.id]
    );

    const r = await executeTool('get_top_productos', { periodo: 'hoy', limit: 5 }, T1_CTX);
    expect(r.top).toHaveLength(2);
    const iphone = r.top.find(p => p.descripcion === 'iPhone 15');
    expect(iphone.cantidad).toBe(5);
    expect(Number(iphone.ingreso_usd)).toBe(500);
    // Empate qty (5 vs 5) → ingreso desc → iPhone primero.
    expect(r.top[0].descripcion).toBe('iPhone 15');
  });

  it('skipea ventas canceladas', async () => {
    const { rows: [vCancel] } = await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, tenant_id)
       VALUES ('cx', CURRENT_DATE, 'X', 'cancelado', 9999, 1) RETURNING id`
    );
    await pool.query(
      `INSERT INTO venta_items (venta_id, descripcion, cantidad, precio_vendido, costo, moneda)
       VALUES ($1, 'ProductoCancelado', 99, 999, 0, 'USD')`,
      [vCancel.id]
    );
    const r = await executeTool('get_top_productos', { periodo: 'hoy' }, T1_CTX);
    expect(r.top.find(p => p.descripcion === 'ProductoCancelado')).toBeUndefined();
  });
});

describe('Tools Tier 2 — get_top_vendedores', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM venta_items WHERE venta_id IN (SELECT id FROM ventas WHERE tenant_id = 1)`);
    await pool.query(`DELETE FROM ventas WHERE tenant_id = 1`);
    await pool.query(`DELETE FROM vendedores WHERE tenant_id = 1`);
  });

  it('rankea por ingreso desc y cuenta ventas distintas', async () => {
    const { rows: [vd1] } = await pool.query(
      `INSERT INTO vendedores (nombre, tenant_id) VALUES ('Vendedor A', 1) RETURNING id`
    );
    const { rows: [vd2] } = await pool.query(
      `INSERT INTO vendedores (nombre, tenant_id) VALUES ('Vendedor B', 1) RETURNING id`
    );
    const { rows: [v1] } = await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, tenant_id)
       VALUES ('o1', CURRENT_DATE, 'C1', 'acreditado', 100, 1) RETURNING id`
    );
    const { rows: [v2] } = await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, tenant_id)
       VALUES ('o2', CURRENT_DATE, 'C2', 'acreditado', 100, 1) RETURNING id`
    );
    await pool.query(
      `INSERT INTO venta_items (venta_id, vendedor_id, descripcion, cantidad, precio_vendido, costo, moneda)
       VALUES
         ($1, $3, 'X', 1, 500, 0, 'USD'),
         ($2, $3, 'Y', 1, 300, 0, 'USD'),
         ($1, $4, 'Z', 1, 100, 0, 'USD')`,
      [v1.id, v2.id, vd1.id, vd2.id]
    );
    const r = await executeTool('get_top_vendedores', { periodo: 'hoy' }, T1_CTX);
    expect(r.top[0].nombre).toBe('Vendedor A');
    expect(Number(r.top[0].ingreso_usd)).toBe(800);
    expect(r.top[0].ventas_count).toBe(2);
    expect(r.top[1].nombre).toBe('Vendedor B');
    expect(r.top[1].ventas_count).toBe(1);
  });
});

describe('Tools Tier 2 — get_cc_pendientes', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM movimientos_cc WHERE cliente_cc_id IN (SELECT id FROM clientes_cc WHERE tenant_id = 1)`);
    await pool.query(`DELETE FROM clientes_cc WHERE tenant_id = 1`);
  });

  it('clientes con saldo > 0 aparecen, saldo 0 no', async () => {
    const { rows: [c1] } = await pool.query(
      `INSERT INTO clientes_cc (nombre, tenant_id) VALUES ('Cliente Debe', 1) RETURNING id`
    );
    const { rows: [c2] } = await pool.query(
      `INSERT INTO clientes_cc (nombre, tenant_id) VALUES ('Cliente Pago Todo', 1) RETURNING id`
    );
    await pool.query(
      `INSERT INTO movimientos_cc (cliente_cc_id, fecha, tipo, monto_total)
       VALUES ($1, CURRENT_DATE, 'compra', 200), ($1, CURRENT_DATE, 'pago', 50)`,
      [c1.id]
    );
    await pool.query(
      `INSERT INTO movimientos_cc (cliente_cc_id, fecha, tipo, monto_total)
       VALUES ($1, CURRENT_DATE, 'compra', 100), ($1, CURRENT_DATE, 'pago', 100)`,
      [c2.id]
    );

    const r = await executeTool('get_cc_pendientes', {}, T1_CTX);
    expect(r.resumen.clientes_con_saldo).toBe(1);
    expect(Number(r.resumen.total_a_cobrar_usd)).toBe(150);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].nombre).toBe('Cliente Debe');
    expect(Number(r.items[0].saldo_usd)).toBe(150);
  });

  it('compra con caja_id (cobrada al instante) NO cuenta como CC', async () => {
    const { rows: [c] } = await pool.query(
      `INSERT INTO clientes_cc (nombre, tenant_id) VALUES ('Cliente Contado', 1) RETURNING id`
    );
    const { rows: [caja] } = await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, saldo_inicial, tenant_id)
       VALUES ('CajaTestCC', 'USD', 0, 1) RETURNING id`
    );
    await pool.query(
      `INSERT INTO movimientos_cc (cliente_cc_id, fecha, tipo, monto_total, caja_id)
       VALUES ($1, CURRENT_DATE, 'compra', 500, $2)`,
      [c.id, caja.id]
    );
    const r = await executeTool('get_cc_pendientes', {}, T1_CTX);
    expect(r.resumen.clientes_con_saldo).toBe(0);
  });
});

describe('Tools Tier 2 — get_proveedores_pendientes', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM proveedor_movimientos WHERE proveedor_id IN (SELECT id FROM proveedores WHERE tenant_id = 1)`);
    await pool.query(`DELETE FROM proveedores WHERE tenant_id = 1`);
  });

  it('proveedor con saldo > 0 aparece, ordenado por mayor saldo primero', async () => {
    const { rows: [p1] } = await pool.query(
      `INSERT INTO proveedores (nombre, tenant_id) VALUES ('Prov A', 1) RETURNING id`
    );
    const { rows: [p2] } = await pool.query(
      `INSERT INTO proveedores (nombre, tenant_id) VALUES ('Prov B', 1) RETURNING id`
    );
    await pool.query(
      `INSERT INTO proveedor_movimientos (proveedor_id, fecha, tipo, monto_usd)
       VALUES
         ($1, CURRENT_DATE, 'compra', 1000), ($1, CURRENT_DATE, 'pago', 200),
         ($2, CURRENT_DATE, 'compra', 500)`,
      [p1.id, p2.id]
    );
    const r = await executeTool('get_proveedores_pendientes', {}, T1_CTX);
    expect(r.items[0].nombre).toBe('Prov A');
    expect(Number(r.items[0].saldo_usd)).toBe(800);
    expect(r.items[1].nombre).toBe('Prov B');
    expect(Number(r.resumen.total_a_pagar_usd)).toBe(1300);
  });
});

describe('Tools Tier 2 — get_ventas_pendientes', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM ventas WHERE tenant_id = 1`);
  });

  it('lista solo ventas con estado pendiente, más viejas primero', async () => {
    await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, tenant_id)
       VALUES
         ('p1', CURRENT_DATE - INTERVAL '5 days', 'PEND1', 'pendiente',  100, 1),
         ('p2', CURRENT_DATE - INTERVAL '2 days', 'PEND2', 'pendiente',  200, 1),
         ('ac', CURRENT_DATE,                     'AC',    'acreditado', 999, 1),
         ('cn', CURRENT_DATE,                     'CN',    'cancelado',  999, 1)`
    );
    const r = await executeTool('get_ventas_pendientes', {}, T1_CTX);
    expect(r.resumen.total_count).toBe(2);
    expect(Number(r.resumen.total_pendiente_usd)).toBe(300);
    expect(r.items[0].cliente).toBe('PEND1');
    expect(r.items[1].cliente).toBe('PEND2');
  });
});

describe('Tools Tier 2 — get_tarjetas_no_liquidadas', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM tarjeta_movimientos WHERE metodo_pago_id IN (SELECT id FROM metodos_pago WHERE nombre LIKE 'TestTarjeta%')`);
    await pool.query(`DELETE FROM metodos_pago WHERE nombre LIKE 'TestTarjeta%' AND tenant_id = 1`);
  });

  it('saldo adeudado = cobros - liquidaciones', async () => {
    const { rows: [t] } = await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, es_tarjeta, activo, tenant_id)
       VALUES ('TestTarjeta Visa', 'ARS', true, true, 1) RETURNING id`
    );
    await pool.query(
      `INSERT INTO tarjeta_movimientos
         (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, tenant_id)
       VALUES
         ($1, CURRENT_DATE, 'cobro',       'ARS', 1000, 5, 50, 950, 1),
         ($1, CURRENT_DATE, 'cobro',       'ARS', 500,  5, 25, 475, 1),
         ($1, CURRENT_DATE, 'liquidacion', 'ARS', 500,  5, 25, 475, 1)`,
      [t.id]
    );
    const r = await executeTool('get_tarjetas_no_liquidadas', {}, T1_CTX);
    const visa = r.tarjetas.find(x => x.nombre === 'TestTarjeta Visa');
    expect(Number(visa.saldo_adeudado)).toBe(950); // 950 + 475 - 475
  });
});

describe('Tools Tier 2 — get_stock_bajo', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM productos WHERE tenant_id = 1 AND nombre LIKE 'StockTest%'`);
  });

  it('lista productos visibles con cantidad < umbral, excluye ocultos y usados', async () => {
    await pool.query(
      `INSERT INTO productos (nombre, cantidad, oculto, condicion, tenant_id)
       VALUES
         ('StockTest A', 2, false, 'nuevo', 1),
         ('StockTest B', 10, false, 'nuevo', 1),
         ('StockTest Oculto', 1, true,  'nuevo', 1),
         ('StockTest Usado',  1, false, 'usado', 1)`
    );
    const r = await executeTool('get_stock_bajo', { umbral: 5 }, T1_CTX);
    const nombres = r.items.map(i => i.nombre);
    expect(nombres).toContain('StockTest A');
    expect(nombres).not.toContain('StockTest B');
    expect(nombres).not.toContain('StockTest Oculto');
    expect(nombres).not.toContain('StockTest Usado');
  });
});

describe('Tools Tier 2 — get_actividad_reciente', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE tenant_id = 1`);
  });

  it('devuelve eventos del tenant ordenados desc, excluye audit_queue', async () => {
    // audit_logs.accion CHECK solo permite INSERT/UPDATE/DELETE.
    // LOGIN se trackea aparte (no llega a esta tabla).
    await pool.query(
      `INSERT INTO audit_logs (tabla, accion, registro_id, datos_despues, user_id, tenant_id, created_at)
       VALUES
         ('ventas',      'INSERT', 1, '{"cliente":"C1"}'::jsonb, 1, 1, NOW() - INTERVAL '2 hours'),
         ('comprobantes','INSERT', 2, '{"cliente":"C2"}'::jsonb, 1, 1, NOW() - INTERVAL '1 hour'),
         ('audit_queue', 'INSERT', 3, '{"data":"interno"}'::jsonb, 1, 1, NOW() - INTERVAL '15 minutes')`
    );
    const r = await executeTool('get_actividad_reciente', { limit: 10, dias: 1 }, T1_CTX);
    // audit_queue excluido (es ruido async low-level)
    expect(r.items.find(i => i.modulo === 'audit_queue')).toBeUndefined();
    expect(r.items).toHaveLength(2);
    expect(r.items[0].modulo).toBe('comprobantes');
    expect(r.items[0].detalle).toBe('C2');
    expect(r.items[1].modulo).toBe('ventas');
  });

  it('respeta ventana de días', async () => {
    await pool.query(
      `INSERT INTO audit_logs (tabla, accion, registro_id, datos_despues, user_id, tenant_id, created_at)
       VALUES
         ('ventas', 'INSERT', 1, '{"cliente":"reciente"}'::jsonb, 1, 1, NOW() - INTERVAL '2 days'),
         ('ventas', 'INSERT', 2, '{"cliente":"viejo"}'::jsonb,    1, 1, NOW() - INTERVAL '30 days')`
    );
    const r = await executeTool('get_actividad_reciente', { dias: 7 }, T1_CTX);
    const detalles = r.items.map(i => i.detalle);
    expect(detalles).toContain('reciente');
    expect(detalles).not.toContain('viejo');
  });
});

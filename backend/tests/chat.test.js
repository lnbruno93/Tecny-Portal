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

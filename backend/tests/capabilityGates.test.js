/**
 * TST-2 (auditoría pre-live 2026-06-24) — matriz de capability gates
 * en endpoints destructivos.
 *
 * El test `requireCapability.test.js` valida la **lógica del middleware**
 * con mocks de DB (bypass admin, fast path JWT caps, fallback DB). NO
 * valida que cada endpoint destructivo esté **wired** con la capability
 * correcta — si alguien refactorea una ruta y se olvida de pegarle
 * `requireCapability('xxx')`, el test del middleware sigue verde y el
 * endpoint queda abierto para cualquier rol.
 *
 * Este test cierra ese hueco: con un user `role='op'` (no-admin) y caps
 * vacías, golpea cada endpoint destructivo y exige **403**. Si la cap
 * se borra del router accidentalmente, el endpoint devuelve 404 (resource
 * not found) o 200 — el test rompe.
 *
 * Caps cubiertas (8 / 45 destructivas o sensibles):
 *   - ventas.eliminar               → DELETE /api/ventas/:id
 *   - proveedores.eliminar_compra   → DELETE /api/proveedores/movimientos/:id
 *   - proyectos.eliminar            → DELETE /api/proyectos/:id
 *   - contactos.crear_borrar        → POST/PUT/DELETE /api/contactos/:id
 *   - inventario.vaciar_stock       → POST /api/inventario/productos/bulk-delete-disponibles
 *   - inventario.ver_costos         → GET  /api/inventario/desglose
 *   - b2b.cobranza_masiva           → POST /api/cuentas/cobranzas-masivas
 *
 * Por qué importa: estos endpoints manejan acciones irreversibles
 * (delete) o expongan información sensible (costos). Sin gate, un user
 * con permiso limitado puede ejecutarlas y romper la confianza del
 * tenant. Antes del primer cliente, este test es la red de seguridad.
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, createTestUser } = require('./helpers/setup');

let pool;
const NOCAPS_USER = { username: 'nocaps_op', password: 'nocapspass_123' };
let nocapsToken;

beforeAll(async () => {
  pool = await setupTestDb();

  // User con role=op (no bypass admin) y SIN capabilities asignadas.
  // El `tenant_user_roles.rol = 'custom'` sin overrides en user_capabilities
  // → loadUserCaps devuelve un Set vacío → todos los requireCapability(*) tiran 403.
  await createTestUser(pool, {
    nombre:    'No Caps Op',
    username:  NOCAPS_USER.username,
    email:     'nocaps@test.local',
    password:  NOCAPS_USER.password,
    role:      'op',         // global no-admin
    tenantRol: 'member',     // tenant no-owner/admin (no bypass)
    capRol:    'custom',     // sin defaults
  });
  const r = await request(app).post('/api/auth/login').send(NOCAPS_USER);
  expect(r.status).toBe(200);
  nocapsToken = r.body.token;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── Tabla de gates a verificar ──────────────────────────────────────────────
// Cada caso: descripción, capability esperada, request a ejecutar.
// El ID usado es 999999 (inexistente). Si el gate funciona → 403 ANTES de
// llegar al lookup. Si el gate falta → 404 o 200 (depende del endpoint).
const GATES = [
  {
    name: 'DELETE /api/ventas/:id requiere ventas.eliminar',
    cap:  'ventas.eliminar',
    req:  () => request(app).delete('/api/ventas/999999'),
  },
  {
    name: 'DELETE /api/proveedores/movimientos/:id requiere proveedores.eliminar_compra',
    cap:  'proveedores.eliminar_compra',
    req:  () => request(app).delete('/api/proveedores/movimientos/999999'),
  },
  {
    name: 'DELETE /api/proyectos/:id requiere proyectos.eliminar',
    cap:  'proyectos.eliminar',
    req:  () => request(app).delete('/api/proyectos/999999'),
  },
  {
    name: 'POST /api/contactos requiere contactos.crear_borrar',
    cap:  'contactos.crear_borrar',
    req:  () => request(app).post('/api/contactos').send({ nombre: 'X' }),
  },
  {
    name: 'DELETE /api/contactos/:id requiere contactos.crear_borrar',
    cap:  'contactos.crear_borrar',
    req:  () => request(app).delete('/api/contactos/999999'),
  },
  {
    name: 'POST /api/inventario/productos/bulk-delete-disponibles requiere inventario.vaciar_stock',
    cap:  'inventario.vaciar_stock',
    req:  () => request(app).post('/api/inventario/productos/bulk-delete-disponibles').send({}),
  },
  {
    name: 'GET /api/inventario/desglose requiere inventario.ver_costos',
    cap:  'inventario.ver_costos',
    req:  () => request(app).get('/api/inventario/desglose'),
  },
  {
    name: 'POST /api/cuentas/cobranzas-masivas requiere b2b.cobranza_masiva',
    cap:  'b2b.cobranza_masiva',
    req:  () => request(app).post('/api/cuentas/cobranzas-masivas').send({ cobranzas: [] }),
  },
];

describe.each(GATES)('capability gate — $name', (G) => {
  it('user sin la cap recibe 403 (gate antes de lookup)', async () => {
    const r = await G.req().set('Authorization', `Bearer ${nocapsToken}`);
    expect(r.status).toBe(403);
    // El mensaje del middleware incluye la palabra "permiso" (en español).
    expect(r.body.error).toMatch(/permiso/i);
  });
});

// Cobertura complementaria: verificamos que sin Authorization header
// directamente devuelve 401 (no 403). Eso valida que el gate de auth
// va ANTES del gate de capability.
describe('capability gates — auth precede a cap', () => {
  it('endpoint destructivo sin token → 401 (no 403)', async () => {
    const r = await request(app).delete('/api/ventas/999999');
    expect(r.status).toBe(401);
  });
});

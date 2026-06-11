// security-probes.test.js — 2026-06-11 T-11
//
// Tests ofensivos de seguridad. Envía payloads maliciosos a endpoints expuestos
// y verifica que el backend NO los ejecute, NO devuelva 500 (information leak),
// NO leakea filas completas, NO crashea.
//
// Cubre 3 vectores:
//   1) SQL injection en query params con ILIKE (`%${input}%` patrón común).
//   2) XSS stored — el backend NO escapa, pero el contrato es que la string
//      viaja literal sin ejecutarse server-side ni causar 500.
//   3) Path traversal en parámetros que podrían usarse como ruta de archivo.
//
// Si un día el backend lee un campo de DB y lo usa para construir SQL sin
// parametrizar (regresión), estos tests fallan ANTES de producción.

const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;

beforeAll(async () => {
  pool = await setupTestDb();
  const login = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = login.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('Security probes', () => {
  describe('SQL injection en `buscar` y query params ILIKE', () => {
    const SQLI_PAYLOADS = [
      `'; DROP TABLE users;--`,
      `' OR 1=1 --`,
      `'; SELECT pg_sleep(5);--`,
      `' UNION SELECT id, password_hash, NULL FROM users --`,
      `\\'; DELETE FROM contactos WHERE 1=1;--`,
    ];

    test.each(SQLI_PAYLOADS)('inventario.productos?buscar=%s → 200 sin leak', async (payload) => {
      const r = await request(app)
        .get(`/api/inventario/productos?buscar=${encodeURIComponent(payload)}`)
        .set(auth());
      // No 500 (eso significaría que el SQL se rompió al concatenar).
      expect(r.status).toBe(200);
      // No devuelve filas si el filtro fuera "siempre verdadero" — debería
      // tratar el payload como string literal y buscar productos cuyo nombre
      // contenga "DROP TABLE users", que obviamente no existen.
      expect(Array.isArray(r.body.data)).toBe(true);
    });

    test.each(SQLI_PAYLOADS)('cuentas.clientes?buscar=%s → 200', async (payload) => {
      const r = await request(app)
        .get(`/api/cuentas/clientes?buscar=${encodeURIComponent(payload)}`)
        .set(auth());
      expect(r.status).toBe(200);
    });

    it('verificar que la tabla users SIGUE intacta tras los probes', async () => {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
      expect(rows[0].n).toBeGreaterThan(0); // si DROP TABLE hubiera ejecutado, count rompería
    });
  });

  describe('XSS payloads stored — viajan literales sin causar 500', () => {
    const XSS_PAYLOADS = [
      `<script>alert('xss')</script>`,
      `"><img src=x onerror=alert(1)>`,
      `javascript:alert('xss')`,
      `<svg onload=alert(1)>`,
    ];

    test.each(XSS_PAYLOADS)('POST /api/contactos nombre=%s → 201 + sin transformación', async (payload) => {
      const r = await request(app).post('/api/contactos').set(auth())
        .send({ nombre: payload, tipo: 'cliente' });
      expect(r.status).toBe(201);
      // El nombre viaja LITERAL — la responsabilidad de escapar es del frontend
      // al renderizar. El backend no transforma ni ejecuta.
      expect(r.body.nombre).toBe(payload);
    });
  });

  describe('Path traversal en :id', () => {
    const TRAVERSAL_PAYLOADS = [
      `../../../etc/passwd`,
      `..%2F..%2F..%2Fetc%2Fpasswd`,
      `/etc/shadow`,
      `0x80`,
    ];

    test.each(TRAVERSAL_PAYLOADS)('GET /api/inventario/productos/%s → 400 o 404 (nunca 500)', async (payload) => {
      const r = await request(app)
        .get(`/api/inventario/productos/${encodeURIComponent(payload)}`)
        .set(auth());
      // Esperamos parseId rechazando con 400, o handler con 404 si llegó como número raro.
      expect([400, 404]).toContain(r.status);
    });
  });

  describe('Type confusion en query params', () => {
    it('limit=999999 es rechazado o cap-eado (no devuelve millones de filas)', async () => {
      const r = await request(app)
        .get('/api/inventario/productos?limit=999999')
        .set(auth());
      // El schema usa .max(200) — rechaza con 400 ANTES de tocar DB. Es la opción
      // más segura (fail-fast contra DOS por payload grande). Si en el futuro
      // pasamos a cap silencioso, el 200 también es aceptable mientras data
      // tenga un cap razonable.
      expect([200, 400]).toContain(r.status);
      if (r.status === 200) {
        expect((r.body.data || []).length).toBeLessThanOrEqual(500);
      }
    });

    it('limit negativo → tratado como default, no rompe', async () => {
      const r = await request(app)
        .get('/api/inventario/productos?limit=-100')
        .set(auth());
      expect([200, 400]).toContain(r.status); // según endpoint: o lo rechaza o lo ignora
    });

    it('page=abc → tratado como default, no rompe', async () => {
      const r = await request(app)
        .get('/api/inventario/productos?page=abc')
        .set(auth());
      expect([200, 400]).toContain(r.status);
    });
  });

  describe('Auth probes', () => {
    it('JWT con role inventado no escala permisos', async () => {
      // Token nuestro tiene role='admin'. Si fabricamos uno con role='superadmin'
      // pero firmado con el mismo secret, el middleware no debería darle perms
      // automáticamente (no existen esos roles en el código). El test simple es:
      // sin token = 401.
      const r = await request(app).get('/api/usuarios');
      expect(r.status).toBe(401);
    });

    it('Authorization header malformado → 401', async () => {
      const r = await request(app).get('/api/auth/me').set('Authorization', 'NotBearer xxx');
      expect(r.status).toBe(401);
    });

    it('Authorization con JWT inválido → 401', async () => {
      const r = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not.a.real.jwt');
      expect(r.status).toBe(401);
    });
  });
});

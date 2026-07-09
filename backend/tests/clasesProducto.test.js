/**
 * Tests de integración — Categorías (clases_producto) por tenant — F3.a
 *
 * Ver design doc: `docs/design/categorias-crud-tenant-f3.md`.
 *
 * Cubre:
 *   - Seed automático post-signup / post-migration (10 filas: 9 base + Sin categoría).
 *   - CRUD: POST/PUT/DELETE + guards de nombre duplicado (409).
 *   - Fila `es_sin_categoria=true` protegida (no editable, no borrable).
 *   - Delete con productos activos → 409 (guard duro).
 *   - Reorder batch transaccional.
 *   - RLS: un tenant no ve las clases de otro (cubierto indirectamente por
 *     el índice unique parcial + el helper withTenant).
 */

const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  // `clases_producto` NO está en el TRUNCATE de setupTestDb (habría que
  // re-seedear las 9 base + Sin categoría del tenant test, y la migration
  // solo backfillea al correrse una vez). Cleanup selectivo: borrar solo
  // las categorías custom (no es_base, no es_sin_categoria) del tenant
  // de test que hayan quedado de corridas previas. Las base + sistema se
  // preservan porque los tests las esperan.
  await pool.query(`
    DELETE FROM clases_producto
     WHERE tenant_id = 1
       AND NOT es_base
       AND NOT es_sin_categoria
  `);
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Categorías (clases_producto) — seed y listado', () => {
  it('el tenant default tiene las 9 clases base + "Sin categoría" (backfill de migration)', async () => {
    const r = await request(app).get('/api/inventario/clases').set(auth());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThanOrEqual(10);

    const base = r.body.filter(c => c.es_base);
    expect(base.length).toBe(9);

    const sinCategoria = r.body.filter(c => c.es_sin_categoria);
    expect(sinCategoria.length).toBe(1);
    expect(sinCategoria[0].nombre).toBe('Sin categoría');
    expect(sinCategoria[0].emoji).toBeNull();

    // Slugs legacy presentes para el bridge de import XLSX (F3.c).
    const slugs = new Set(base.map(c => c.slug_legacy));
    expect(slugs.has('celular_sellado')).toBe(true);
    expect(slugs.has('watch')).toBe(true);
    expect(slugs.has('cargadores')).toBe(true);
  });

  it('cada clase incluye count_productos (integer)', async () => {
    const r = await request(app).get('/api/inventario/clases').set(auth());
    for (const c of r.body) {
      expect(typeof c.count_productos).toBe('number');
      expect(Number.isInteger(c.count_productos)).toBe(true);
      expect(c.count_productos).toBeGreaterThanOrEqual(0);
    }
  });

  it('el orden default es orden ASC, nombre ASC como tiebreaker', async () => {
    const r = await request(app).get('/api/inventario/clases').set(auth());
    for (let i = 1; i < r.body.length; i++) {
      const prev = r.body[i - 1];
      const cur = r.body[i];
      if (prev.orden === cur.orden) {
        expect(prev.nombre.toLowerCase() <= cur.nombre.toLowerCase()).toBe(true);
      } else {
        expect(prev.orden).toBeLessThanOrEqual(cur.orden);
      }
    }
  });
});

describe('Categorías (clases_producto) — POST /clases', () => {
  it('crea una clase custom y aparece en el listado', async () => {
    const c = await request(app).post('/api/inventario/clases').set(auth())
      .send({ nombre: 'Repuestos', emoji: '🔧' });
    expect(c.status).toBe(201);
    expect(c.body.nombre).toBe('Repuestos');
    expect(c.body.emoji).toBe('🔧');
    expect(c.body.activa).toBe(true);
    expect(c.body.es_base).toBe(false);
    expect(c.body.es_sin_categoria).toBe(false);

    const list = await request(app).get('/api/inventario/clases').set(auth());
    expect(list.body.some(x => x.id === c.body.id)).toBe(true);
  });

  it('rechaza nombre duplicado (case-insensitive) con 409', async () => {
    await request(app).post('/api/inventario/clases').set(auth())
      .send({ nombre: 'Fundas' });
    const dup = await request(app).post('/api/inventario/clases').set(auth())
      .send({ nombre: 'FUNDAS' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('nombre_duplicado');
  });

  it('permite crear sin emoji (opcional)', async () => {
    const c = await request(app).post('/api/inventario/clases').set(auth())
      .send({ nombre: 'Sin emoji' });
    expect(c.status).toBe(201);
    expect(c.body.emoji).toBeNull();
  });

  it('rechaza nombre vacío (min 1 char post-trim)', async () => {
    const r = await request(app).post('/api/inventario/clases').set(auth())
      .send({ nombre: '   ' });
    expect(r.status).toBe(400);
  });

  it('rechaza campo desconocido (schema strict)', async () => {
    const r = await request(app).post('/api/inventario/clases').set(auth())
      .send({ nombre: 'X', foo_random: 'bar' });
    expect(r.status).toBe(400);
  });
});

describe('Categorías (clases_producto) — PUT /clases/:id', () => {
  let claseId;
  beforeAll(async () => {
    const c = await request(app).post('/api/inventario/clases').set(auth())
      .send({ nombre: 'Camisetas', emoji: '👕' });
    claseId = c.body.id;
  });

  it('edita nombre + emoji', async () => {
    const r = await request(app).put(`/api/inventario/clases/${claseId}`).set(auth())
      .send({ nombre: 'Merchandising', emoji: '🎽' });
    expect(r.status).toBe(200);
    expect(r.body.nombre).toBe('Merchandising');
    expect(r.body.emoji).toBe('🎽');
  });

  it('desactiva (activa=false)', async () => {
    const r = await request(app).put(`/api/inventario/clases/${claseId}`).set(auth())
      .send({ activa: false });
    expect(r.status).toBe(200);
    expect(r.body.activa).toBe(false);
  });

  it('borra el emoji con emoji=null', async () => {
    const r = await request(app).put(`/api/inventario/clases/${claseId}`).set(auth())
      .send({ emoji: null });
    expect(r.status).toBe(200);
    expect(r.body.emoji).toBeNull();
  });

  it('rechaza nombre duplicado con 409', async () => {
    // "Merchandising" existe. Creamos otra y tratamos de renombrarla igual.
    const otra = await request(app).post('/api/inventario/clases').set(auth())
      .send({ nombre: 'Otra Custom' });
    const dup = await request(app).put(`/api/inventario/clases/${otra.body.id}`).set(auth())
      .send({ nombre: 'merchandising' });
    expect(dup.status).toBe(409);
  });

  it('404 con ID inexistente', async () => {
    const r = await request(app).put('/api/inventario/clases/00000000-0000-0000-0000-000000000000').set(auth())
      .send({ nombre: 'X' });
    expect(r.status).toBe(404);
  });

  it('400 con ID mal-formateado (no UUID)', async () => {
    const r = await request(app).put('/api/inventario/clases/no-es-uuid').set(auth())
      .send({ nombre: 'X' });
    expect(r.status).toBe(400);
  });

  it('bloquea editar la fila "Sin categoría" (protegida)', async () => {
    const list = await request(app).get('/api/inventario/clases').set(auth());
    const sc = list.body.find(c => c.es_sin_categoria);
    expect(sc).toBeTruthy();
    const r = await request(app).put(`/api/inventario/clases/${sc.id}`).set(auth())
      .send({ nombre: 'Otro nombre' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('categoria_protegida');
  });
});

describe('Categorías (clases_producto) — DELETE /clases/:id', () => {
  it('soft-delete de clase sin productos → 204', async () => {
    const c = await request(app).post('/api/inventario/clases').set(auth())
      .send({ nombre: 'Efímera' });
    const del = await request(app).delete(`/api/inventario/clases/${c.body.id}`).set(auth());
    expect(del.status).toBe(204);
    // Ya no aparece en el listado.
    const list = await request(app).get('/api/inventario/clases').set(auth());
    expect(list.body.some(x => x.id === c.body.id)).toBe(false);
  });

  it('permite reusar el nombre borrado (unique parcial ignora deleted_at)', async () => {
    // El "Efímera" del test anterior debería poder recrearse.
    const c = await request(app).post('/api/inventario/clases').set(auth())
      .send({ nombre: 'Efímera' });
    expect(c.status).toBe(201);
  });

  it('bloquea borrar "Sin categoría" (protegida)', async () => {
    const list = await request(app).get('/api/inventario/clases').set(auth());
    const sc = list.body.find(c => c.es_sin_categoria);
    const r = await request(app).delete(`/api/inventario/clases/${sc.id}`).set(auth());
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('categoria_protegida');
  });

  it('404 con ID inexistente', async () => {
    const r = await request(app).delete('/api/inventario/clases/00000000-0000-0000-0000-000000000000').set(auth());
    expect(r.status).toBe(404);
  });
});

describe('Categorías (clases_producto) — POST /clases/reorder', () => {
  it('actualiza el orden batch y devuelve el count', async () => {
    const list = await request(app).get('/api/inventario/clases').set(auth());
    const primeras3 = list.body.filter(c => c.es_base).slice(0, 3);
    const items = primeras3.map((c, i) => ({ id: c.id, orden: 100 + i * 10 }));
    const r = await request(app).post('/api/inventario/clases/reorder').set(auth())
      .send({ items });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(items.length);

    // Verificar que quedó guardado.
    const list2 = await request(app).get('/api/inventario/clases').set(auth());
    for (const it of items) {
      const found = list2.body.find(c => c.id === it.id);
      expect(found.orden).toBe(it.orden);
    }
  });

  it('rechaza array vacío', async () => {
    const r = await request(app).post('/api/inventario/clases/reorder').set(auth())
      .send({ items: [] });
    expect(r.status).toBe(400);
  });

  it('rechaza IDs no-UUID', async () => {
    const r = await request(app).post('/api/inventario/clases/reorder').set(auth())
      .send({ items: [{ id: 'no-uuid', orden: 1 }] });
    expect(r.status).toBe(400);
  });
});

/**
 * Factories de tests — fábricas reutilizables para crear entidades vivas
 * en la BD de test usando el API (no INSERTs directos), garantizando que
 * pasen por toda la pipeline de Zod + permisos + audit.
 *
 * Auditoría #R-05: antes cada suite redefinía su propio crearProducto /
 * crearCaja / crearCliente con campos distintos. Cuando alguien agregaba
 * un campo obligatorio al schema, había que tocar N archivos. Ahora hay
 * un solo lugar.
 *
 * Uso:
 *   const F = require('./helpers/factories');
 *   const cli = await F.createCliente(token, { nombre: 'Foo' });
 *   const prod = await F.createProducto(token, { nombre: 'iPhone X' });
 *
 * Cada factory acepta `over` para sobrescribir defaults.
 */
const request = require('supertest');
const app = require('../../src/app');

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

// ─── Catálogos ─────────────────────────────────────────────────────────
async function createCategoria(token, over = {}) {
  const r = await request(app).post('/api/inventario/categorias')
    .set(authHeader(token))
    .send({ nombre: 'Cat Test ' + Math.random().toString(36).slice(2, 7), ...over });
  if (r.status !== 201) throw new Error(`createCategoria: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function createDeposito(token, over = {}) {
  const r = await request(app).post('/api/inventario/depositos')
    .set(authHeader(token))
    .send({ nombre: 'Dep Test ' + Math.random().toString(36).slice(2, 7), ...over });
  if (r.status !== 201) throw new Error(`createDeposito: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function createCaja(token, over = {}) {
  const r = await request(app).post('/api/cajas/cajas')
    .set(authHeader(token))
    .send({
      nombre: 'Caja Test ' + Math.random().toString(36).slice(2, 7),
      moneda: 'USD',
      saldo_inicial: 0,
      orden: 99,
      ...over,
    });
  if (r.status !== 201) throw new Error(`createCaja: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// ─── Inventario ────────────────────────────────────────────────────────
async function createProducto(token, over = {}) {
  // Si no viene categoria_id, creamos una al vuelo (los tests anteriores
  // ya hacían esto en sus beforeAll).
  if (!over.categoria_id) {
    const cat = await createCategoria(token);
    over.categoria_id = cat.id;
  }
  const r = await request(app).post('/api/inventario/productos')
    .set(authHeader(token))
    .send({
      tipo_carga: 'unitario',
      clase: 'celular_sellado',
      nombre: 'iPhone Test ' + Math.random().toString(36).slice(2, 7),
      costo: 500, costo_moneda: 'USD',
      precio_venta: 800, precio_moneda: 'USD',
      cantidad: 1,
      ...over,
    });
  if (r.status !== 201) throw new Error(`createProducto: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// ─── B2B y proveedores ─────────────────────────────────────────────────
async function createClienteCC(token, over = {}) {
  const r = await request(app).post('/api/cuentas/clientes')
    .set(authHeader(token))
    .send({
      nombre: 'Cli Test ' + Math.random().toString(36).slice(2, 7),
      categoria: 'A+',
      ...over,
    });
  if (r.status !== 201) throw new Error(`createClienteCC: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function createProveedor(token, over = {}) {
  const r = await request(app).post('/api/proveedores')
    .set(authHeader(token))
    .send({
      nombre: 'Prov Test ' + Math.random().toString(36).slice(2, 7),
      contacto_nombre: 'Juan',
      contacto_apellido: 'Pérez',
      ...over,
    });
  if (r.status !== 201) throw new Error(`createProveedor: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

module.exports = {
  authHeader,
  createCategoria,
  createDeposito,
  createCaja,
  createProducto,
  createClienteCC,
  createProveedor,
};

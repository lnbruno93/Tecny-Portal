import { describe, it, expect } from 'vitest';
import { mapStockRows, normHeader, parseNum, extractNewCatalogos } from './importStock';

// Encabezados reales del negocio (con aclaraciones entre paréntesis).
const HEADERS = ['Nombre', 'GB(solo iph)', 'BATERIA(solo iph)', 'COLOR(solo iph)', 'COSTO',
  'MONEDA COSTO(ARS/USD)', 'PRECIO', 'MONEDA PRECIO(ARS/USD)', 'IMEI(solo iph)',
  'TIPO(unitario, stock)', 'CATEGORIA', 'PROVEEDOR', 'STOCK(solo acc)', 'ID DEPOSITO(SÓLO NÚMERO)'];

const ctx = {
  categorias: [{ id: 11, nombre: 'iPhone Nuevo' }, { id: 12, nombre: 'Fundas' }],
  depositos: [{ id: 1, nombre: 'Principal' }, { id: 2, nombre: 'Local Centro' }],
};

describe('normHeader', () => {
  it('descarta aclaraciones entre paréntesis', () => {
    expect(normHeader('GB(solo iph)')).toBe('gb');
    expect(normHeader('MONEDA COSTO(ARS/USD)')).toBe('monedacosto');
    expect(normHeader('STOCK(solo acc)')).toBe('stock');
    expect(normHeader('ID DEPOSITO(SÓLO NÚMERO)')).toBe('iddeposito');
  });
});

describe('parseNum', () => {
  it('tolera símbolos, miles y coma decimal y el .0 de Excel', () => {
    expect(parseNum('390.0')).toBe(390);
    expect(parseNum('u$s 1.350')).toBe(1350);
    expect(parseNum('$ 1.350,50')).toBe(1350.5);
    expect(parseNum('')).toBe(0);
    expect(parseNum(null)).toBe(0);
  });
});

describe('mapStockRows', () => {
  it('celular: fila con IMEI y sin STOCK → unitario, cantidad 1, gb limpio', () => {
    const rows = [HEADERS,
      ['iPhone 17 Pro Max', '256.0', '100.0', 'Silver', '1350.0', 'USD', '1390.0', 'USD',
       '355224256215887', 'Unitario', 'iPhone Nuevo', 'Lantronica']]; // sin STOCK ni ID DEP
    const [{ body, error }] = mapStockRows(rows, ctx);
    expect(error).toBeNull();
    expect(body.clase).toBe('celular');
    expect(body.tipo_carga).toBe('unitario');
    expect(body.cantidad).toBe(1);
    expect(body.imei).toBe('355224256215887');
    expect(body.gb).toBe('256');
    expect(body.bateria).toBe(100);
    expect(body.costo).toBe(1350);
    expect(body.precio_venta).toBe(1390);
    expect(body.categoria_id).toBe(11);
    expect(body.deposito_id).toBeNull();
  });

  it('accesorio: fila con STOCK → lote, cantidad = STOCK, depósito por ID', () => {
    const rows = [HEADERS,
      ['Funda Silicona', '', '', '', '5', 'USD', '12', 'USD', '', 'stock', 'Fundas', 'MayorAcc', '20', '2']];
    const [{ body, error }] = mapStockRows(rows, ctx);
    expect(error).toBeNull();
    expect(body.clase).toBe('accesorio');
    expect(body.tipo_carga).toBe('lote');
    expect(body.cantidad).toBe(20);
    expect(body.deposito_id).toBe(2);
    expect(body.imei).toBeNull();
  });

  it('moneda ARS se respeta en costo y precio', () => {
    const rows = [HEADERS,
      ['Cargador', '', '', '', '5000', 'ARS', '9000', 'ARS', '', 'stock', 'Fundas', 'X', '3', '1']];
    const [{ body }] = mapStockRows(rows, ctx);
    expect(body.costo_moneda).toBe('ARS');
    expect(body.precio_moneda).toBe('ARS');
  });

  it('bloquea filas con costo o precio en 0 (rompen ventas/valorizado)', () => {
    const rows = [HEADERS,
      ['iPhone sin costo', '128', '90', 'Black', '0', 'USD', '900', 'USD', '111', 'Unitario', 'iPhone Nuevo', 'P'],
      ['iPhone sin precio', '128', '90', 'Black', '800', 'USD', '0', 'USD', '222', 'Unitario', 'iPhone Nuevo', 'P']];
    const res = mapStockRows(rows, ctx);
    expect(res[0].error).toMatch(/costo/i);
    expect(res[1].error).toMatch(/precio/i);
  });

  it('marca error si el ID de depósito no existe (evita romper el FK)', () => {
    const rows = [HEADERS,
      ['Funda', '', '', '', '5', 'USD', '12', 'USD', '', 'stock', 'Fundas', 'X', '4', '999']];
    const [{ error }] = mapStockRows(rows, ctx);
    expect(error).toMatch(/Depósito ID 999/);
  });

  it('ignora filas totalmente vacías y exige nombre', () => {
    const rows = [HEADERS,
      ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['', '', '', '', '100', 'USD', '200', 'USD', '333', 'Unitario', 'iPhone Nuevo', 'P']];
    const res = mapStockRows(rows, ctx);
    expect(res).toHaveLength(1);           // la fila vacía se descarta
    expect(res[0].error).toBe('Falta el nombre');
  });

  it('compat: encabezados limpios de la plantilla CSV', () => {
    const rows = [
      ['nombre', 'clase', 'categoria', 'costo', 'costo_moneda', 'precio_venta', 'precio_moneda', 'imei', 'cantidad'],
      ['iPhone 15', 'celular', 'iPhone Nuevo', '800', 'USD', '950', 'USD', '356938035643809', '']];
    const [{ body, error }] = mapStockRows(rows, ctx);
    expect(error).toBeNull();
    expect(body.nombre).toBe('iPhone 15');
    expect(body.costo).toBe(800);
    expect(body.precio_venta).toBe(950);
    expect(body.categoria_id).toBe(11); // ctx categorías incluye 'iPhone Nuevo' id 11
  });

  it('bloquea filas sin categoría (la queremos siempre para análisis posterior)', () => {
    const rows = [HEADERS,
      ['iPhone sin cat', '128', '90', 'Black', '800', 'USD', '900', 'USD', '111', 'Unitario', '', 'P']];
    const [{ error }] = mapStockRows(rows, ctx);
    expect(error).toMatch(/categor/i);
  });

  // Junio 2026: si la categoría no existe ya NO es error — se marca para
  // auto-create. El caller (Inventario.jsx confirmImport) la crea antes del bulk.
  it('si la categoría no existe, NO es error y se marca como _categoriaNueva', () => {
    const rows = [HEADERS,
      ['iPhone X', '128', '90', 'Black', '800', 'USD', '900', 'USD', '111', 'Unitario', 'Categoria Fantasma', 'P']];
    const [{ error, _categoriaNueva, body }] = mapStockRows(rows, ctx);
    expect(error).toBeNull();
    expect(_categoriaNueva).toBe('Categoria Fantasma');
    expect(body.categoria_id).toBeNull(); // se completa después del create
  });

  it('match case-insensitive contra categorías existentes (no duplica por mayúsculas)', () => {
    const ctxCustom = { categorias: [{ id: 7, nombre: 'iPhone Nuevo' }], depositos: [] };
    const rows = [HEADERS,
      ['iPhone X', '128', '90', 'Black', '800', 'USD', '900', 'USD', '111', 'Unitario', 'IPHONE NUEVO', 'P']];
    const [{ error, _categoriaNueva, body }] = mapStockRows(rows, ctxCustom);
    expect(error).toBeNull();
    expect(_categoriaNueva).toBeNull(); // matcheó la existente, no se crea otra
    expect(body.categoria_id).toBe(7);
  });

  it('proveedor nuevo se marca con _proveedorNuevo (case-insensitive)', () => {
    const ctxCustom = {
      categorias: [{ id: 1, nombre: 'iPhone' }],
      depositos: [],
      proveedores: [{ id: 9, nombre: 'Francisco de la Torre' }],
    };
    const rows = [HEADERS,
      ['iPhone X', '128', '90', 'Black', '800', 'USD', '900', 'USD', '111', 'Unitario', 'iPhone', 'Proveedor Nuevo'],
      ['iPhone Y', '256', '95', 'White', '900', 'USD', '1100', 'USD', '222', 'Unitario', 'iPhone', 'francisco de la torre']]; // case-insensitive match
    const [r1, r2] = mapStockRows(rows, ctxCustom);
    expect(r1._proveedorNuevo).toBe('Proveedor Nuevo');
    expect(r2._proveedorNuevo).toBeNull(); // matcheó "Francisco de la Torre" case-insensitive
  });
});

describe('extractNewCatalogos', () => {
  it('extrae nombres únicos de categorías y proveedores nuevos (case-insensitive)', () => {
    const mapped = [
      { _categoriaNueva: 'iPhone Pro', _proveedorNuevo: 'Distri A' },
      { _categoriaNueva: 'IPHONE PRO', _proveedorNuevo: 'Distri B' }, // duplicado de cat
      { _categoriaNueva: 'Accesorios', _proveedorNuevo: 'distri a' }, // duplicado de prov
      { _categoriaNueva: null, _proveedorNuevo: null },
    ];
    const { categorias, proveedores } = extractNewCatalogos(mapped);
    expect(categorias).toEqual(['iPhone Pro', 'Accesorios']); // primera aparición preserva caps
    expect(proveedores).toEqual(['Distri A', 'Distri B']);
  });

  it('lista vacía si no hay catálogos nuevos', () => {
    const mapped = [
      { _categoriaNueva: null, _proveedorNuevo: null },
      { _categoriaNueva: null, _proveedorNuevo: null },
    ];
    expect(extractNewCatalogos(mapped)).toEqual({ categorias: [], proveedores: [] });
  });
});

import { describe, it, expect } from 'vitest';
import { mapStockRows, normHeader, parseNum } from './importStock';

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
      ['nombre', 'clase', 'costo', 'costo_moneda', 'precio_venta', 'precio_moneda', 'imei', 'cantidad'],
      ['iPhone 15', 'celular', '800', 'USD', '950', 'USD', '356938035643809', '']];
    const [{ body, error }] = mapStockRows(rows, ctx);
    expect(error).toBeNull();
    expect(body.nombre).toBe('iPhone 15');
    expect(body.costo).toBe(800);
    expect(body.precio_venta).toBe(950);
  });
});

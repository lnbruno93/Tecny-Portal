import { describe, it, expect } from 'vitest';
import { mapStockRows, normHeader, parseNum, extractNewCatalogos, groupRowsByProveedor, buildBulkMovimientosPayload, findDuplicateImeis, cleanImei } from './importStock';

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

describe('cleanImei', () => {
  // Bug reportado por Lucas 2026-07-07: el picker de productos no encontraba
  // productos por sufijo de IMEI porque el XLSX importado guardaba el número
  // en notación científica ("3.5342733941411E14") en vez del string de 15
  // dígitos que el operador ve en pantalla.
  it('normaliza notación científica de 15 dígitos', () => {
    // Excel/Sheets emite el 0 trailing como parte del número aunque no lo
    // muestre en el <v> científico. Number() lo reconstruye.
    expect(cleanImei('3.5342733941411E14')).toBe('353427339414110');
    expect(cleanImei('3.51668142411E14')).toBe('351668142411000');
    expect(cleanImei('1.23E15')).toBe('1230000000000000');
    expect(cleanImei('3.5E+14')).toBe('350000000000000');
  });
  it('IMEI ya limpio pasa sin cambio (idempotente)', () => {
    expect(cleanImei('353427339414110')).toBe('353427339414110');
    expect(cleanImei('  355224256215887  ')).toBe('355224256215887');
  });
  it('serial alfanumérico (ej. AirPods) pasa sin cambio', () => {
    expect(cleanImei('SJW0KF7C5P6')).toBe('SJW0KF7C5P6');
  });
  it('vacío o null → ""', () => {
    expect(cleanImei('')).toBe('');
    expect(cleanImei(null)).toBe('');
    expect(cleanImei(undefined)).toBe('');
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

  it('IMEI en notación científica se normaliza al mapear (bug picker 2026-07-07)', () => {
    // Excel emite "353427339414110" como "3.5342733941411E14" en el <v> del XML
    // porque su motor de números trata IMEIs de 15 dígitos como float. Sin
    // el fix, el string entraba en DB así y la búsqueda ILIKE "%4110%" no
    // matcheaba (root cause del dropdown vacío del picker).
    const rows = [HEADERS,
      ['iPhone 17 Pro Max', '256', '87', 'Cosmic Orange', '1200', 'USD', '1350', 'USD',
       '3.5342733941411E14', 'Unitario', 'iPhone Nuevo', 'P']];
    const [{ body, error }] = mapStockRows(rows, ctx);
    expect(error).toBeNull();
    expect(body.imei).toBe('353427339414110');
  });

  it('accesorio: fila con STOCK → lote, cantidad = STOCK, depósito por ID', () => {
    const rows = [HEADERS,
      ['Funda Silicona', '', '', '', '5', 'USD', '12', 'USD', '', 'stock', 'Fundas', 'MayorAcc', '20', '2']];
    const [{ body, error }] = mapStockRows(rows, ctx);
    expect(error).toBeNull();
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

  // Julio 2026: accesorio con stock=0 es intencional (dar de alta un modelo
  // antes de recibir mercadería). Antes era error bloqueante; ahora pasa como
  // warning informativo y la fila se importa igual.
  it('accesorio con stock=0 → warning (no error), la fila se importa', () => {
    const rows = [HEADERS,
      ['Funda modelo nuevo', '', '', '', '5', 'USD', '12', 'USD', '', 'stock', 'Fundas', 'MayorAcc', '0', '1']];
    const [{ body, error, warning }] = mapStockRows(rows, ctx);
    expect(error).toBeNull();
    expect(warning).toMatch(/stock en 0/i);
    expect(body.cantidad).toBe(0);
  });

  it('accesorio con stock=0 pasa a groupRowsByProveedor (no lo descarta)', () => {
    const rows = [HEADERS,
      ['Vidrio nuevo', '', '', '', '3', 'USD', '8', 'USD', '', 'stock', 'Fundas', 'ProveedorX', '0', '1']];
    const mapped = mapStockRows(rows, ctx);
    const grupos = groupRowsByProveedor(mapped);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].proveedor).toBe('ProveedorX');
    expect(grupos[0].rows).toHaveLength(1);
    expect(grupos[0].rows[0].warning).toMatch(/stock en 0/i);
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

describe('groupRowsByProveedor', () => {
  // Helper para crear una "fila mapeada" de forma compacta en los tests.
  const row = (proveedor, nombre = 'item', error = null) => ({
    body: { proveedor, nombre },
    error,
  });

  it('agrupa filas por proveedor preservando el orden de primera aparición', () => {
    const mapped = [
      row('Distri A', 'iPhone 1'),
      row('Distri B', 'Samsung 1'),
      row('Distri A', 'iPhone 2'),
      row('Distri C', 'Xiaomi 1'),
      row('Distri B', 'Samsung 2'),
    ];
    const groups = groupRowsByProveedor(mapped);
    expect(groups.map(g => g.proveedor)).toEqual(['Distri A', 'Distri B', 'Distri C']);
    expect(groups[0].rows.map(r => r.body.nombre)).toEqual(['iPhone 1', 'iPhone 2']);
    expect(groups[1].rows.map(r => r.body.nombre)).toEqual(['Samsung 1', 'Samsung 2']);
    expect(groups[2].rows.map(r => r.body.nombre)).toEqual(['Xiaomi 1']);
  });

  it('agrupa case-insensitive (preserva la primera capitalización vista)', () => {
    const mapped = [
      row('Distri A', '1'),
      row('DISTRI A', '2'),
      row('  distri a  ', '3'),  // espacios extra: se trimean
    ];
    const groups = groupRowsByProveedor(mapped);
    expect(groups).toHaveLength(1);
    expect(groups[0].proveedor).toBe('Distri A');
    expect(groups[0].rows).toHaveLength(3);
  });

  it('ignora filas con error (no entran en ningún grupo)', () => {
    const mapped = [
      row('Distri A', 'ok'),
      row('Distri A', 'malo', 'Costo en 0'),
      row('Distri B', 'ok2'),
    ];
    const groups = groupRowsByProveedor(mapped);
    expect(groups).toHaveLength(2);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0].body.nombre).toBe('ok');
  });

  it('filas sin proveedor van al grupo especial (proveedor=null)', () => {
    const mapped = [
      row('Distri A', '1'),
      row('', 'sin_prov_1'),
      row(null, 'sin_prov_2'),
      row(undefined, 'sin_prov_3'),
    ];
    const groups = groupRowsByProveedor(mapped);
    expect(groups).toHaveLength(2);
    expect(groups[0].proveedor).toBe('Distri A');
    expect(groups[1].proveedor).toBeNull();
    expect(groups[1].rows).toHaveLength(3);
  });

  it('devuelve [] para input vacío o no-array', () => {
    expect(groupRowsByProveedor([])).toEqual([]);
    expect(groupRowsByProveedor(null)).toEqual([]);
    expect(groupRowsByProveedor(undefined)).toEqual([]);
  });
});

describe('buildBulkMovimientosPayload', () => {
  // Factory de un grupo "razonable" para los tests.
  const mkGroup = (over = {}) => ({
    key: 'g_0',
    proveedor_label: 'Distri A',
    proveedor_id: 42,
    proveedor_nuevo: '',
    fecha: '2026-06-14',
    monto: '1450',
    moneda: 'USD',
    tc: '',
    caja_id: '',
    rows: [{
      body: {
        nombre: 'iPhone 15 Pro',
        clase: 'celular', tipo_carga: 'unitario', estado: 'disponible',
        imei: '356789012345671', gb: '256', color: 'Titanio Natural',
        categoria_id: 11, deposito_id: null, proveedor: 'Distri A',
        costo: 1450, costo_moneda: 'USD',
        precio_venta: 1650, precio_moneda: 'USD',
        cantidad: 1,
      },
      error: null, _categoriaNueva: null, _proveedorNuevo: null,
    }],
    ...over,
  });

  it('happy path: grupo único USD → 1 movimiento con item correcto', () => {
    const movs = buildBulkMovimientosPayload({ groups: [mkGroup()] });
    expect(movs).toHaveLength(1);
    const m = movs[0];
    expect(m).toMatchObject({
      proveedor_id: 42, fecha: '2026-06-14', tipo: 'compra',
      monto: 1450, moneda: 'USD', tc: null, caja_id: null,
    });
    expect(m.items).toHaveLength(1);
    const it = m.items[0];
    expect(it.imei_serial).toBe('356789012345671');
    expect(it.tamano).toBe('256');
    expect(it.color).toBe('Titanio Natural');
    expect(it.valor).toBe(1450);  // USD * cantidad 1
    // El item embebe el producto_stock SIN el campo proveedor (lo rellena el backend #H-06)
    expect(it.producto_stock).toBeDefined();
    expect(it.producto_stock).not.toHaveProperty('proveedor');
    expect(it.producto_stock.imei).toBe('356789012345671');
  });

  it('valor: cantidad>1 multiplica el costo USD; ARS deja valor en null', () => {
    const usdMulti = mkGroup({
      rows: [{ body: {
        nombre: 'Funda', clase: 'accesorio', tipo_carga: 'lote',
        costo: 5, costo_moneda: 'USD', cantidad: 100, categoria_id: 12,
      }, error: null, _categoriaNueva: null }],
    });
    const ars = mkGroup({
      rows: [{ body: {
        nombre: 'Cargador', clase: 'accesorio', tipo_carga: 'lote',
        costo: 8000, costo_moneda: 'ARS', cantidad: 50, categoria_id: 12,
      }, error: null, _categoriaNueva: null }],
    });
    const [mUsd] = buildBulkMovimientosPayload({ groups: [usdMulti] });
    const [mArs] = buildBulkMovimientosPayload({ groups: [ars] });
    expect(mUsd.items[0].valor).toBe(500);   // 5 * 100
    expect(mArs.items[0].valor).toBeNull();  // no asumimos TC
  });

  it('resuelve proveedor_id desde provIdByName si el grupo trae proveedor_nuevo', () => {
    const g = mkGroup({
      proveedor_id: '',                  // no preexistente
      proveedor_nuevo: 'Distri Nueva',   // se va a crear
    });
    const provIdByName = new Map([['distri nueva', 999]]);
    const [m] = buildBulkMovimientosPayload({ groups: [g], provIdByName });
    expect(m.proveedor_id).toBe(999);
  });

  it('reconcilia categoria_id si la categoría era nueva (newCatByName)', () => {
    const g = mkGroup({
      rows: [{
        body: { nombre: 'X', categoria_id: null, costo: 100, costo_moneda: 'USD', cantidad: 1 },
        error: null,
        _categoriaNueva: 'Accesorios Especiales',
      }],
    });
    const newCatByName = new Map([['accesorios especiales', 777]]);
    const [m] = buildBulkMovimientosPayload({ groups: [g], newCatByName });
    expect(m.items[0].producto_stock.categoria_id).toBe(777);
  });

  it('moneda ARS: TC se incluye, caja_id se castea a number', () => {
    const g = mkGroup({
      monto: '2000000', moneda: 'ARS', tc: '1000', caja_id: '7',
    });
    const [m] = buildBulkMovimientosPayload({ groups: [g] });
    expect(m.moneda).toBe('ARS');
    expect(m.tc).toBe(1000);
    expect(m.caja_id).toBe(7);
  });

  it('throws con mensaje claro si un grupo no tiene proveedor_id ni nuevo resoluble', () => {
    const g = mkGroup({ proveedor_id: '', proveedor_nuevo: '', proveedor_label: 'Distri Huerfana' });
    expect(() => buildBulkMovimientosPayload({ groups: [g] }))
      .toThrow(/Distri Huerfana/);
  });

  it('multi-proveedor: arma un movimiento por grupo', () => {
    const g1 = mkGroup({ key: 'g_0', proveedor_id: 1, proveedor_label: 'A' });
    const g2 = mkGroup({ key: 'g_1', proveedor_id: 2, proveedor_label: 'B' });
    const movs = buildBulkMovimientosPayload({ groups: [g1, g2] });
    expect(movs.map(m => m.proveedor_id)).toEqual([1, 2]);
  });

  it('devuelve [] si groups es vacío/no-array', () => {
    expect(buildBulkMovimientosPayload({ groups: [] })).toEqual([]);
    expect(buildBulkMovimientosPayload({})).toEqual([]);
  });
});

// 2026-06-30 #imei-dup: helper que detecta IMEIs duplicados DENTRO de un
// set de filas del XLSX. Acepta tanto el shape de mapStockRows (con .body)
// como un shape plano.
describe('findDuplicateImeis', () => {
  it('0 duplicados → array vacío', () => {
    const rows = [
      { body: { imei: '111111111111111' } },
      { body: { imei: '222222222222222' } },
      { body: { imei: '333333333333333' } },
    ];
    expect(findDuplicateImeis(rows)).toEqual([]);
  });

  it('1 IMEI repetido 2 veces → 1 entry con 2 rowIndices', () => {
    const rows = [
      { body: { imei: '111111111111111' } }, // 0
      { body: { imei: '999999999999999' } }, // 1
      { body: { imei: '111111111111111' } }, // 2
    ];
    const dups = findDuplicateImeis(rows);
    expect(dups).toHaveLength(1);
    expect(dups[0].imei).toBe('111111111111111');
    expect(dups[0].rowIndices).toEqual([0, 2]);
  });

  it('filas sin IMEI (accesorios) → ignoradas', () => {
    const rows = [
      { body: { imei: '' } },          // 0 — accesorio
      { body: { imei: null } },        // 1 — accesorio
      { body: { imei: undefined } },   // 2 — accesorio
      { body: { imei: '111111111111111' } }, // 3
      { body: { imei: '111111111111111' } }, // 4 — dup con 3
    ];
    const dups = findDuplicateImeis(rows);
    expect(dups).toHaveLength(1);
    expect(dups[0].rowIndices).toEqual([3, 4]);
  });

  it('2 IMEIs distintos repetidos → 2 entries', () => {
    const rows = [
      { body: { imei: '111111111111111' } }, // 0
      { body: { imei: '222222222222222' } }, // 1
      { body: { imei: '111111111111111' } }, // 2 — dup A
      { body: { imei: '333333333333333' } }, // 3
      { body: { imei: '222222222222222' } }, // 4 — dup B
      { body: { imei: '111111111111111' } }, // 5 — dup A (3 ya)
    ];
    const dups = findDuplicateImeis(rows);
    expect(dups).toHaveLength(2);
    const byImei = Object.fromEntries(dups.map(d => [d.imei, d.rowIndices]));
    expect(byImei['111111111111111']).toEqual([0, 2, 5]);
    expect(byImei['222222222222222']).toEqual([1, 4]);
  });

  it('trim de IMEI tolera espacios accidentales (Excel)', () => {
    const rows = [
      { body: { imei: '  111111111111111  ' } }, // 0
      { body: { imei: '111111111111111' } },     // 1 — dup post-trim
    ];
    const dups = findDuplicateImeis(rows);
    expect(dups).toHaveLength(1);
    expect(dups[0].imei).toBe('111111111111111');
    expect(dups[0].rowIndices).toEqual([0, 1]);
  });

  it('acepta shape plano ({ imei }) además del shape con .body', () => {
    const rows = [
      { imei: '111111111111111' },
      { imei: '111111111111111' },
    ];
    const dups = findDuplicateImeis(rows);
    expect(dups).toHaveLength(1);
    expect(dups[0].rowIndices).toEqual([0, 1]);
  });

  it('devuelve [] si rows no es array', () => {
    expect(findDuplicateImeis(null)).toEqual([]);
    expect(findDuplicateImeis(undefined)).toEqual([]);
    expect(findDuplicateImeis('foo')).toEqual([]);
  });

  it('devuelve [] para array vacío', () => {
    expect(findDuplicateImeis([])).toEqual([]);
  });
});

// F3.c-2 (2026-07-09) — resolveClaseXlsx recibe `clases` del tenant y
// devuelve `clase_id` además del slug legacy. Cuando el import no matchea
// nada, cae a la fila `es_sin_categoria=true` del sistema.
describe('mapStockRows — F3.c-2 clase_id via clases del tenant', () => {
  const CATEGORIAS = [{ id: 1, nombre: 'Celulares' }];
  const CLASES = [
    { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', nombre: 'Watch',              emoji: '⌚', activa: true,  es_base: true,  es_sin_categoria: false, slug_legacy: 'watch' },
    { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', nombre: 'Celular Sellado',    emoji: '📲', activa: true,  es_base: true,  es_sin_categoria: false, slug_legacy: 'celular_sellado' },
    { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', nombre: 'Repuestos',          emoji: '🔧', activa: true,  es_base: false, es_sin_categoria: false, slug_legacy: null },
    { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', nombre: 'Sin categoría',                   activa: true,  es_base: false, es_sin_categoria: true,  slug_legacy: null },
    { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', nombre: 'Inactiva',           emoji: '💤', activa: false, es_base: false, es_sin_categoria: false, slug_legacy: null },
  ];
  const HEAD = ['nombre', 'categoria', 'costo', 'precio_venta', 'clase', 'cantidad'];
  const rowsWith = (clase, cantidad = 1) => [HEAD, ['iPhone 15', 'Celulares', 100, 200, clase, cantidad]];

  it('slug F1 estándar ("watch") → clase_id de la fila base es_base', () => {
    const [row] = mapStockRows(rowsWith('watch'), { categorias: CATEGORIAS, clases: CLASES });
    expect(row.body.clase_id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('nombre exacto de categoría custom del tenant ("Repuestos") → clase_id (sin slug_legacy)', () => {
    const [row] = mapStockRows(rowsWith('Repuestos'), { categorias: CATEGORIAS, clases: CLASES });
    expect(row.body.clase_id).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  it('alias legacy ("sellado") → clase_id de la fila base "celular_sellado"', () => {
    const [row] = mapStockRows(rowsWith('sellado'), { categorias: CATEGORIAS, clases: CLASES });
    expect(row.body.clase_id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  it('emoji leading + case-insensitive → normaliza y matchea', () => {
    // '⌚ WATCH' → strip emoji → 'WATCH' → lowercase → 'watch' → match
    const [row] = mapStockRows(rowsWith('⌚ WATCH'), { categorias: CATEGORIAS, clases: CLASES });
    expect(row.body.clase_id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('sin match ("Fundas de neopreno") → fallback a "Sin categoría" del sistema', () => {
    const [row] = mapStockRows(rowsWith('Fundas de neopreno'), { categorias: CATEGORIAS, clases: CLASES });
    expect(row.body.clase_id).toBe('dddddddd-dddd-dddd-dddd-dddddddddddd');
  });

  it('categoría inactiva NO matchea (aunque el nombre coincida)', () => {
    const [row] = mapStockRows(rowsWith('Inactiva'), { categorias: CATEGORIAS, clases: CLASES });
    // No matchea "Inactiva" (activa=false) → cae al fallback "Sin categoría".
    expect(row.body.clase_id).toBe('dddddddd-dddd-dddd-dddd-dddddddddddd');
  });

  it('sin `clases` en ctx → devuelve slug F1 heurístico y clase_id=null (compat, backend deriva)', () => {
    const [row] = mapStockRows(rowsWith('watch'), { categorias: CATEGORIAS });
    // Sin `clases` catálogo, el alias resuelve a slug pero clase_id queda null.
    // Backend deriva clase_id via resolveClaseAndClaseId (F3.c-1 #530).
    expect(row.body.clase_id).toBeNull();
  });

  it('celda `clase` vacía → fallback heurístico (con stock → accesorios_varios) + clase_id NULL', () => {
    // Sin columna clase, hasStock (5) → 'accesorios_varios' heurístico. Como
    // este CLASES de test no tiene accesorios_varios base, clase_id queda null.
    const [row] = mapStockRows([HEAD, ['iPhone 15', 'Celulares', 100, 200, '', 5]], { categorias: CATEGORIAS, clases: CLASES });
    expect(row.body.clase_id).toBeNull();
  });
});

// Mapeo de filas de planilla (CSV/XLSX) → productos para el importador de stock.
// Lógica pura (sin React) para poder testearla a fondo: la carga de stock es
// crítica — si entra mal, fallan las ventas y el valorizado del inventario.
//
// Tolera los encabezados reales del negocio, que traen aclaraciones entre
// paréntesis, ej: "GB(solo iph)", "MONEDA COSTO(ARS/USD)", "STOCK(solo acc)",
// "ID DEPOSITO(SÓLO NÚMERO)". Esas aclaraciones se descartan al normalizar.

// Normaliza un encabezado: descarta lo que está entre paréntesis, saca acentos,
// espacios y símbolos. "MONEDA COSTO(ARS/USD)" → "monedacosto".
export function normHeader(s) {
  return String(s ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Sinónimos aceptados por campo (ya normalizados con normHeader).
export const STOCK_ALIASES = {
  nombre:        ['nombre', 'modelo', 'producto'],
  clase:         ['clase'],
  tipo_carga:    ['tipo', 'tipocarga', 'carga'],
  estado:        ['estado'],
  imei:          ['imei', 'serie', 'nroserie', 'numeroserie'],
  gb:            ['gb', 'almacenamiento', 'capacidad'],
  color:         ['color'],
  bateria:       ['bateria', 'bat', 'salud', 'saludbateria'],
  categoria:     ['categoria', 'rubro'],
  deposito:      ['deposito', 'iddeposito', 'depositoid', 'sucursal'],
  proveedor:     ['proveedor'],
  costo:         ['costo', 'costos', 'compra', 'costounitario'],
  costo_moneda:  ['monedacosto', 'costomoneda'],
  precio_venta:  ['precio', 'precioventa', 'venta', 'preciodeventa', 'preciolista'],
  precio_moneda: ['monedaprecio', 'preciomoneda', 'monedaventa'],
  // STOCK(solo acc): cantidad de accesorios. Su presencia define clase=accesorio.
  cantidad:      ['stock', 'cantidad', 'qty', 'unidades'],
};

// Parseo de número tolerante: ignora símbolos ($, u$s), maneja coma decimal,
// separador de miles y el ".0" que mete Excel ("390.0" → 390).
export function parseNum(v) {
  let s = String(v ?? '').replace(/[^0-9.,-]/g, '').trim();
  if (!s) return 0;
  const hasC = s.includes(','), hasD = s.includes('.');
  if (hasC && hasD) {
    // El separador que aparece último es el decimal (cubre es-AR "1.350,50" y en-US "1,350.50").
    const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const tho = dec === ',' ? '.' : ',';
    s = s.split(tho).join('').replace(dec, '.');
  } else if (hasC || hasD) {
    const sep = hasC ? ',' : '.';
    const parts = s.split(sep);
    // Una sola aparición y la parte derecha NO tiene 3 dígitos → decimal ("390.0", "1350,50").
    // Si hay varias apariciones o el grupo es de 3 dígitos → separador de miles ("1.350", "1.234.567").
    s = (parts.length === 2 && parts[1].length !== 3) ? parts[0] + '.' + parts[1] : parts.join('');
  }
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

function buildIdx(headerRow) {
  const headersN = headerRow.map(normHeader);
  return (key) => {
    for (const alias of (STOCK_ALIASES[key] || [key])) {
      const i = headersN.indexOf(alias);
      if (i >= 0) return i;
    }
    return -1;
  };
}

const cleanMoneda = (v) => (String(v ?? '').trim().toUpperCase().startsWith('ARS') ? 'ARS' : 'USD');
const cleanGb = (v) => String(v ?? '').trim().replace(/\.0+$/, '');  // "128.0" → "128"

// rows: string[][] (incluye fila de encabezados). ctx: { categorias, depositos, proveedores }.
// Devuelve [{ body, error, _categoriaNueva, _proveedorNuevo }]:
//   · body listo para POST /inventario/productos/bulk (categoria_id puede ser
//     null si _categoriaNueva está seteada — el caller debe crearla y reemplazar).
//   · error: validación que aborta la fila (nombre vacío, costo 0, depósito inexistente, etc.)
//   · _categoriaNueva: string si la categoría de la fila NO existe en el catálogo
//     actual. Marker para que el caller la cree antes del bulk. Si existe,
//     body.categoria_id ya está seteado y _categoriaNueva es null.
//   · _proveedorNuevo: ídem para proveedores.
//
// Junio 2026: el comportamiento previo era "tirar error si la categoría no
// existe" — ahora se acepta y se marca como pendiente de crear. El caller
// (Inventario.jsx → confirmImport) hace el create antes del bulk de productos.
export function mapStockRows(rows, { categorias = [], depositos = [], proveedores = [] } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const idx = buildIdx(rows[0]);

  const findCat = (n) => categorias.find(c => c.nombre.toLowerCase() === String(n ?? '').trim().toLowerCase());
  const findProv = (n) => proveedores.find(p => p.nombre.toLowerCase() === String(n ?? '').trim().toLowerCase());

  return rows.slice(1)
    // Ignora filas totalmente vacías (típicas al final de una planilla)
    .filter(r => r.some(c => String(c ?? '').trim() !== ''))
    .map(r => {
      const get = (key) => { const i = idx(key); return (i >= 0 ? r[i] : '') ?? ''; };

      const nombre = String(get('nombre')).trim();
      const imei = String(get('imei')).trim();
      const stockRaw = String(get('cantidad')).trim();
      const hasStock = stockRaw !== '';
      const tipoRaw = String(get('tipo_carga')).trim().toLowerCase();

      // Reglas del negocio: accesorio si trae STOCK; celular si trae IMEI.
      const clase = hasStock ? 'accesorio' : 'celular';
      const tipo_carga = (hasStock || tipoRaw === 'stock' || tipoRaw === 'lote') ? 'lote' : 'unitario';
      const cantidad = clase === 'accesorio' ? Math.max(0, Math.round(parseNum(stockRaw))) : 1;

      // Depósito por ID numérico (lo que usa la planilla); si no, por nombre.
      const depRaw = String(get('deposito')).trim();
      let deposito_id = null;
      let depError = null;
      if (depRaw) {
        if (/^\d+$/.test(depRaw)) {
          const byId = depositos.find(d => String(d.id) === depRaw);
          if (byId) deposito_id = byId.id; else depError = `Depósito ID ${depRaw} no existe`;
        } else {
          const byName = depositos.find(d => d.nombre.toLowerCase() === depRaw.toLowerCase());
          deposito_id = byName ? byName.id : null;
        }
      }

      const bat = String(get('bateria')).trim();
      const categoriaRaw = String(get('categoria')).trim();
      const cat = findCat(categoriaRaw);
      const proveedorRaw = String(get('proveedor')).trim();
      const prov = proveedorRaw ? findProv(proveedorRaw) : null;
      const costo = parseNum(get('costo'));
      const precio_venta = parseNum(get('precio_venta'));

      const body = {
        nombre,
        clase,
        tipo_carga,
        estado: 'disponible',
        imei: imei || null,
        gb: cleanGb(get('gb')) || null,
        color: String(get('color')).trim() || null,
        bateria: bat === '' ? null : Math.max(0, Math.min(100, Math.round(parseNum(bat)))),
        categoria_id: cat ? cat.id : null,
        deposito_id,
        proveedor: proveedorRaw || null,
        costo,
        costo_moneda: cleanMoneda(get('costo_moneda')),
        precio_venta,
        precio_moneda: cleanMoneda(get('precio_moneda')),
        cantidad,
      };

      // Markers para auto-create. Solo si trae nombre y NO existe en catálogo.
      // Se devuelven al caller que decide crearlos antes del bulk.
      const _categoriaNueva = (categoriaRaw && !cat) ? categoriaRaw : null;
      const _proveedorNuevo = (proveedorRaw && !prov) ? proveedorRaw : null;

      // Validaciones que evitan importar stock que rompe ventas/valorizado.
      // NOTA: "Categoría no existe" YA NO es error — se crea automáticamente
      // (ver _categoriaNueva). Solo "falta categoría" sigue siendo error porque
      // no podemos inventar un nombre.
      let error = null;
      if (!nombre) error = 'Falta el nombre';
      else if (depError) error = depError;
      else if (!categoriaRaw) error = 'Falta la categoría';
      else if (!(costo > 0)) error = 'Costo en 0 o inválido';
      else if (!(precio_venta > 0)) error = 'Precio en 0 o inválido';
      else if (clase === 'accesorio' && cantidad < 1) error = 'Stock en 0';

      return { body, error, _categoriaNueva, _proveedorNuevo };
    });
}

// Helper: dado el resultado de mapStockRows, devuelve los nombres únicos
// (case-insensitive) de categorías y proveedores nuevos a crear. Útil para
// mostrar en el preview "Se crearán N categorías nuevas: [lista]".
export function extractNewCatalogos(mapped) {
  const cats = new Map(); // key=lowercase, value=nombre original (preserva caps de la primera aparición)
  const provs = new Map();
  for (const r of mapped) {
    if (r._categoriaNueva) {
      const k = r._categoriaNueva.toLowerCase();
      if (!cats.has(k)) cats.set(k, r._categoriaNueva);
    }
    if (r._proveedorNuevo) {
      const k = r._proveedorNuevo.toLowerCase();
      if (!provs.has(k)) provs.set(k, r._proveedorNuevo);
    }
  }
  return {
    categorias: [...cats.values()],
    proveedores: [...provs.values()],
  };
}

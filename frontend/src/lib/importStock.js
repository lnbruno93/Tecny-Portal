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

// Fase 1 categorías reales (2026-07-08): mapping desde el string que el
// operador pone en la columna CLASE del XLSX → slug del enum del sistema.
// Acepta:
//   - los 9 slugs canónicos (case-insensitive, con o sin underscores)
//   - los labels con emoji ("📲 Celular Sellado")
//   - los legacy 'celular' / 'accesorio' (mapean con heurística por condicion/hasStock)
// Devuelve null si no reconoce nada — el caller decide el fallback.
const CLASE_ALIASES = {
  // Canónicos + variantes con espacio.
  'celular_sellado':   'celular_sellado',  'celular sellado':   'celular_sellado',  'sellado': 'celular_sellado',
  'celular_usado':     'celular_usado',    'celular usado':     'celular_usado',    'usado': 'celular_usado',
  'watch':             'watch',            'reloj':             'watch',
  'auriculares':       'auriculares',      'auricular':         'auriculares',      'airpods': 'auriculares',
  'consolas':          'consolas',         'consola':           'consolas',
  'computadoras':      'computadoras',     'computadora':       'computadoras',     'notebook': 'computadoras', 'laptop': 'computadoras',
  'ipads':             'ipads',            'ipad':              'ipads',            'tablet':   'ipads',
  'cargadores':        'cargadores',       'cargador':          'cargadores',
  'accesorios_varios': 'accesorios_varios','accesorios varios': 'accesorios_varios','accesorio':'accesorios_varios','accesorios':'accesorios_varios',
  // Legacy: se mapean con heurística — 'celular' sin más contexto va a
  // sellado (más común). Si el operador quiere usado, usa la variante
  // 'celular usado' o el slug directo.
  'celular': 'celular_sellado',
};
// F3.c-2 (2026-07-09): la resolución ahora usa el catálogo `clases` del
// tenant (tabla `clases_producto` de F3.a #528) — permite categorías
// custom del tenant (ej. "Repuestos", "Camisetas") además de los 9 slugs
// F1 base. Devuelve `{ clase, clase_id }` — el body del producto puede
// mandar ambos; backend deriva lo que falte (PR #530).
//
// Prioridad de match:
//   1. Nombre exacto (case-insensitive) en `clases` activas → cubre las
//      base + custom del tenant.
//   2. Slug F1 legacy vía CLASE_ALIASES → mapea a la fila base
//      correspondiente en `clases` por `slug_legacy`.
//   3. Fallback: fila `es_sin_categoria=true` del sistema. El operador
//      la reclasifica desde el modal Categorías después del import.
//
// Return type: `{ clase: string|null, clase_id: string|null }`. `clase`
// se preserva para retrocompatibilidad con el schema de productos (backend
// también actualiza `productos.clase` legacy hasta F3.d cleanup).
function resolveClaseXlsx(raw, clases = []) {
  const noMatch = { clase: null, clase_id: null };
  if (!raw) return noMatch;
  // Strip emoji leading. Rangos:
  //   · U+1F300–U+1FAFF: pictographs (📲 📱 💻 🔋 etc.)
  //   · U+2300–U+27BF: technical + misc symbols (⌚ ♻ etc.)
  //   · U+FE0F: variation selector (aparece después del symbol en algunos
  //     emojis compuestos como ♻️).
  const norm = String(raw).trim()
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2300}-\u{27BF}]\u{FE0F}?\s*/u, '')
    .toLowerCase();

  // 1) Nombre exacto en clases del tenant (base + custom).
  const byNombre = clases.find(c =>
    c.activa && !c.es_sin_categoria && c.nombre && c.nombre.toLowerCase() === norm
  );
  if (byNombre) {
    return { clase: byNombre.slug_legacy || null, clase_id: byNombre.id };
  }

  // 2) Alias F1 → slug_legacy → clase_id.
  const slug = CLASE_ALIASES[norm];
  if (slug) {
    const byBase = clases.find(c =>
      c.activa && c.es_base && c.slug_legacy === slug
    );
    return {
      clase: slug,
      clase_id: byBase ? byBase.id : null,
    };
  }

  // 3) Fallback: "Sin categoría" del sistema (fila `es_sin_categoria`).
  //    El operador la reclasifica desde el modal después del import.
  const sinCat = clases.find(c => c.es_sin_categoria);
  if (sinCat) {
    return { clase: null, clase_id: sinCat.id };
  }

  return noMatch;
}

// Excel/Google Sheets guarda IMEIs de 15 dígitos como notación científica
// ("3.5342733941411E14") porque los trata como número. El pipeline actual
// (xlsx.js → mapStockRows → POST /productos/bulk) persistía el string tal
// cual, y luego la búsqueda ILIKE "%4110%" del picker de Ventas fallaba
// porque el sufijo real "...4110" no existe contiguo en "3.53...E14".
//
// Bug reportado por Lucas 2026-07-07 (picker Nueva Venta). Fix estructural:
// normalizar acá antes del bulk, y backfillear registros ya cargados con
// migration 20260707000004_productos_imei_normalize_scientific.js.
//
// Idempotente con IMEIs limpios ("353427...") y seriales alfa-numéricos
// ("SJW0KF7C5P6"): la regex sólo matchea el patrón científico. Mismo
// tratamiento que fmtImei() del frontend, pero acá se aplica al VALUE que
// termina en DB (allá se aplicaba solo al display).
export function cleanImei(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^-?\d+(\.\d+)?[eE]\+?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return Math.round(n).toString();
  }
  return s;
}

// rows: string[][] (incluye fila de encabezados). ctx: { categorias, depositos, proveedores }.
// Devuelve [{ body, error, warning, _categoriaNueva, _proveedorNuevo }]:
//   · body listo para POST /inventario/productos/bulk (categoria_id puede ser
//     null si _categoriaNueva está seteada — el caller debe crearla y reemplazar).
//   · error: validación que ABORTA la fila (nombre vacío, costo 0, depósito inexistente, etc.)
//   · warning: aviso informativo — la fila SÍ se importa. Ej. accesorio con
//     stock=0 (útil para dar de alta el modelo antes de recibir mercadería).
//   · _categoriaNueva: string si la categoría de la fila NO existe en el catálogo
//     actual. Marker para que el caller la cree antes del bulk. Si existe,
//     body.categoria_id ya está seteado y _categoriaNueva es null.
//   · _proveedorNuevo: ídem para proveedores.
//
// Junio 2026: el comportamiento previo era "tirar error si la categoría no
// existe" — ahora se acepta y se marca como pendiente de crear. El caller
// (Inventario.jsx → confirmImport) hace el create antes del bulk de productos.
// Julio 2026: "Stock en 0" pasó de error a warning — permite dar de alta el
// producto aunque todavía no haya stock físico (feature pedida por owner).
export function mapStockRows(rows, { categorias = [], depositos = [], proveedores = [], clases = [] } = {}) {
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
      // cleanImei: normaliza notación científica de Excel/Sheets antes de
      // persistir. Ver comentario en el helper. Fix estructural bug picker
      // Ventas (Lucas 2026-07-07).
      const imei = cleanImei(get('imei'));
      const stockRaw = String(get('cantidad')).trim();
      const hasStock = stockRaw !== '';
      const tipoRaw = String(get('tipo_carga')).trim().toLowerCase();

      // Clase: 2 caminos.
      //   1) Si el XLSX trae columna CLASE con un valor reconocible, lo usamos.
      //      Acepta los 9 slugs nuevos, sus labels con emoji, y los legacy
      //      'celular'/'accesorio' (mapean vía resolveClaseXlsx).
      //   2) Si no trae CLASE, heurística vieja: hasStock → accesorios_varios,
      //      else → celular_sellado. Mismo comportamiento que antes con
      //      celular/accesorio pero apuntando al slug del enum nuevo (Fase 1
      //      2026-07-08). El operador puede editar la clase desde Inventario
      //      después del import si el heurístico se equivocó.
      // F3.c-2: resolveClaseXlsx ahora devuelve { clase, clase_id }.
      const claseXlsx = resolveClaseXlsx(get('clase'), clases);
      const clase = claseXlsx.clase || (hasStock ? 'accesorios_varios' : 'celular_sellado');
      // clase_id: preferimos el resuelto por nombre/alias. Si el XLSX no
      // trajo columna o no matcheó nada, intentamos derivarlo del slug
      // fallback heurístico (accesorios_varios/celular_sellado) — vale
      // solo si el tenant tiene esas base activas. Post-F3.a seed → sí.
      let clase_id = claseXlsx.clase_id;
      if (!clase_id) {
        const byFallback = clases.find(c =>
          c.activa && c.es_base && c.slug_legacy === clase
        );
        if (byFallback) clase_id = byFallback.id;
      }
      const tipo_carga = (hasStock || tipoRaw === 'stock' || tipoRaw === 'lote') ? 'lote' : 'unitario';
      // Regla de cantidad: si el operador pasó una clase que NO es de las
      // "por-unidad" (celular sellado/usado o ipads), asumimos que trackea
      // stock por lote → cantidad = STOCK del XLSX (0 si no viene). Idem
      // legacy con hasStock. Los celulares e iPads suelen tener IMEI y
      // cantidad=1; el resto va por stock.
      const esUnitario = (clase === 'celular_sellado' || clase === 'celular_usado' || clase === 'ipads');
      const cantidad = esUnitario ? 1 : Math.max(0, Math.round(parseNum(stockRaw)));

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
        // F3.c-2: agregamos clase_id además de clase legacy. Backend acepta
        // ambos y hace derive bidireccional (PR #530). Cuando F3.d haga
        // el DROP COLUMN, este campo pasa a ser el único.
        clase_id,
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

      // Warnings: la fila SÍ se importa, pero el owner ve un aviso amarillo en
      // el preview para tomar la decisión con contexto (ej. alta de modelo
      // vacío para preparar catálogo antes de recibir mercadería).
      let warning = null;
      if (!error && !esUnitario && cantidad < 1) {
        warning = 'Stock en 0 — el producto se dará de alta sin unidades disponibles';
      }

      return { body, error, warning, _categoriaNueva, _proveedorNuevo };
    });
}

// Agrupa el resultado de mapStockRows por proveedor (case-insensitive,
// preservando la primera capitalización vista) para el flujo multi-proveedor
// del import XLSX. Una sola planilla puede traer productos de varios proveedores
// (columna "proveedor"); cada grupo se vuelve una "compra" trazable.
//
// Reglas:
//   - Solo se agrupan filas SIN error (las inválidas no entran en compras).
//   - Filas sin proveedor van al grupo especial `__sin_proveedor__` (clave
//     reservada) — la UI las muestra con un selector requerido antes de
//     poder importar (no aceptamos compras anónimas: rompe trazabilidad).
//   - Orden preservado: el primer proveedor visto aparece primero.
//
// Devuelve: [{ proveedor: string | null, rows: [...] }]
//   - proveedor === null para el grupo sin proveedor en la planilla.
//   - rows mantiene la referencia a los objetos originales de mapped.
export function groupRowsByProveedor(mapped) {
  if (!Array.isArray(mapped) || mapped.length === 0) return [];
  // Map preserva orden de inserción — útil para que la UI muestre los grupos
  // en el orden en que aparecen en el XLSX.
  const groups = new Map(); // key: lowercase | null (sin proveedor)
  for (const r of mapped) {
    if (r.error) continue;
    const raw = (r.body?.proveedor || '').trim();
    const key = raw ? raw.toLowerCase() : '__sin_proveedor__';
    if (!groups.has(key)) {
      groups.set(key, { proveedor: raw || null, rows: [] });
    }
    groups.get(key).rows.push(r);
  }
  return [...groups.values()];
}

// Arma el payload del endpoint POST /api/proveedores/movimientos/bulk a partir
// de los grupos del modal de import. Función pura para poder testarla aislada
// (la sincronización con la UI/loadCatalogos vive en el caller).
//
// Argumentos:
//   - groups: el state importGroups del modal (output de buildImportGroups,
//     posiblemente editado por el usuario).
//   - newCatByName: Map<lowercase nombre, id> de categorías recién creadas
//     (output del bulk de categorías en confirmImport).
//   - provIdByName: Map<lowercase nombre, id> de proveedores resueltos
//     (output del bulk de proveedores resolve-or-create).
//
// Devuelve: array de movimientos listos para enviar al endpoint.
// Throws si un grupo no resuelve a un proveedor_id válido (defensa para evitar
// mandar payloads que el backend rechazaría con un 400 menos informativo).
export function buildBulkMovimientosPayload({ groups, newCatByName = new Map(), provIdByName = new Map() } = {}) {
  if (!Array.isArray(groups) || groups.length === 0) return [];
  return groups.map(g => {
    const provId = g.proveedor_id || provIdByName.get((g.proveedor_nuevo || '').trim().toLowerCase());
    if (!provId) {
      throw new Error(`No se pudo resolver el proveedor para el grupo "${g.proveedor_label}".`);
    }
    const items = g.rows.map(r => {
      const body = { ...r.body };
      // Reconcilia categoria_id si era una categoría nueva (caso ya manejado
      // upstream en el caso normal, pero defensivo por si llega sin id).
      if (r._categoriaNueva && !body.categoria_id) {
        body.categoria_id = newCatByName.get(r._categoriaNueva.toLowerCase()) || null;
      }
      // El backend (#H-06) rellena producto.proveedor con el nombre del
      // proveedor del movimiento. Quitamos el campo del producto_stock para
      // que NO genere conflicto si vienen distintos en distintas filas.
      delete body.proveedor;
      const cantidad = body.cantidad || 1;
      return {
        producto:    body.nombre || null,
        modelo:      body.nombre || null,
        tamano:      body.gb || null,
        color:       body.color || null,
        imei_serial: body.imei || null,
        // Valor del item solo si el costo está en USD (no asumimos TC).
        valor:       body.costo_moneda === 'USD' ? Number(body.costo || 0) * cantidad : null,
        producto_stock: body,
      };
    });
    return {
      proveedor_id: provId,
      fecha: g.fecha,
      tipo: 'compra',
      descripcion: `Import XLSX · ${items.length} producto${items.length === 1 ? '' : 's'}`,
      monto: Number(g.monto),
      moneda: g.moneda,
      tc: g.moneda !== 'USD' ? Number(g.tc) : null,
      caja_id: g.caja_id ? Number(g.caja_id) : null,
      items,
    };
  });
}

// 2026-06-30 #imei-dup: detecta IMEIs duplicados DENTRO de un set de filas
// del XLSX. Ignora filas sin IMEI (productos sin IMEI son legítimos —
// accesorios, lote sin serial). Devuelve un array con un entry por IMEI
// repetido, incluyendo los índices de fila (0-based dentro de `rows`) para
// que la UI pueda highlightearlas.
//
// Trim aplicado para tolerar IMEIs con espacios accidentales (Excel a veces
// los pega con padding). Coincidencia exacta del string trimmed — no
// case-normalize porque IMEIs son numéricos puros, pero por defensa
// futura aceptamos cualquier string.
//
// Shape: [{ imei: string, rowIndices: number[] }]
//
// Pensado para correrse en la UI del import xlsx ANTES de submit, mostrando
// un banner rojo + lista + disable del botón si dups.length > 0.
export function findDuplicateImeis(rows) {
  const map = new Map(); // imei trimmed → [rowIndex, ...]
  if (!Array.isArray(rows)) return [];
  rows.forEach((row, idx) => {
    // Tolerar tanto el shape de mapStockRows ({ body: { imei } }) como un
    // shape plano ({ imei }) por si el helper se usa en otros contextos.
    const raw = row?.body?.imei ?? row?.imei ?? '';
    const imei = String(raw ?? '').trim();
    if (!imei) return;
    if (!map.has(imei)) map.set(imei, []);
    map.get(imei).push(idx);
  });
  const dups = [];
  for (const [imei, indices] of map.entries()) {
    if (indices.length > 1) dups.push({ imei, rowIndices: indices });
  }
  return dups;
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

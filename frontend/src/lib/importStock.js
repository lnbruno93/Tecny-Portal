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
//
// 2026-07-25: `categoria` y `rubro` se movieron de la key legacy `categoria`
// (que targetaba `categorias` = Colecciones) a la key `clase` (target
// `clases_producto` = Categorías, la fuente de verdad F3.a-onwards). El
// operador reportó que la planilla auto-creaba Colecciones cuando debería
// crear Categorías — user pidió consolidar TODO en Categorías y remover el
// concepto de Colecciones. La key `categoria` de STOCK_ALIASES se eliminó.
export const STOCK_ALIASES = {
  nombre:        ['nombre', 'modelo', 'producto'],
  clase:         ['clase', 'categoria', 'rubro'],
  tipo_carga:    ['tipo', 'tipocarga', 'carga'],
  estado:        ['estado'],
  imei:          ['imei', 'serie', 'nroserie', 'numeroserie'],
  gb:            ['gb', 'almacenamiento', 'capacidad'],
  color:         ['color'],
  bateria:       ['bateria', 'bat', 'salud', 'saludbateria'],
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
// F3.c-2 (2026-07-09): la resolución usa el catálogo `clases` del tenant
// (tabla `clases_producto` de F3.a #528) — permite categorías custom del
// tenant (ej. "Repuestos", "Camisetas") además de los 9 slugs F1 base.
//
// 2026-07-25: cuando el operador escribe un valor que NO matchea ninguna
// clase existente NI un alias F1 legacy, ANTES caíamos al fallback
// "Sin categoría" — el operador tenía que reclasificar manualmente después
// del import. Ahora devolvemos `_claseNueva: raw` como marker para que el
// caller (Inventario.jsx `confirmImport`) haga bulk resolve-or-create en
// `clases_producto` y reconcilie el `clase_id`. Mismo pattern que ya
// usábamos para `_categoriaNueva` (Colecciones), pero targeteando Categorías
// (la fuente de verdad post-F3) en vez de Colecciones (tabla legacy que se
// deprecó — user pidió consolidar TODO en Categorías 2026-07-25).
//
// El fallback "Sin categoría" solo se usa cuando la fila NO trae valor en
// la columna clase/categoria/rubro (raw vacío o whitespace).
//
// Prioridad de match:
//   1. Nombre exacto (case-insensitive) en `clases` activas → cubre las
//      base + custom del tenant.
//   2. Slug F1 legacy vía CLASE_ALIASES → mapea a la fila base
//      correspondiente en `clases` por `slug_legacy`.
//   3. Auto-create: mark `_claseNueva: raw` para que el caller lo cree.
//      NO se usa el fallback "Sin categoría" — el operador escribió algo
//      con intención, lo respetamos.
//   4. Fallback "Sin categoría": SOLO cuando raw está vacío (no aplica acá,
//      lo maneja el caller — ver mapStockRows).
//
// Return type: `{ clase, clase_id, _claseNueva }`.
//   - `clase`: slug_legacy si matcheó por nombre O por alias legacy; null
//     si es una clase custom del tenant o si es auto-create.
//   - `clase_id`: UUID si matcheó; null si es auto-create (pendiente de
//     resolver post-bulk).
//   - `_claseNueva`: string con el raw (preservando caps + emoji stripped)
//     cuando no matcheó nada — señal para auto-create. null si matcheó.
function resolveClaseXlsx(raw, clases = []) {
  const empty = { clase: null, clase_id: null, _claseNueva: null };
  if (!raw) return empty;
  // Strip emoji leading. Rangos:
  //   · U+1F300–U+1FAFF: pictographs (📲 📱 💻 🔋 etc.)
  //   · U+2300–U+27BF: technical + misc symbols (⌚ ♻ etc.)
  //   · U+FE0F: variation selector (aparece después del symbol en algunos
  //     emojis compuestos como ♻️).
  const noEmoji = String(raw).trim()
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2300}-\u{27BF}]\u{FE0F}?\s*/u, '');
  const norm = noEmoji.toLowerCase();
  if (!norm) return empty;  // era solo emoji o whitespace

  // 1) Nombre exacto en clases del tenant (base + custom).
  const byNombre = clases.find(c =>
    c.activa && !c.es_sin_categoria && c.nombre && c.nombre.toLowerCase() === norm
  );
  if (byNombre) {
    return { clase: byNombre.slug_legacy || null, clase_id: byNombre.id, _claseNueva: null };
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
      _claseNueva: null,
    };
  }

  // 3) Auto-create: mark for bulk create in the caller. Preserva la
  //    capitalización original (sin emoji) para display consistente.
  return { clase: null, clase_id: null, _claseNueva: noEmoji };
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

// rows: string[][] (incluye fila de encabezados). ctx: { depositos, proveedores, clases }.
// Devuelve [{ body, error, warning, _claseNueva, _proveedorNuevo }]:
//   · body listo para POST /inventario/productos/bulk (clase_id puede ser
//     null si _claseNueva está seteada — el caller debe crearla via bulk y
//     reconciliar).
//   · error: validación que ABORTA la fila (nombre vacío, costo 0, depósito inexistente, etc.)
//   · warning: aviso informativo — la fila SÍ se importa. Ej. accesorio con
//     stock=0 (útil para dar de alta el modelo antes de recibir mercadería).
//   · _claseNueva: string si el valor de columna clase/categoria/rubro NO existe
//     en el catálogo `clases_producto`. Marker para que el caller la cree
//     antes del bulk. Si existe (o si la columna vino vacía y se usó fallback),
//     _claseNueva es null.
//   · _proveedorNuevo: ídem para proveedores.
//
// Junio 2026: el comportamiento previo era "tirar error si la categoría no
// existe" — se pasó a "aceptar y marcar como pendiente de crear en Colecciones".
// 2026-07-25: el auto-create se movió de Colecciones (tabla legacy `categorias`)
// a Categorías (tabla `clases_producto`). User pidió consolidar TODO en
// Categorías y remover el concepto de Colecciones (que agrupaba productos por
// nombres arbitrarios y hoy no aporta valor). El campo body.categoria_id
// (Colección) queda siempre null desde el import — el operador puede seguir
// asignándolo manualmente desde el form del producto si quiere (pero la UI
// también deprecó ese field 2026-07-11).
//
// Julio 2026: "Stock en 0" pasó de error a warning — permite dar de alta el
// producto aunque todavía no haya stock físico (feature pedida por owner).
export function mapStockRows(rows, { depositos = [], proveedores = [], clases = [] } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const idx = buildIdx(rows[0]);

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

      // Categoría (columna 'clase' / 'categoria' / 'rubro' del XLSX, todos
      // aliases de STOCK_ALIASES.clase desde 2026-07-25).
      //   1) Si trae valor reconocible (nombre exacto o alias F1 legacy) →
      //      resolveClaseXlsx devuelve clase_id.
      //   2) Si trae valor NO reconocible → resolveClaseXlsx marca
      //      `_claseNueva` para auto-create en el bulk. clase_id queda null
      //      y se reconcilia post-bulkClases en el caller.
      //   3) Si NO trae valor → fallback heurístico por hasStock (abajo).
      //
      // F3.d-3 (2026-07-09): body ya no incluye `clase` VARCHAR (columna
      // dropeada). Se manda solo `clase_id`. La regla de cantidad usa el
      // `slug_legacy` que resolveClaseXlsx devuelve como `clase` (nombre
      // interno del helper, no del body).
      const claseRaw = String(get('clase')).trim();
      const claseXlsx = resolveClaseXlsx(claseRaw, clases);
      let clase_id = claseXlsx.clase_id;
      let _claseNueva = claseXlsx._claseNueva;
      // Fallback: solo si el XLSX no trajo valor Y no hay auto-create pendiente.
      // Buscamos `accesorios_varios` (hasStock) o `celular_sellado` (sin stock)
      // en las base del tenant. Si tampoco existen (tenant nuevo raro), última
      // caída a `es_sin_categoria`.
      if (!clase_id && !_claseNueva) {
        const fallbackSlug = hasStock ? 'accesorios_varios' : 'celular_sellado';
        const byFallback = clases.find(c =>
          c.activa && c.es_base && c.slug_legacy === fallbackSlug
        );
        if (byFallback) {
          clase_id = byFallback.id;
        } else {
          // Última caída: fila `es_sin_categoria` del sistema.
          const sinCat = clases.find(c => c.es_sin_categoria);
          if (sinCat) clase_id = sinCat.id;
        }
      }
      const tipo_carga = (hasStock || tipoRaw === 'stock' || tipoRaw === 'lote') ? 'lote' : 'unitario';
      // Regla de cantidad: si el slug_legacy es de las "por-unidad" (celular
      // sellado/usado o ipads), cantidad = 1. Sino usa el STOCK del XLSX.
      // Usamos el `clase` que resolveClaseXlsx devolvió (o el fallback).
      const claseSlug = claseXlsx.clase || (hasStock ? 'accesorios_varios' : 'celular_sellado');
      const esUnitario = (claseSlug === 'celular_sellado' || claseSlug === 'celular_usado' || claseSlug === 'ipads');
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
      const proveedorRaw = String(get('proveedor')).trim();
      const prov = proveedorRaw ? findProv(proveedorRaw) : null;
      const costo = parseNum(get('costo'));
      const precio_venta = parseNum(get('precio_venta'));

      const body = {
        nombre,
        // F3.d-3: `clase` VARCHAR dropeada — solo `clase_id`.
        clase_id,
        tipo_carga,
        estado: 'disponible',
        imei: imei || null,
        gb: cleanGb(get('gb')) || null,
        color: String(get('color')).trim() || null,
        bateria: bat === '' ? null : Math.max(0, Math.min(100, Math.round(parseNum(bat)))),
        // 2026-07-25: categoria_id (Colección legacy) siempre null desde el
        // import XLSX. Ver header comment — user pidió consolidar en Categorías
        // y remover Colecciones. El operador puede asignar manualmente si
        // aún usa Colecciones (el form ya deprecó el field 2026-07-11).
        categoria_id: null,
        deposito_id,
        proveedor: proveedorRaw || null,
        costo,
        costo_moneda: cleanMoneda(get('costo_moneda')),
        precio_venta,
        precio_moneda: cleanMoneda(get('precio_moneda')),
        cantidad,
      };

      // Markers para auto-create. Solo si trae valor y NO existe en catálogo.
      // Se devuelven al caller que decide crearlos antes del bulk.
      const _proveedorNuevo = (proveedorRaw && !prov) ? proveedorRaw : null;

      // Validaciones que evitan importar stock que rompe ventas/valorizado.
      // NOTA: "Categoría no existe" YA NO es error — se crea automáticamente
      // (ver _claseNueva). Si la columna vino vacía, cae al fallback
      // heurístico (accesorios_varios / celular_sellado) — sigue sin ser error.
      let error = null;
      if (!nombre) error = 'Falta el nombre';
      else if (depError) error = depError;
      else if (!(costo > 0)) error = 'Costo en 0 o inválido';
      else if (!(precio_venta > 0)) error = 'Precio en 0 o inválido';

      // Warnings: la fila SÍ se importa, pero el owner ve un aviso amarillo en
      // el preview para tomar la decisión con contexto (ej. alta de modelo
      // vacío para preparar catálogo antes de recibir mercadería).
      let warning = null;
      if (!error && !esUnitario && cantidad < 1) {
        warning = 'Stock en 0 — el producto se dará de alta sin unidades disponibles';
      }

      return { body, error, warning, _claseNueva, _proveedorNuevo };
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
//   - newClaseByName: Map<lowercase nombre, id> de Categorías recién creadas
//     (output del bulk de clases en confirmImport). 2026-07-25: renombrado
//     desde `newCatByName` — target cambió de `categorias` (Colecciones) a
//     `clases_producto` (Categorías).
//   - provIdByName: Map<lowercase nombre, id> de proveedores resueltos
//     (output del bulk de proveedores resolve-or-create).
//
// Devuelve: array de movimientos listos para enviar al endpoint.
// Throws si un grupo no resuelve a un proveedor_id válido (defensa para evitar
// mandar payloads que el backend rechazaría con un 400 menos informativo).
export function buildBulkMovimientosPayload({ groups, newClaseByName = new Map(), provIdByName = new Map() } = {}) {
  if (!Array.isArray(groups) || groups.length === 0) return [];
  return groups.map(g => {
    const provId = g.proveedor_id || provIdByName.get((g.proveedor_nuevo || '').trim().toLowerCase());
    if (!provId) {
      throw new Error(`No se pudo resolver el proveedor para el grupo "${g.proveedor_label}".`);
    }
    const items = g.rows.map(r => {
      const body = { ...r.body };
      // Reconcilia clase_id si era una Categoría nueva (caso ya manejado
      // upstream en el caso normal, pero defensivo por si llega sin id).
      if (r._claseNueva && !body.clase_id) {
        body.clase_id = newClaseByName.get(r._claseNueva.toLowerCase()) || null;
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
// (case-insensitive) de Categorías y proveedores nuevos a crear. Útil para
// mostrar en el preview "Se crearán N categorías nuevas: [lista]".
//
// 2026-07-25: la key `categorias` del return se renombró a `clases` — target
// pasó de `categorias` (Colecciones) a `clases_producto` (Categorías).
// El caller (Inventario.jsx confirmImport) ahora hace `inventario.bulkClases`
// en vez de `bulkCategorias`.
export function extractNewCatalogos(mapped) {
  const clases = new Map(); // key=lowercase, value=nombre original (preserva caps de la primera aparición)
  const provs = new Map();
  for (const r of mapped) {
    if (r._claseNueva) {
      const k = r._claseNueva.toLowerCase();
      if (!clases.has(k)) clases.set(k, r._claseNueva);
    }
    if (r._proveedorNuevo) {
      const k = r._proveedorNuevo.toLowerCase();
      if (!provs.has(k)) provs.set(k, r._proveedorNuevo);
    }
  }
  return {
    clases: [...clases.values()],
    proveedores: [...provs.values()],
  };
}

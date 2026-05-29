import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { inventario } from '../lib/api';
import { exportCsv } from '../lib/exportCsv';
import { readXlsxRows, writeXlsx } from '../lib/xlsx';
import { mapStockRows } from '../lib/importStock';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import EditableCell from '../components/EditableCell';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1


// ─── Formatters ────────────────────────────────────────────────────────────────
function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('es-AR');
}
function money(n, moneda) {
  const sym = moneda === 'ARS' ? '$' : 'u$s';
  return sym + fmt(n);
}

// ─── Constantes ──────────────────────────────────────────────────────────────
const EMPTY_PRODUCTO = {
  tipo_carga: 'unitario', clase: 'celular', nombre: '', imei: '', gb: '', color: '',
  bateria: '', categoria_id: '', deposito_id: '', proveedor: '',
  costo: '', costo_moneda: 'USD', precio_venta: '', precio_moneda: 'USD',
  cantidad: '1', estado: 'disponible', observaciones: '',
  condicion: 'nuevo',
};

// Opciones del selector "Vista" — encapsulan combinaciones de estado + oculto.
// Mismo enum que el backend (backend/src/schemas/inventario.js: VISTAS_INVENTARIO).
// Labels reformulados (#M-08): la doble negación "no vendidos" confundía. Ahora
// describen QUÉ se muestra, no qué se excluye. Ojo: NO renombrar los `value` —
// son contrato con el backend.
const VISTAS = [
  { value: 'no_vendidos',         label: 'En stock (visible)' },
  { value: 'no_vendidos_ocultos', label: 'En stock pero ocultos' },
  { value: 'ocultos',             label: 'Todo lo oculto (stock + vendido)' },
  { value: 'vendidos',            label: 'Vendidos' },
  { value: 'todos_visibles',      label: 'Todo lo visible (stock + vendido)' },
  { value: 'todos_ocultos',       label: 'Todo (visible + oculto)' },
];

const ESTADO_DISPLAY = {
  disponible: { label: 'Disponible', tone: 'pos' },
  vendido:    { label: 'Vendido',    tone: 'default' },
  en_tecnico: { label: 'En técnico', tone: 'warn' },
  reservado:  { label: 'Reservado',  tone: 'info' },
};

// Encabezados EXACTOS de la planilla del negocio (misma base para importar y exportar).
const PLANTILLA_HEADERS = ['Nombre', 'GB(solo iph)', 'BATERIA(solo iph)', 'COLOR(solo iph)', 'COSTO',
  'MONEDA COSTO(ARS/USD)', 'PRECIO', 'MONEDA PRECIO(ARS/USD)', 'IMEI(solo iph)', 'TIPO(unitario, stock)',
  'CATEGORIA', 'PROVEEDOR', 'STOCK(solo acc)', 'ID DEPOSITO(SÓLO NÚMERO)'];
// Filas de ejemplo: un celular (IMEI, sin STOCK) y un accesorio (STOCK, sin IMEI).
const PLANTILLA_EJEMPLO = [
  ['iPhone 15 Pro', '256', '92', 'Natural', '800', 'USD', '950', 'USD', '356938035643809', 'Unitario', 'iPhone Nuevo', 'Juan Distribuidor', '', '1'],
  ['Funda iPhone 15', '', '', '', '3', 'USD', '8', 'USD', '', 'stock', 'Accesorios', 'Mayorista Acc', '20', '1'],
];

// Parser CSV mínimo (soporta comillas, comas y saltos dentro de campos)
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(v => v.trim() !== '')) rows.push(row); }
  return rows;
}

function Badge({ tone = 'default', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Seg({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Pantalla ──────────────────────────────────────────────────────────────────
export default function Inventario() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { setPrimaryAction } = usePageActions();

  const [productos, setProductos] = useState([]);
  const [metricas, setMetricas] = useState(null);
  const [categorias, setCategorias] = useState([]);
  const [depositos, setDepositos] = useState([]);
  const [proveedoresList, setProveedoresList] = useState([]); // distinct, para combo de edición inline
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // El filtro de "pestañas" admite ahora valores compuestos:
  //   'todos' | 'celular' | 'accesorio' | 'tecnico' | 'usados' | 'cat:<id>'
  // Esto permite mezclar tabs fijos (claseFilter clásico), el atributo nuevo
  // 'usados' (condicion=usado) y categorías administrables (categoria_id=N).
  const [claseFilter, setClaseFilter] = useState('todos');
  const [vistaFiltro, setVistaFiltro] = useState('no_vendidos');
  const [search, setSearch] = useState('');
  // Search debounceada: no dispara una request al backend (con ILIKE multi-columna +
  // COUNT(*)) en cada keystroke; espera 350ms tras la última tecla.
  const dSearch = useDebouncedValue(search, 350);

  // ── Drill-down desde Desglose 360 ──
  // Si llegamos con query params (?proveedor=X, ?categoria_id=N, etc.) los aplicamos
  // al fetch como filtros adicionales y mostramos un chip "Filtrado por: X · Limpiar".
  // No agregamos UI permanente: si el usuario quiere editar el filtro, vuelve al desglose.
  const [searchParams, setSearchParams] = useSearchParams();
  const drillFilters = useMemo(() => {
    const ALLOWED = ['categoria_id', 'deposito_id', 'estado', 'proveedor', 'nombre', 'gb', 'color'];
    const out = {};
    for (const k of ALLOWED) {
      const v = searchParams.get(k);
      if (v) out[k] = v;
    }
    return out;
  }, [searchParams]);
  const hasDrillDown = Object.keys(drillFilters).length > 0;
  function clearDrillDown() { setSearchParams({}); }

  // Modal alta/edición
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_PRODUCTO);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Modal import
  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState([]);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);

  // Modal catálogos (categorías + depósitos)
  const [showCatalogos, setShowCatalogos] = useState(false);
  const [nuevaCat, setNuevaCat] = useState('');
  const [nuevoDep, setNuevoDep] = useState('');
  const [catError, setCatError] = useState('');

  // ── Carga de datos ──
  const loadProductos = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 50, vista: vistaFiltro };
      // Resolución del tab activo:
      //   - celular / accesorio → params.clase
      //   - tecnico            → params.estado = en_tecnico
      //   - usados             → params.condicion = usado
      //   - cat:<id>           → params.categoria_id
      //   - todos              → sin filtro extra
      if (claseFilter === 'celular' || claseFilter === 'accesorio') params.clase = claseFilter;
      else if (claseFilter === 'tecnico') params.estado = 'en_tecnico';
      else if (claseFilter === 'usados') params.condicion = 'usado';
      else if (claseFilter && claseFilter.startsWith('cat:')) params.categoria_id = claseFilter.slice(4);
      if (dSearch.trim()) params.buscar = dSearch.trim();
      // Drill-down: aplicamos los filtros que vinieron por URL al fetch.
      // El backend rechaza claves desconocidas (Zod), así que sólo pasamos lo válido.
      // Importante: el drill-down sobreescribe la vista a 'todos_ocultos' para que el
      // usuario vea TODO lo que matchea el desglose, no sólo no-vendidos.
      if (Object.keys(drillFilters).length) {
        Object.assign(params, drillFilters);
        params.vista = 'todos_ocultos';
      }
      const res = await inventario.productos(params);
      setProductos(res.data || []);
      setTotal(res.pagination?.total || 0);
      setPages(res.pagination?.pages || 1);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [page, claseFilter, vistaFiltro, dSearch, toast, drillFilters]);

  const loadMetricas = useCallback(async () => {
    try { setMetricas(await inventario.metricas()); } catch (_) {}
  }, []);

  const loadCatalogos = useCallback(async () => {
    try {
      const [c, d, prov] = await Promise.all([
        inventario.categorias(),
        inventario.depositos(),
        inventario.proveedoresList().catch(() => []),
      ]);
      setCategorias(c); setDepositos(d); setProveedoresList(prov || []);
    } catch (_) {}
  }, []);

  useEffect(() => { loadCatalogos(); loadMetricas(); }, [loadCatalogos, loadMetricas]);
  useEffect(() => { loadProductos(); }, [loadProductos]);

  // ── Edición inline: PATCH un campo y mergear en memoria ──
  // Optimismo controlado: actualizamos el state ANTES de la respuesta,
  // pero re-cargamos métricas / categorías al final por si cambió costo o categoría
  // (afecta inv_*_usd y productos_count). En caso de error, revertimos.
  const inlineUpdate = useCallback(async (id, field, value) => {
    const before = productos.find(p => p.id === id);
    if (!before) return;
    // Update optimista
    setProductos(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p));
    try {
      const updated = await inventario.updateProducto(id, { [field]: value });
      // Reemplazamos con la fila normalizada por el backend
      // (puede haber rellenado categoria_nombre, etc., si el front sólo conocía categoria_id).
      setProductos(prev => prev.map(p => p.id === id ? { ...p, ...updated, categoria_nombre: categorias.find(c => c.id === updated.categoria_id)?.nombre ?? p.categoria_nombre, deposito_nombre: depositos.find(d => d.id === updated.deposito_id)?.nombre ?? p.deposito_nombre } : p));
      // Recargo métricas (costo/precio/cantidad pueden haber cambiado).
      loadMetricas();
      // Si cambió la categoría → conteo por categoría también cambia.
      if (field === 'categoria_id') loadCatalogos();
      // Si tocaron proveedor → puede haber un nombre nuevo a sumar al combo.
      if (field === 'proveedor') loadCatalogos();
    } catch (e) {
      // Rollback
      setProductos(prev => prev.map(p => p.id === id ? before : p));
      toast.error(e.message || 'No se pudo guardar');
      throw e;
    }
  }, [productos, categorias, depositos, loadMetricas, loadCatalogos, toast]);

  // Cambiar filtros → volver a page 1. Usamos dSearch (no search) para que el
  // reset ocurra junto con el fetch debounceado.
  useEffect(() => { setPage(1); }, [claseFilter, vistaFiltro, dSearch]);

  // ── Modal alta/edición ──
  function openCreate() {
    setEditId(null); setForm(EMPTY_PRODUCTO); setFormError(''); setShowForm(true);
  }
  function openEdit(p) {
    setEditId(p.id);
    setForm({
      tipo_carga: p.tipo_carga, clase: p.clase, nombre: p.nombre, imei: p.imei ?? '',
      gb: p.gb ?? '', color: p.color ?? '', bateria: p.bateria ?? '',
      categoria_id: p.categoria_id ?? '', deposito_id: p.deposito_id ?? '', proveedor: p.proveedor ?? '',
      costo: p.costo, costo_moneda: p.costo_moneda, precio_venta: p.precio_venta, precio_moneda: p.precio_moneda,
      cantidad: p.cantidad, estado: p.estado, observaciones: p.observaciones ?? '',
      condicion: p.condicion || 'nuevo',
    });
    setFormError(''); setShowForm(true);
  }

  useEffect(() => {
    setPrimaryAction({ label: 'Agregar producto', onClick: openCreate });
    return () => setPrimaryAction(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPrimaryAction]);

  async function handleSave(e) {
    e.preventDefault();
    if (!form.nombre.trim()) { setFormError('El nombre es obligatorio.'); return; }
    // Categoría requerida al crear (en edits de productos legacy queda opcional para no bloquear).
    if (!editId && !form.categoria_id) { setFormError('La categoría es obligatoria.'); return; }
    setSaving(true); setFormError('');
    const num = (v) => v === '' || v == null ? null : Number(v);
    const payload = {
      tipo_carga: form.tipo_carga, clase: form.clase, nombre: form.nombre.trim(),
      imei: form.imei.trim() || null, gb: form.gb.trim() || null, color: form.color.trim() || null,
      bateria: num(form.bateria), categoria_id: form.categoria_id || null, deposito_id: form.deposito_id || null,
      proveedor: form.proveedor.trim() || null,
      costo: num(form.costo) ?? 0, costo_moneda: form.costo_moneda,
      precio_venta: num(form.precio_venta) ?? 0, precio_moneda: form.precio_moneda,
      cantidad: num(form.cantidad) ?? 1, estado: form.estado,
      observaciones: form.observaciones.trim() || null,
      condicion: form.condicion || 'nuevo',
    };
    try {
      if (editId) await inventario.updateProducto(editId, payload);
      else await inventario.createProducto(payload);
      toast.success(editId ? 'Producto actualizado.' : 'Producto agregado.');
      setShowForm(false);
      await Promise.all([loadProductos(), loadMetricas()]);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(p) {
    const ok = await confirm({ title: 'Eliminar producto', message: `¿Eliminar "${p.nombre}"? Esta acción no se puede deshacer.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await inventario.deleteProducto(p.id);
      toast.success('Producto eliminado.');
      await Promise.all([loadProductos(), loadMetricas()]);
    } catch (e) { toast.error(e.message); }
  }

  // ── Export / plantilla / import (misma base de columnas que la planilla) ──
  // Convierte un producto a una fila en el orden EXACTO de PLANTILLA_HEADERS.
  function productoARow(p) {
    return [
      p.nombre || '', p.gb || '', p.bateria ?? '', p.color || '',
      p.costo ?? '', p.costo_moneda || '', p.precio_venta ?? '', p.precio_moneda || '',
      p.imei || '', p.tipo_carga === 'lote' ? 'stock' : 'Unitario',
      p.categoria_nombre || '', p.proveedor || '',
      p.clase === 'accesorio' ? (p.cantidad ?? '') : '', p.deposito_id ?? '',
    ];
  }
  // Filas (arrays) → objetos keyed por header, para exportCsv.
  const rowsToObjects = (rows) => rows.map(r => Object.fromEntries(PLANTILLA_HEADERS.map((h, i) => [h, r[i]])));
  const plantillaCols = () => PLANTILLA_HEADERS.map(h => ({ key: h, label: h }));
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  function exportProductos() {
    if (!productos.length) { toast.error('No hay productos para exportar.'); return; }
    exportCsv('inventario.csv', rowsToObjects(productos.map(productoARow)), plantillaCols());
  }

  function descargarPlantillaXlsx() {
    downloadBlob(writeXlsx([PLANTILLA_HEADERS, ...PLANTILLA_EJEMPLO]), 'plantilla_stock.xlsx');
  }
  function descargarPlantillaCsv() {
    exportCsv('plantilla_stock.csv', rowsToObjects(PLANTILLA_EJEMPLO), plantillaCols());
  }

  function openImport() { setImportRows([]); setImportError(''); setShowImport(true); }

  async function onImportFile(e) {
    setImportError('');
    const file = e.target.files?.[0];
    if (!file) return;
    // Tope de tamaño: un .xlsx legítimo de stock está muy por debajo de 10 MB.
    // Evita que un archivo gigante (planilla con imágenes embebidas) cuelgue la pestaña.
    const MAX_MB = 10;
    if (file.size > MAX_MB * 1024 * 1024) {
      setImportError(`El archivo supera ${MAX_MB} MB. Exportá una planilla más liviana o sacale fotos/objetos embebidos.`);
      e.target.value = '';
      return;
    }
    const isXlsx = /\.xlsx$/i.test(file.name);
    try {
      // Lee .xlsx (Excel) nativo o .csv; ambos terminan como filas de celdas.
      const rows = isXlsx
        ? await readXlsxRows(await file.arrayBuffer())
        : parseCsv(await file.text());
      if (!rows || rows.length < 2) { setImportError('El archivo no tiene filas de datos.'); return; }
      const mapped = mapStockRows(rows, { categorias, depositos });
      if (mapped.length === 0) { setImportError('No se encontraron filas con datos.'); return; }
      setImportRows(mapped);
    } catch (err) {
      setImportError(isXlsx
        ? 'No se pudo leer el Excel. ¿Es un .xlsx válido?'
        : 'No se pudo leer el archivo. ¿Es un CSV válido?');
    } finally {
      e.target.value = ''; // permite re-seleccionar el mismo archivo
    }
  }

  async function confirmImport() {
    const validos = importRows.filter(r => !r.error).map(r => r.body);
    if (!validos.length) return;
    setImporting(true);
    try {
      let creados = 0;
      for (let i = 0; i < validos.length; i += 500) {
        const res = await inventario.bulkProductos(validos.slice(i, i + 500));
        creados += res.creados;
      }
      toast.success(`${creados} producto${creados === 1 ? '' : 's'} importado${creados === 1 ? '' : 's'}.`);
      setShowImport(false);
      await Promise.all([loadProductos(), loadMetricas()]);
    } catch (e) {
      setImportError(e.message);
    } finally {
      setImporting(false);
    }
  }

  // ── Catálogos (categorías / depósitos) ──
  async function addCategoria() {
    setCatError('');
    const nombre = nuevaCat.trim();
    if (!nombre) return;
    try { await inventario.createCategoria({ nombre }); setNuevaCat(''); await loadCatalogos(); }
    catch (e) { setCatError(e.message); }
  }
  async function delCategoria(c) {
    const ok = await confirm({ title: 'Eliminar categoría', message: `¿Eliminar "${c.nombre}"? Los productos quedarán sin categoría.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await inventario.deleteCategoria(c.id); await loadCatalogos(); } catch (e) { toast.error(e.message); }
  }
  async function addDeposito() {
    setCatError('');
    const nombre = nuevoDep.trim();
    if (!nombre) return;
    try { await inventario.createDeposito({ nombre }); setNuevoDep(''); await loadCatalogos(); }
    catch (e) { setCatError(e.message); }
  }
  async function delDeposito(d) {
    const ok = await confirm({ title: 'Eliminar depósito', message: `¿Eliminar "${d.nombre}"? Los productos quedarán sin depósito.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await inventario.deleteDeposito(d.id); await loadCatalogos(); } catch (e) { toast.error(e.message); }
  }

  const importValidos = useMemo(() => importRows.filter(r => !r.error), [importRows]);
  const importErrores = useMemo(() => importRows.filter(r => r.error), [importRows]);

  function estadoBadge(s) {
    const d = ESTADO_DISPLAY[s] || { label: s, tone: 'default' };
    return <Badge tone={d.tone}>{d.label}</Badge>;
  }

  return (
    <div>
      {/* ── Page head ── */}
      <div className="page-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="page-title">Inventario</h1>
            <Link to="/inventario/desglose" className="btn btn-ghost btn-sm" title="Vista 360 de tu stock por categoría, proveedor, modelo y más">
              Desglose 360 →
            </Link>
          </div>
          <div className="page-sub">Stock de equipos y accesorios · costos, depósitos y proveedores</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => { loadProductos(); loadMetricas(); }}>
            <Icons.Refresh size={14} /> Actualizar
          </button>
          <button className="btn" onClick={descargarPlantillaXlsx}><Icons.Download size={14} /> Plantilla .xlsx</button>
          <button className="btn" onClick={descargarPlantillaCsv}><Icons.Download size={14} /> Plantilla .csv</button>
          <button className="btn" onClick={openImport}><Icons.Upload size={14} /> Importar</button>
          <button className="btn" onClick={exportProductos}><Icons.Download size={14} /> Exportar</button>
          <button className="btn" onClick={() => { setCatError(''); setShowCatalogos(true); }}><Icons.Sliders size={14} /> Categorías &amp; Depósitos</button>
          <button className="btn btn-primary" onClick={openCreate}><Icons.Plus size={14} /> Agregar producto</button>
        </div>
      </div>

      {/* ── KPIs ── */}
      <div className="row" style={{ marginBottom: 18 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">En técnico</div>
          <div className="kpi-value mono" style={{ color: 'var(--warn)' }}>{metricas ? metricas.en_tecnico_count : '—'}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>{metricas ? money(metricas.en_tecnico_usd, 'USD') : ''}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Stock disponible</div>
          <div className="kpi-value mono pos">{metricas ? fmt(metricas.stock_disponible) : '—'}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>unidades</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Inversión equipos</div>
          <div className="kpi-value"><span className="ccy">USD</span><span className="mono">{metricas ? fmt(metricas.inv_equipos_usd) : '—'}</span></div>
          <div className="muted tiny" style={{ marginTop: 6 }}>{metricas ? `${metricas.equipos_count} equipos` : ''}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Inversión accesorios</div>
          <div className="kpi-value"><span className="ccy">USD</span><span className="mono">{metricas ? fmt(metricas.inv_accesorios_usd) : '—'}</span></div>
          <div className="muted tiny" style={{ marginTop: 6 }}>{metricas ? `${metricas.accesorios_count} unidades` : ''}</div>
        </div>
      </div>

      {/* ── Filtros ──
            Fila 1: tabs (clase fija + 'Usados' + 1 tab por categoría administrable).
                    Se hacen scroll horizontal si no entran en el ancho disponible.
            Fila 2: selector de vista (estado + ocultos) + buscador.            */}
      <div style={{ marginBottom: 14 }}>
        {/* #M-09: scroll-fade-x indica que hay más tabs a la derecha cuando
            no entran. Es hint visual permanente — no usamos JS de scroll. */}
        <div className="scroll-fade-x" style={{ marginBottom: 10 }}>
          <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
            <Seg
              value={claseFilter}
              options={[
                { value: 'todos', label: 'Todos' },
                { value: 'celular', label: 'Celulares' },
                { value: 'accesorio', label: 'Accesorios' },
                { value: 'tecnico', label: 'En técnico' },
                { value: 'usados', label: 'Usados' },
                // Categorías administrables → 1 tab por cada una (orden alfabético).
                // El usuario las crea/edita desde "Gestionar categorías" sin tocar código.
                ...[...categorias].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
                  .map(c => ({ value: `cat:${c.id}`, label: c.nombre })),
              ]}
              onChange={setClaseFilter}
            />
          </div>
        </div>
        <div className="flex-between" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="flex-row" style={{ gap: 8, alignItems: 'center' }}>
            <label className="field-label" style={{ marginBottom: 0, marginRight: 4 }}>Vista</label>
            <select
              className="input"
              value={vistaFiltro}
              onChange={e => setVistaFiltro(e.target.value)}
              style={{ width: 240 }}
            >
              {VISTAS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          </div>
          <div className="input-group" style={{ width: 300 }}>
            <span className="addon addon-l"><Icons.Search size={14} /></span>
            <input className="input" placeholder="Buscar nombre, IMEI, color, GB…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      {/* ── Chip de drill-down ── */}
      {hasDrillDown && (
        <div className="card card-tight" style={{ marginBottom: 12, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Icons.Filter size={14} />
          <span className="muted tiny">Filtrado desde Desglose 360:</span>
          {Object.entries(drillFilters).map(([k, v]) => {
            // Mostramos el nombre humano cuando podamos resolverlo
            let label = v;
            if (k === 'categoria_id') label = categorias.find(c => String(c.id) === String(v))?.nombre || `Categoría #${v}`;
            if (k === 'deposito_id')  label = depositos.find(d => String(d.id) === String(v))?.nombre || `Depósito #${v}`;
            if (k === 'estado')       label = ({ disponible: 'Disponible', vendido: 'Vendido', en_tecnico: 'En técnico', reservado: 'Reservado' }[v]) || v;
            const niceKey = ({ categoria_id: 'Categoría', deposito_id: 'Depósito', estado: 'Estado', proveedor: 'Proveedor', nombre: 'Modelo', gb: 'GB', color: 'Color' })[k] || k;
            return (
              <span key={k} className="badge badge-info" style={{ fontSize: 12 }}>{niceKey}: {label}</span>
            );
          })}
          <button className="btn btn-sm" onClick={clearDrillDown} title="Limpiar filtro y ver todo">
            <Icons.X size={13} /> Limpiar
          </button>
        </div>
      )}

      {/* ── Tabla ── */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>Cargando…</div>
      ) : productos.length === 0 ? (
        <div className="empty">Sin productos</div>
      ) : (
        <div className="card card-flush" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Nombre</th><th>GB</th><th>Batería</th><th>Color</th>
                <th style={{ textAlign: 'right' }}>Costo</th><th>Moneda Costo</th>
                <th style={{ textAlign: 'right' }}>Precio Venta</th><th>Moneda Precio Venta</th>
                <th>IMEI/Serial</th><th>Tipo</th><th>Categoría</th><th>Proveedor</th>
                <th style={{ textAlign: 'right' }}>Stock</th><th>Estado</th><th></th>
              </tr>
            </thead>
            <tbody>
              {productos.map(p => {
                const save = (field) => (val) => inlineUpdate(p.id, field, val);
                const catOptions = categorias.map(c => ({ value: c.id, label: c.nombre }));
                const provOptions = proveedoresList.map(s => ({ value: s, label: s }));
                // Atenuamos la fila si el producto está oculto: pista visual rápida
                // sin agregar una columna nueva en una tabla que ya es ancha.
                return (
                  <tr key={p.id} style={p.oculto ? { opacity: 0.55 } : undefined}>
                    <EditableCell
                      value={p.nombre}
                      type="text"
                      align="left"
                      className="cell-strong"
                      onSave={save('nombre')}
                      inputProps={{ maxLength: 200 }}
                      emptyToNull={false}
                    />
                    <EditableCell
                      value={p.gb || ''}
                      type="text"
                      align="left"
                      className="mono"
                      onSave={save('gb')}
                      inputProps={{ maxLength: 20 }}
                    />
                    <EditableCell
                      value={p.bateria}
                      display={p.bateria != null ? p.bateria + '%' : '—'}
                      type="number" onKeyDown={blockInvalidNumberKeys}
                      align="left"
                      className="mono"
                      onSave={save('bateria')}
                      parse={v => v === '' ? null : Number(v)}
                      inputProps={{ min: 0, max: 100, step: 1 }}
                    />
                    <EditableCell
                      value={p.color || ''}
                      type="text"
                      align="left"
                      onSave={save('color')}
                      inputProps={{ maxLength: 60 }}
                    />
                    <EditableCell
                      value={p.costo}
                      display={fmt(p.costo)}
                      type="number" onKeyDown={blockInvalidNumberKeys}
                      align="right"
                      className="mono"
                      onSave={save('costo')}
                      parse={v => v === '' ? 0 : Number(v)}
                      emptyToNull={false}
                      inputProps={{ min: 0, step: 1 }}
                    />
                    <EditableCell
                      value={p.costo_moneda}
                      display={<span className="ccy">{p.costo_moneda}</span>}
                      type="select"
                      options={[{ value: 'USD', label: 'USD' }, { value: 'ARS', label: 'ARS' }]}
                      onSave={save('costo_moneda')}
                      emptyToNull={false}
                    />
                    <EditableCell
                      value={p.precio_venta}
                      display={<span className="pos" style={{ fontWeight: 600 }}>{fmt(p.precio_venta)}</span>}
                      type="number" onKeyDown={blockInvalidNumberKeys}
                      align="right"
                      className="mono"
                      onSave={save('precio_venta')}
                      parse={v => v === '' ? 0 : Number(v)}
                      emptyToNull={false}
                      inputProps={{ min: 0, step: 1 }}
                    />
                    <EditableCell
                      value={p.precio_moneda}
                      display={<span className="ccy">{p.precio_moneda}</span>}
                      type="select"
                      options={[{ value: 'USD', label: 'USD' }, { value: 'ARS', label: 'ARS' }]}
                      onSave={save('precio_moneda')}
                      emptyToNull={false}
                    />
                    <EditableCell
                      value={p.imei || ''}
                      type="text"
                      align="left"
                      className="mono tiny"
                      onSave={save('imei')}
                      inputProps={{ maxLength: 50 }}
                    />
                    <EditableCell
                      value={p.tipo_carga}
                      display={<span className="muted">{p.tipo_carga === 'lote' ? 'Stock' : 'Unitario'}</span>}
                      type="select"
                      options={[{ value: 'unitario', label: 'Unitario' }, { value: 'lote', label: 'Stock' }]}
                      onSave={save('tipo_carga')}
                      emptyToNull={false}
                    />
                    <EditableCell
                      value={p.categoria_id}
                      display={<span className="muted">{p.categoria_nombre || '—'}</span>}
                      type="combo"
                      options={catOptions}
                      onSave={save('categoria_id')}
                      parse={v => v === '' ? null : Number(v)}
                    />
                    <EditableCell
                      value={p.proveedor || ''}
                      display={<span className="muted">{p.proveedor || '—'}</span>}
                      type="combo"
                      options={provOptions}
                      onSave={save('proveedor')}
                      inputProps={{ maxLength: 200 }}
                    />
                    <EditableCell
                      value={p.cantidad}
                      type="number" onKeyDown={blockInvalidNumberKeys}
                      align="right"
                      className="mono"
                      onSave={save('cantidad')}
                      parse={v => v === '' ? 0 : Number(v)}
                      emptyToNull={false}
                      inputProps={{ min: 0, step: 1 }}
                    />
                    <EditableCell
                      value={p.estado}
                      display={estadoBadge(p.estado)}
                      type="select"
                      options={Object.entries(ESTADO_DISPLAY).map(([v, m]) => ({ value: v, label: m.label }))}
                      onSave={save('estado')}
                      emptyToNull={false}
                    />
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="icon-btn"
                        title={p.oculto ? 'Mostrar (sacar de ocultos)' : 'Ocultar de la vista por defecto'}
                        onClick={() => inlineUpdate(p.id, 'oculto', !p.oculto).catch(() => {})}
                      >
                        {p.oculto ? <Icons.EyeOff size={14} /> : <Icons.Eye size={14} />}
                      </button>
                      <button className="icon-btn" title="Editar (modal completo)" onClick={() => openEdit(p)}><Icons.Edit size={14} /></button>
                      <button className="icon-btn" title="Eliminar" style={{ color: 'var(--neg)' }} onClick={() => handleDelete(p)}><Icons.Trash size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Paginación ── */}
      {!loading && pages > 1 && (
        <div className="flex-row" style={{ gap: 8, justifyContent: 'center', marginTop: 14 }}>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ Anterior</button>
          <span className="muted tiny" style={{ alignSelf: 'center' }}>{page} / {pages} · {total} productos</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Siguiente ›</button>
        </div>
      )}

      {/* ── Modal alta/edición ── */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>{editId ? 'Editar producto' : 'Agregar producto'}</h3>
              <button className="icon-btn" onClick={() => setShowForm(false)}><Icons.X size={16} /></button>
            </div>
            <form onSubmit={handleSave}>
              <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                <div className="stack" style={{ gap: 14 }}>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Tipo de carga</label>
                      <select className="input" value={form.tipo_carga} onChange={e => setF('tipo_carga', e.target.value)}>
                        <option value="unitario">Unitario (ej. celulares)</option>
                        <option value="lote">Con stock / lote</option>
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Clase</label>
                      <select className="input" value={form.clase} onChange={e => setF('clase', e.target.value)}>
                        <option value="celular">Celular</option>
                        <option value="accesorio">Accesorio</option>
                      </select>
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label>
                    <input className="input" placeholder="ej. iPhone 15 Pro" value={form.nombre} onChange={e => setF('nombre', e.target.value)} autoFocus />
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Batería (%)</label><input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="85" value={form.bateria} onChange={e => setF('bateria', e.target.value)} /></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">GB</label><input className="input" placeholder="128" value={form.gb} onChange={e => setF('gb', e.target.value)} /></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Color</label><input className="input" placeholder="Natural" value={form.color} onChange={e => setF('color', e.target.value)} /></div>
                  </div>
                  <div className="field"><label className="field-label">IMEI (opcional)</label><input className="input mono" placeholder="356938035643809" value={form.imei} onChange={e => setF('imei', e.target.value)} /></div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Categoría <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <select className="input" value={form.categoria_id} onChange={e => setF('categoria_id', e.target.value)} required>
                        <option value="">— Elegir —</option>
                        {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Depósito</label>
                      <select className="input" value={form.deposito_id} onChange={e => setF('deposito_id', e.target.value)}>
                        <option value="">Sin depósito</option>
                        {depositos.map(d => <option key={d.id} value={d.id}>{d.nombre}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Costo</label>
                      <div className="flex-row" style={{ gap: 6 }}>
                        <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="0" value={form.costo} onChange={e => setF('costo', e.target.value)} style={{ flex: 1 }} />
                        <select className="input" style={{ width: 80 }} value={form.costo_moneda} onChange={e => setF('costo_moneda', e.target.value)}><option>USD</option><option>ARS</option></select>
                      </div>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Precio de venta</label>
                      <div className="flex-row" style={{ gap: 6 }}>
                        <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="0" value={form.precio_venta} onChange={e => setF('precio_venta', e.target.value)} style={{ flex: 1 }} />
                        <select className="input" style={{ width: 80 }} value={form.precio_moneda} onChange={e => setF('precio_moneda', e.target.value)}><option>USD</option><option>ARS</option></select>
                      </div>
                    </div>
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Cantidad</label><input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" value={form.cantidad} onChange={e => setF('cantidad', e.target.value)} /></div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Estado</label>
                      <select className="input" value={form.estado} onChange={e => setF('estado', e.target.value)}>
                        <option value="disponible">Disponible</option>
                        <option value="en_tecnico">En técnico</option>
                        <option value="reservado">Reservado</option>
                        <option value="vendido">Vendido</option>
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Condición</label>
                      <select className="input" value={form.condicion} onChange={e => setF('condicion', e.target.value)}>
                        <option value="nuevo">Nuevo</option>
                        <option value="usado">Usado</option>
                      </select>
                    </div>
                  </div>
                  <div className="field"><label className="field-label">Proveedor</label><input className="input" placeholder="ej. Juan Distribuidor" value={form.proveedor} onChange={e => setF('proveedor', e.target.value)} /></div>
                  <div className="field"><label className="field-label">Observaciones</label><input className="input" placeholder="ej. pantalla rota, batería hinchada…" value={form.observaciones} onChange={e => setF('observaciones', e.target.value)} /></div>
                  {formError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{formError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal import ── */}
      {showImport && (
        <div className="modal-overlay" onClick={() => setShowImport(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Importar stock desde planilla</h3>
              <button className="icon-btn" onClick={() => setShowImport(false)}><Icons.X size={16} /></button>
            </div>
            <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
              <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
                Subí un archivo <strong>.xlsx</strong> o <strong>.csv</strong>. Se detecta cada columna por su nombre (tolera aclaraciones como “(solo iph)”). Accesorio si trae STOCK, celular si trae IMEI. El depósito se vincula por su ID y la categoría por nombre.
              </p>
              <div className="flex-row" style={{ gap: 6, marginBottom: 12 }}>
                <button className="btn btn-sm" onClick={descargarPlantillaXlsx}><Icons.Download size={13} /> Plantilla .xlsx</button>
                <button className="btn btn-sm" onClick={descargarPlantillaCsv}><Icons.Download size={13} /> Plantilla .csv</button>
              </div>
              <div className="field">
                <label className="field-label">Archivo (.xlsx o .csv)</label>
                <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="input" onChange={onImportFile} />
              </div>
              {importRows.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                    <span className="pos">{importValidos.length} válidos</span> · <span className="neg">{importErrores.length} con error</span> · {importRows.length} filas
                  </div>
                  {importErrores.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--neg)', maxHeight: 80, overflowY: 'auto', marginBottom: 8 }}>
                      {importErrores.slice(0, 20).map((r, i) => <div key={i}>Fila {i + 1} ({r.body.nombre || 'sin nombre'}): {r.error}</div>)}
                    </div>
                  )}
                  {importValidos.length > 0 && (
                    <table className="table" style={{ fontSize: 12 }}>
                      <thead><tr><th>Nombre</th><th>Clase</th><th>Cant.</th><th>Proveedor</th></tr></thead>
                      <tbody>{importValidos.slice(0, 6).map((r, i) => <tr key={i}><td>{r.body.nombre}</td><td>{r.body.clase}</td><td>{r.body.cantidad}</td><td className="muted">{r.body.proveedor || '—'}</td></tr>)}</tbody>
                    </table>
                  )}
                </div>
              )}
              {importError && <div style={{ color: 'var(--neg)', fontSize: 13, marginTop: 10 }}>{importError}</div>}
            </div>
            <div className="modal-ft">
              <button className="btn btn-ghost" onClick={() => setShowImport(false)}>Cancelar</button>
              <button className="btn btn-primary" disabled={importing || importValidos.length === 0} onClick={confirmImport}>{importing ? 'Importando…' : 'Importar'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal catálogos ── */}
      {showCatalogos && (
        <div className="modal-overlay" onClick={() => setShowCatalogos(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Categorías &amp; Depósitos</h3>
              <button className="icon-btn" onClick={() => setShowCatalogos(false)}><Icons.X size={16} /></button>
            </div>
            <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
              <div className="row">
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Categorías</div>
                  <div className="flex-row" style={{ gap: 6, marginBottom: 8 }}>
                    <input className="input" placeholder="Nueva categoría" value={nuevaCat} onChange={e => setNuevaCat(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCategoria(); } }} />
                    <button className="btn btn-sm" onClick={addCategoria}><Icons.Plus size={13} /></button>
                  </div>
                  <div className="stack" style={{ gap: 4 }}>
                    {categorias.length === 0 && <div className="muted tiny">Sin categorías</div>}
                    {categorias.map(c => {
                      const count = Number(c.productos_count ?? 0);
                      const stock = Number(c.stock_disponible ?? 0);
                      return (
                        <div key={c.id} className="flex-between" style={{ fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--hairline)' }}>
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.nombre}>{c.nombre}</span>
                          <span className="muted tiny" style={{ marginRight: 8, whiteSpace: 'nowrap' }} title={`${count} producto${count === 1 ? '' : 's'} cargado${count === 1 ? '' : 's'} · ${stock} unidad${stock === 1 ? '' : 'es'} en stock`}>
                            {count} prod · {stock} u
                          </span>
                          <button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => delCategoria(c)}><Icons.Trash size={13} /></button>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Depósitos</div>
                  <div className="flex-row" style={{ gap: 6, marginBottom: 8 }}>
                    <input className="input" placeholder="Nuevo depósito" value={nuevoDep} onChange={e => setNuevoDep(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDeposito(); } }} />
                    <button className="btn btn-sm" onClick={addDeposito}><Icons.Plus size={13} /></button>
                  </div>
                  <div className="stack" style={{ gap: 4 }}>
                    {depositos.length === 0 && <div className="muted tiny">Sin depósitos</div>}
                    {depositos.map(d => (
                      <div key={d.id} className="flex-between" style={{ fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--hairline)' }}>
                        <span>{d.nombre}</span>
                        <button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => delDeposito(d)}><Icons.Trash size={13} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              {catError && <div style={{ color: 'var(--neg)', fontSize: 13, marginTop: 10 }}>{catError}</div>}
            </div>
            <div className="modal-ft">
              <button className="btn btn-primary" onClick={() => setShowCatalogos(false)}>Listo</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

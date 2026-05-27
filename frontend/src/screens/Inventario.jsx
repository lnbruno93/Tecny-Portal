import { useState, useEffect, useMemo, useCallback } from 'react';
import { Icons } from '../components/Icons';
import { inventario } from '../lib/api';
import { exportCsv } from '../lib/exportCsv';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';

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
};

const ESTADO_DISPLAY = {
  disponible: { label: 'Disponible', tone: 'pos' },
  vendido:    { label: 'Vendido',    tone: 'default' },
  en_tecnico: { label: 'En técnico', tone: 'warn' },
  reservado:  { label: 'Reservado',  tone: 'info' },
};

const PLANTILLA_COLS = ['nombre', 'clase', 'tipo_carga', 'imei', 'gb', 'color', 'bateria', 'categoria', 'deposito', 'proveedor', 'costo', 'costo_moneda', 'precio_venta', 'precio_moneda', 'cantidad', 'estado'];

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
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [claseFilter, setClaseFilter] = useState('todos'); // todos | celular | accesorio | tecnico
  const [soloStock, setSoloStock] = useState(false);
  const [search, setSearch] = useState('');

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
      const params = { page, limit: 50 };
      if (claseFilter === 'celular' || claseFilter === 'accesorio') params.clase = claseFilter;
      if (claseFilter === 'tecnico') params.estado = 'en_tecnico';
      if (soloStock) params.solo_stock = 'true';
      if (search.trim()) params.buscar = search.trim();
      const res = await inventario.productos(params);
      setProductos(res.data || []);
      setTotal(res.pagination?.total || 0);
      setPages(res.pagination?.pages || 1);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [page, claseFilter, soloStock, search, toast]);

  const loadMetricas = useCallback(async () => {
    try { setMetricas(await inventario.metricas()); } catch (_) {}
  }, []);

  const loadCatalogos = useCallback(async () => {
    try {
      const [c, d] = await Promise.all([inventario.categorias(), inventario.depositos()]);
      setCategorias(c); setDepositos(d);
    } catch (_) {}
  }, []);

  useEffect(() => { loadCatalogos(); loadMetricas(); }, [loadCatalogos, loadMetricas]);
  useEffect(() => { loadProductos(); }, [loadProductos]);

  // Búsqueda con debounce → vuelve a page 1
  useEffect(() => {
    const t = setTimeout(() => setPage(1), 0);
    return () => clearTimeout(t);
  }, [claseFilter, soloStock, search]);

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

  // ── Export / plantilla / import (CSV) ──
  function exportProductos() {
    if (!productos.length) { toast.error('No hay productos para exportar.'); return; }
    const rows = productos.map(p => ({
      nombre: p.nombre, clase: p.clase, tipo_carga: p.tipo_carga, imei: p.imei || '',
      gb: p.gb || '', color: p.color || '', bateria: p.bateria ?? '',
      categoria: p.categoria_nombre || '', deposito: p.deposito_nombre || '', proveedor: p.proveedor || '',
      costo: p.costo, costo_moneda: p.costo_moneda, precio_venta: p.precio_venta, precio_moneda: p.precio_moneda,
      cantidad: p.cantidad, estado: p.estado,
    }));
    exportCsv('inventario.csv', rows, PLANTILLA_COLS.map(k => ({ key: k, label: k })));
  }

  function descargarPlantilla() {
    const ejemplo = [{
      nombre: 'iPhone 15 Pro', clase: 'celular', tipo_carga: 'unitario', imei: '356938035643809',
      gb: '256', color: 'Natural', bateria: '92', categoria: 'Celulares', deposito: 'Local Centro',
      proveedor: 'Juan Distribuidor', costo: '800', costo_moneda: 'USD', precio_venta: '950', precio_moneda: 'USD',
      cantidad: '1', estado: 'disponible',
    }];
    exportCsv('plantilla_stock.csv', ejemplo, PLANTILLA_COLS.map(k => ({ key: k, label: k })));
  }

  function openImport() { setImportRows([]); setImportError(''); setShowImport(true); }

  function onImportFile(e) {
    setImportError('');
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const rows = parseCsv(String(ev.target.result));
        if (rows.length < 2) { setImportError('El archivo no tiene filas de datos.'); return; }
        // Normaliza encabezados (sin acentos, espacios ni símbolos) y los matchea
        // por alias, para tolerar variantes ("Precio", "Precio de venta", "Costo USD", etc.)
        const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
        const ALIASES = {
          nombre: ['nombre', 'modelo', 'producto'],
          clase: ['clase'],
          tipo_carga: ['tipocarga', 'carga'],
          estado: ['estado'],
          imei: ['imei'],
          gb: ['gb', 'almacenamiento'],
          color: ['color'],
          bateria: ['bateria', 'bat'],
          categoria: ['categoria', 'categoria1', 'rubro'],
          deposito: ['deposito', 'sucursal'],
          proveedor: ['proveedor'],
          costo: ['costo', 'costos', 'compra', 'costounitario'],
          costo_moneda: ['costomoneda', 'monedacosto'],
          precio_venta: ['precioventa', 'precio', 'venta', 'preciodeventa', 'preciolista'],
          precio_moneda: ['preciomoneda', 'monedaprecio', 'monedaventa'],
          cantidad: ['cantidad', 'stock', 'qty', 'unidades'],
        };
        const headersN = rows[0].map(norm);
        const idx = (key) => {
          for (const alias of (ALIASES[key] || [norm(key)])) { const i = headersN.indexOf(alias); if (i >= 0) return i; }
          return -1;
        };
        // Parseo de número tolerante: ignora símbolos ($), maneja coma decimal y separador de miles.
        const parseNum = (v) => {
          let s = String(v ?? '').replace(/[^0-9.,-]/g, '').trim();
          if (!s) return 0;
          s = (s.includes(',') && !s.includes('.')) ? s.replace(',', '.') : s.replace(/,/g, '');
          const n = Number(s); return isNaN(n) ? 0 : n;
        };
        const pick = (val, opts, def) => { const x = String(val ?? '').trim().toLowerCase(); return opts.includes(x) ? x : def; };
        const findCat = (n) => categorias.find(c => c.nombre.toLowerCase() === String(n ?? '').trim().toLowerCase());
        const findDep = (d) => depositos.find(x => x.nombre.toLowerCase() === String(d ?? '').trim().toLowerCase());
        const mapped = rows.slice(1).map(r => {
          const get = (col) => idx(col) >= 0 ? r[idx(col)] : '';
          const nombre = String(get('nombre') || get('modelo') || '').trim();
          const cat = findCat(get('categoria'));
          const dep = findDep(get('deposito'));
          const bat = String(get('bateria')).trim();
          const body = {
            nombre,
            clase: pick(get('clase'), ['celular', 'accesorio'], 'celular'),
            tipo_carga: pick(get('tipo_carga'), ['unitario', 'lote'], 'unitario'),
            estado: pick(get('estado'), ['disponible', 'vendido', 'en_tecnico', 'reservado'], 'disponible'),
            imei: String(get('imei')).trim() || null,
            gb: String(get('gb')).trim() || null,
            color: String(get('color')).trim() || null,
            bateria: bat === '' ? null : Math.max(0, Math.min(100, Math.round(Number(bat) || 0))),
            categoria_id: cat ? cat.id : null,
            deposito_id: dep ? dep.id : null,
            proveedor: String(get('proveedor')).trim() || null,
            costo: parseNum(get('costo')),
            costo_moneda: String(get('costo_moneda')).trim().toUpperCase() === 'ARS' ? 'ARS' : 'USD',
            precio_venta: parseNum(get('precio_venta')),
            precio_moneda: String(get('precio_moneda')).trim().toUpperCase() === 'ARS' ? 'ARS' : 'USD',
            cantidad: Math.max(0, Math.round(parseNum(get('cantidad')) || 1)),
          };
          return { body, error: nombre ? null : 'Falta el nombre' };
        });
        setImportRows(mapped);
      } catch (err) {
        setImportError('No se pudo leer el archivo. ¿Es un CSV válido?');
      }
    };
    reader.readAsText(file);
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
          <h1 className="page-title">Inventario</h1>
          <div className="page-sub">Stock de equipos y accesorios · costos, depósitos y proveedores</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => { loadProductos(); loadMetricas(); }}>
            <Icons.Refresh size={14} /> Actualizar
          </button>
          <button className="btn" onClick={descargarPlantilla}><Icons.Download size={14} /> Plantilla</button>
          <button className="btn" onClick={openImport}><Icons.Upload size={14} /> Importar</button>
          <button className="btn" onClick={exportProductos}><Icons.Download size={14} /> Exportar</button>
          <button className="btn" onClick={() => { setCatError(''); setShowCatalogos(true); }}><Icons.Sliders size={14} /> Catálogos</button>
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

      {/* ── Filtros ── */}
      <div className="flex-between" style={{ marginBottom: 14 }}>
        <Seg
          value={claseFilter}
          options={[
            { value: 'todos', label: 'Todos' },
            { value: 'celular', label: 'Celulares' },
            { value: 'accesorio', label: 'Accesorios' },
            { value: 'tecnico', label: 'En técnico' },
          ]}
          onChange={setClaseFilter}
        />
        <div className="flex-row" style={{ gap: 8 }}>
          <label className="flex-row" style={{ gap: 6, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={soloStock} onChange={e => setSoloStock(e.target.checked)} /> Solo en stock
          </label>
          <div className="input-group" style={{ width: 300 }}>
            <span className="addon addon-l"><Icons.Search size={14} /></span>
            <input className="input" placeholder="Buscar nombre, IMEI, color, GB…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      {/* ── Tabla ── */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>Cargando…</div>
      ) : productos.length === 0 ? (
        <div className="empty">Sin productos</div>
      ) : (
        <div className="card card-flush">
          <table className="table">
            <thead>
              <tr>
                <th>Modelo</th><th>Clase</th><th>Cant.</th><th>Detalle</th><th>Proveedor</th>
                <th>Costo</th><th>Precio</th><th>Estado</th><th></th>
              </tr>
            </thead>
            <tbody>
              {productos.map(p => {
                const detalle = [p.gb ? p.gb + 'GB' : '', p.color || '', p.bateria != null ? p.bateria + '%' : ''].filter(Boolean).join(' · ');
                return (
                  <tr key={p.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{p.nombre}</div>
                      {p.imei && <div className="muted tiny mono">IMEI {p.imei}</div>}
                    </td>
                    <td className="muted">{p.clase === 'celular' ? 'Celular' : 'Accesorio'}</td>
                    <td className="mono">{p.cantidad}</td>
                    <td className="muted tiny">{detalle || '—'}</td>
                    <td className="muted">{p.proveedor || '—'}</td>
                    <td className="mono">{money(p.costo, p.costo_moneda)}</td>
                    <td className="mono pos" style={{ fontWeight: 600 }}>{money(p.precio_venta, p.precio_moneda)}</td>
                    <td>{estadoBadge(p.estado)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" title="Editar" onClick={() => openEdit(p)}><Icons.Edit size={14} /></button>
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
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Batería (%)</label><input type="number" className="input mono" placeholder="85" value={form.bateria} onChange={e => setF('bateria', e.target.value)} /></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">GB</label><input className="input" placeholder="128" value={form.gb} onChange={e => setF('gb', e.target.value)} /></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Color</label><input className="input" placeholder="Natural" value={form.color} onChange={e => setF('color', e.target.value)} /></div>
                  </div>
                  <div className="field"><label className="field-label">IMEI (opcional)</label><input className="input mono" placeholder="356938035643809" value={form.imei} onChange={e => setF('imei', e.target.value)} /></div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Categoría</label>
                      <select className="input" value={form.categoria_id} onChange={e => setF('categoria_id', e.target.value)}>
                        <option value="">Sin categoría</option>
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
                        <input type="number" className="input mono" placeholder="0" value={form.costo} onChange={e => setF('costo', e.target.value)} style={{ flex: 1 }} />
                        <select className="input" style={{ width: 80 }} value={form.costo_moneda} onChange={e => setF('costo_moneda', e.target.value)}><option>USD</option><option>ARS</option></select>
                      </div>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Precio de venta</label>
                      <div className="flex-row" style={{ gap: 6 }}>
                        <input type="number" className="input mono" placeholder="0" value={form.precio_venta} onChange={e => setF('precio_venta', e.target.value)} style={{ flex: 1 }} />
                        <select className="input" style={{ width: 80 }} value={form.precio_moneda} onChange={e => setF('precio_moneda', e.target.value)}><option>USD</option><option>ARS</option></select>
                      </div>
                    </div>
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Cantidad</label><input type="number" className="input mono" value={form.cantidad} onChange={e => setF('cantidad', e.target.value)} /></div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Estado</label>
                      <select className="input" value={form.estado} onChange={e => setF('estado', e.target.value)}>
                        <option value="disponible">Disponible</option>
                        <option value="en_tecnico">En técnico</option>
                        <option value="reservado">Reservado</option>
                        <option value="vendido">Vendido</option>
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
                Subí un archivo <strong>.csv</strong> con las columnas de la plantilla. Categorías y depósitos se vinculan por nombre.
              </p>
              <button className="btn btn-sm" onClick={descargarPlantilla} style={{ marginBottom: 12 }}><Icons.Download size={13} /> Descargar plantilla</button>
              <div className="field">
                <label className="field-label">Archivo CSV</label>
                <input type="file" accept=".csv,text/csv" className="input" onChange={onImportFile} />
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
              <h3>Categorías y depósitos</h3>
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
                    {categorias.map(c => (
                      <div key={c.id} className="flex-between" style={{ fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--hairline)' }}>
                        <span>{c.nombre}</span>
                        <button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => delCategoria(c)}><Icons.Trash size={13} /></button>
                      </div>
                    ))}
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

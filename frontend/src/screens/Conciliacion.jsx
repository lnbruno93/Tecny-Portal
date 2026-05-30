// Pantalla "Conciliación bancaria" — flow de 3 pasos:
//   1. Lista de conciliaciones previas + botón "Nueva conciliación".
//   2. Wizard de creación: caja + archivo + mapeo de columnas → preview → POST.
//   3. Detalle: tabla de líneas con dropdowns para match manual + cerrar.

import { useState, useEffect, useMemo } from 'react';
import { Icons } from '../components/Icons';
import { conciliacion as concApi, cajas as cajasApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';
import { readXlsxRows } from '../lib/xlsx';
import { blockInvalidNumberKeys } from '../lib/inputUtils';

// ─── Parser CSV mínimo (igual al de Inventario) ────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',' || c === ';') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); if (row.some(v => v.trim() !== '')) rows.push(row); }
  return rows;
}

// ─── Parser de monto: convierte "1.234,56" o "-200.00" a Number ────────
function parseMonto(s) {
  if (s == null) return 0;
  const str = String(s).trim();
  if (!str) return 0;
  // Detección heurística: si hay coma Y punto, es es-AR (1.234,56 → 1234.56).
  // Si hay solo coma, es decimal LATAM (1,50 → 1.50).
  // Si hay solo punto o nada, ya es parseable.
  let normalizado = str;
  if (str.includes(',') && str.includes('.')) {
    normalizado = str.replace(/\./g, '').replace(',', '.');
  } else if (str.includes(',')) {
    normalizado = str.replace(',', '.');
  }
  // Quitar caracteres no numéricos excepto - y .
  normalizado = normalizado.replace(/[^\d.\-]/g, '');
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : 0;
}

// ─── Parser de fecha: tolerante a varios formatos comunes ──────────────
function parseFecha(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  // YYYY-MM-DD: ya está bien.
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // DD/MM/YYYY o DD-MM-YYYY
  const m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

function todayISO() { return new Date().toLocaleDateString('sv'); }

export default function Conciliacion() {
  const { toast } = useToast();
  const confirm = useConfirm();
  // 'lista' | 'wizard' | 'detalle'
  const [vista, setVista] = useState('lista');
  const [selectedId, setSelectedId] = useState(null);

  const [conciliaciones, setConciliaciones] = useState([]);
  const [loading, setLoading] = useState(true);

  const [cajas, setCajas] = useState([]);

  useEffect(() => {
    cajasApi.listCajas().then(r => setCajas((Array.isArray(r) ? r : []).filter(c => c.activo !== false))).catch(() => setCajas([]));
  }, []);

  function loadList() {
    setLoading(true);
    concApi.list({ limit: 50 })
      .then(r => setConciliaciones(r.data || []))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { if (vista === 'lista') loadList(); }, [vista]);

  return (
    <div>
      <div className="page-head">
        <h1>Conciliación bancaria</h1>
        <div className="muted tiny">Importá el extracto del banco y matcheá con tu ledger.</div>
      </div>

      {vista === 'lista' && (
        <Lista
          loading={loading}
          items={conciliaciones}
          onNueva={() => setVista('wizard')}
          onAbrir={id => { setSelectedId(id); setVista('detalle'); }}
        />
      )}

      {vista === 'wizard' && (
        <Wizard
          cajas={cajas}
          onCancel={() => setVista('lista')}
          onCreated={id => { setSelectedId(id); setVista('detalle'); }}
        />
      )}

      {vista === 'detalle' && (
        <Detalle
          id={selectedId}
          onVolver={() => setVista('lista')}
        />
      )}
    </div>
  );
}

// ─── Vista: Lista ─────────────────────────────────────────────────────
function Lista({ loading, items, onNueva, onAbrir }) {
  return (
    <>
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <div className="muted tiny">{items.length} conciliaciones</div>
        <button className="btn btn-primary" onClick={onNueva}>
          <Icons.Plus size={14} /> Nueva conciliación
        </button>
      </div>
      <div className="card card-flush">
        {loading ? <div className="empty">Cargando…</div> :
         items.length === 0 ? <div className="empty">Sin conciliaciones todavía. Cargá la primera arriba.</div> :
         <table className="tbl">
           <thead>
             <tr>
               <th>Caja</th><th>Período</th>
               <th style={{ textAlign: 'right' }}>Líneas</th>
               <th style={{ textAlign: 'right' }}>Matched</th>
               <th>Estado</th><th></th>
             </tr>
           </thead>
           <tbody>
             {items.map(c => (
               <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => onAbrir(c.id)}>
                 <td>{c.caja_nombre} <span className="muted tiny">({c.caja_moneda})</span></td>
                 <td className="mono tiny">{fmtFecha(c.fecha_desde)} → {fmtFecha(c.fecha_hasta)}</td>
                 <td className="mono" style={{ textAlign: 'right' }}>{c.lineas_total}</td>
                 <td className="mono" style={{ textAlign: 'right' }}>
                   {c.lineas_matched} / {c.lineas_total}
                 </td>
                 <td>
                   {c.cerrado_en
                     ? <span className="badge badge-info">Cerrada</span>
                     : <span className="badge">Abierta</span>}
                 </td>
                 <td><Icons.ChevronRight size={14} /></td>
               </tr>
             ))}
           </tbody>
         </table>}
      </div>
    </>
  );
}

// ─── Vista: Wizard de creación ────────────────────────────────────────
function Wizard({ cajas, onCancel, onCreated }) {
  const { toast } = useToast();
  // Paso 1: caja + fechas + archivo
  // Paso 2: mapeo columnas → preview
  // Paso 3: confirmar
  const [paso, setPaso] = useState(1);
  const [cajaId, setCajaId] = useState('');
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [tolerancia, setTolerancia] = useState(2);
  const [archivoNombre, setArchivoNombre] = useState('');
  const [rows, setRows] = useState([]);       // Filas parseadas del archivo
  const [headerIdx, setHeaderIdx] = useState(0); // Qué fila usar como header
  const [map, setMap] = useState({ fecha: '', monto: '', desc: '' }); // Mapeo columnas
  const [saving, setSaving] = useState(false);

  // Detectar encabezados disponibles a partir de rows[headerIdx].
  const headers = rows[headerIdx] || [];

  async function handleArchivo(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setArchivoNombre(file.name);
    try {
      const lower = file.name.toLowerCase();
      let parsed;
      if (lower.endsWith('.xlsx')) {
        const buf = await file.arrayBuffer();
        parsed = await readXlsxRows(buf);
      } else {
        const text = await file.text();
        parsed = parseCsv(text);
      }
      if (!parsed || parsed.length === 0) {
        toast.error('El archivo está vacío o no se pudo leer.');
        return;
      }
      setRows(parsed);
      setHeaderIdx(0);
      // Auto-detección de columnas por nombre (heurística).
      const headerRow = parsed[0].map(h => String(h || '').toLowerCase());
      const findCol = (regex) => {
        const i = headerRow.findIndex(h => regex.test(h));
        return i >= 0 ? String(i) : '';
      };
      setMap({
        fecha: findCol(/fecha|date/),
        monto: findCol(/monto|importe|amount|crédito|débito|credito|debito/),
        desc:  findCol(/desc|concepto|detalle|reference/),
      });
      setPaso(2);
    } catch (err) {
      toast.error('Error al leer el archivo: ' + err.message);
    }
  }

  // Líneas válidas a enviar al backend (filas con fecha + monto parseable).
  const lineasValidas = useMemo(() => {
    const out = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const f = parseFecha(r[Number(map.fecha)]);
      const m = parseMonto(r[Number(map.monto)]);
      if (!f || !m) continue;
      out.push({
        fecha: f,
        monto: m,
        descripcion: (r[Number(map.desc)] || '').toString().trim() || null,
      });
    }
    return out;
  }, [rows, headerIdx, map]);

  async function handleCrear() {
    if (!cajaId) { toast.error('Elegí la caja.'); return; }
    if (!fechaDesde || !fechaHasta) { toast.error('Cargá las fechas del período.'); return; }
    if (lineasValidas.length === 0) { toast.error('No hay líneas válidas para conciliar.'); return; }
    setSaving(true);
    try {
      const res = await concApi.create({
        caja_id: Number(cajaId),
        fecha_desde: fechaDesde,
        fecha_hasta: fechaHasta,
        archivo_nombre: archivoNombre,
        tolerancia_dias: Number(tolerancia),
        lineas: lineasValidas,
      });
      toast.success(`Conciliación creada · ${res.lineas_matched} matches automáticos`);
      onCreated(res.id);
    } catch (e) {
      toast.error(e.message);
    } finally { setSaving(false); }
  }

  return (
    <div className="card card-tight">
      <div className="card-hd">
        <h3>Nueva conciliación · Paso {paso} de 3</h3>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancelar</button>
      </div>

      {paso === 1 && (
        <>
          <div className="row" style={{ gap: 12, marginBottom: 12 }}>
            <div className="field" style={{ flex: '0 0 240px' }}>
              <label className="field-label">Caja a conciliar <span style={{ color: 'var(--neg)' }}>*</span></label>
              <select className="input" value={cajaId} onChange={e => setCajaId(e.target.value)}>
                <option value="">— Elegí caja —</option>
                {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 160px' }}>
              <label className="field-label">Desde <span style={{ color: 'var(--neg)' }}>*</span></label>
              <input type="date" className="input" value={fechaDesde} max={todayISO()} onChange={e => setFechaDesde(e.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 0 160px' }}>
              <label className="field-label">Hasta <span style={{ color: 'var(--neg)' }}>*</span></label>
              <input type="date" className="input" value={fechaHasta} max={todayISO()} onChange={e => setFechaHasta(e.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 0 140px' }}>
              <label className="field-label">Tolerancia (días)</label>
              <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" max="30"
                     className="input mono" value={tolerancia}
                     onChange={e => setTolerancia(e.target.value)} />
              <div className="muted tiny" style={{ marginTop: 2 }}>± días para auto-match</div>
            </div>
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <label className="field-label">Archivo del extracto (CSV o XLSX) <span style={{ color: 'var(--neg)' }}>*</span></label>
            <input type="file" accept=".csv,.xlsx" onChange={handleArchivo}
                   disabled={!cajaId || !fechaDesde || !fechaHasta}
                   style={{ padding: '6px 0' }} />
            <div className="muted tiny" style={{ marginTop: 4 }}>
              El archivo se procesa en tu navegador. Solo se mandan al servidor las líneas válidas (fecha + monto).
            </div>
          </div>
        </>
      )}

      {paso === 2 && (
        <>
          <div style={{ marginBottom: 10 }}>
            <div className="muted tiny">Archivo: <strong>{archivoNombre}</strong> · {rows.length} filas detectadas</div>
          </div>
          <div className="row" style={{ gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: '0 0 200px' }}>
              <label className="field-label">Columna Fecha <span style={{ color: 'var(--neg)' }}>*</span></label>
              <select className="input" value={map.fecha} onChange={e => setMap(m => ({ ...m, fecha: e.target.value }))}>
                <option value="">— Elegí —</option>
                {headers.map((h, i) => <option key={i} value={i}>{h || `Columna ${i + 1}`}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 200px' }}>
              <label className="field-label">Columna Monto <span style={{ color: 'var(--neg)' }}>*</span></label>
              <select className="input" value={map.monto} onChange={e => setMap(m => ({ ...m, monto: e.target.value }))}>
                <option value="">— Elegí —</option>
                {headers.map((h, i) => <option key={i} value={i}>{h || `Columna ${i + 1}`}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 240px' }}>
              <label className="field-label">Columna Descripción (opcional)</label>
              <select className="input" value={map.desc} onChange={e => setMap(m => ({ ...m, desc: e.target.value }))}>
                <option value="">— Ninguna —</option>
                {headers.map((h, i) => <option key={i} value={i}>{h || `Columna ${i + 1}`}</option>)}
              </select>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr>{headers.map((h, i) => <th key={i}>{h || `Col ${i + 1}`}</th>)}</tr></thead>
              <tbody>
                {rows.slice(headerIdx + 1, headerIdx + 6).map((r, i) => (
                  <tr key={i}>{r.map((v, j) => <td key={j} className="tiny">{v}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted tiny" style={{ marginTop: 8 }}>
            Vista previa: primeras 5 filas. <strong>{lineasValidas.length}</strong> líneas válidas se importarán.
          </div>
          <div className="flex-row" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={() => setPaso(1)}>← Atrás</button>
            <button className="btn btn-primary" disabled={!map.fecha || !map.monto || lineasValidas.length === 0 || saving} onClick={handleCrear}>
              {saving ? 'Creando…' : `Crear conciliación (${lineasValidas.length} líneas)`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Vista: Detalle ───────────────────────────────────────────────────
function Detalle({ id, onVolver }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    concApi.get(id).then(r => setData(r))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function setMatch(lineaId, matchedId) {
    try {
      await concApi.updateLinea(id, lineaId, { matched_caja_mov_id: matchedId || null, ignorada: false });
      load();
    } catch (e) { toast.error(e.message); }
  }
  async function toggleIgnorada(lineaId, current) {
    try {
      await concApi.updateLinea(id, lineaId, { ignorada: !current, matched_caja_mov_id: null });
      load();
    } catch (e) { toast.error(e.message); }
  }
  async function cerrar() {
    const ok = await confirm({
      title: 'Cerrar conciliación',
      message: 'Los movimientos matcheados se marcarán como conciliados y no podrás editar las líneas. ¿Confirmás?',
      confirmLabel: 'Cerrar',
    });
    if (!ok) return;
    setSaving(true);
    try {
      const res = await concApi.cerrar(id);
      toast.success(`Conciliación cerrada · ${res.movimientos_cerrados} movimientos confirmados`);
      load();
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  }
  async function eliminar() {
    const ok = await confirm({
      title: 'Eliminar conciliación', danger: true,
      message: 'Se borrará la conciliación y se liberarán los movimientos. ¿Seguro?',
      confirmLabel: 'Eliminar',
    });
    if (!ok) return;
    try {
      await concApi.delete(id);
      toast.success('Conciliación eliminada');
      onVolver();
    } catch (e) { toast.error(e.message); }
  }

  if (loading || !data) return <div className="empty">Cargando…</div>;

  const cerrada = !!data.cerrado_en;
  const matched   = data.lineas.filter(l => l.matched_caja_mov_id).length;
  const ignoradas = data.lineas.filter(l => l.ignorada).length;
  const pendientes = data.lineas.length - matched - ignoradas;

  return (
    <>
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={onVolver}>← Volver al listado</button>
        <div className="flex-row" style={{ gap: 8 }}>
          {!cerrada && pendientes === 0 && (
            <button className="btn btn-primary" disabled={saving} onClick={cerrar}>
              {saving ? 'Cerrando…' : 'Cerrar conciliación'}
            </button>
          )}
          <button className="btn" style={{ color: 'var(--neg)' }} onClick={eliminar}>Eliminar</button>
        </div>
      </div>

      <div className="card card-tight" style={{ marginBottom: 12 }}>
        <div className="flex-row" style={{ gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div className="muted tiny">Caja</div>
            <div style={{ fontWeight: 600 }}>{data.caja_nombre} <span className="muted tiny">({data.caja_moneda})</span></div>
          </div>
          <div>
            <div className="muted tiny">Período</div>
            <div className="mono">{fmtFecha(data.fecha_desde)} → {fmtFecha(data.fecha_hasta)}</div>
          </div>
          <div>
            <div className="muted tiny">Archivo</div>
            <div className="tiny">{data.archivo_nombre || '—'}</div>
          </div>
          <div>
            <div className="muted tiny">Estado</div>
            {cerrada
              ? <span className="badge badge-info">Cerrada {fmtFecha(data.cerrado_en.slice(0, 10))}</span>
              : <span className="badge">Abierta</span>}
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div className="muted tiny">Progreso</div>
            <div className="mono">
              <span style={{ color: 'var(--pos)' }}>{matched}</span> matched ·{' '}
              <span style={{ color: 'var(--warn)' }}>{pendientes}</span> pendientes ·{' '}
              <span className="muted">{ignoradas}</span> ignoradas
            </div>
          </div>
        </div>
      </div>

      <div className="card card-flush">
        <div className="card-hd"><h3>Líneas del extracto · Matchear con tus movimientos</h3></div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Descripción</th>
                <th style={{ textAlign: 'right' }}>Monto</th>
                <th>Match con movimiento</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.lineas.map(l => (
                <tr key={l.id} style={{
                  background: l.matched_caja_mov_id ? 'rgba(34,197,94,0.05)'
                            : l.ignorada            ? 'rgba(0,0,0,0.03)'
                            : 'rgba(234,179,8,0.05)',
                }}>
                  <td className="mono tiny">{fmtFecha(l.fecha)}</td>
                  <td className="tiny">{l.descripcion || '—'}</td>
                  <td className="mono" style={{
                    textAlign: 'right',
                    fontWeight: 600,
                    color: Number(l.monto) > 0 ? 'var(--pos)' : 'var(--neg)',
                  }}>
                    {Number(l.monto) > 0 ? '+ ' : '- '}{fmt(Math.abs(Number(l.monto)))}
                  </td>
                  <td>
                    {l.ignorada ? (
                      <span className="muted tiny">— Ignorada —</span>
                    ) : (
                      <select
                        className="input"
                        style={{ height: 28, fontSize: 12, minWidth: 280 }}
                        disabled={cerrada}
                        value={l.matched_caja_mov_id || ''}
                        onChange={e => setMatch(l.id, e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">— Sin match —</option>
                        {data.movimientos_disponibles
                          .filter(m => {
                            // Solo libres O el que ya está matched a esta línea.
                            if (m.id === l.matched_caja_mov_id) return true;
                            const usado = data.lineas.some(x => x.id !== l.id && x.matched_caja_mov_id === m.id);
                            return !usado;
                          })
                          .map(m => (
                            <option key={m.id} value={m.id}>
                              {fmtFecha(m.fecha)} · {m.tipo === 'ingreso' ? '+' : '-'}{fmt(m.monto)} · {m.concepto || m.origen}
                            </option>
                          ))}
                      </select>
                    )}
                  </td>
                  <td>
                    {!cerrada && (
                      <button className="btn btn-sm btn-ghost" onClick={() => toggleIgnorada(l.id, l.ignorada)}>
                        {l.ignorada ? 'Restaurar' : 'Ignorar'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {!cerrada && pendientes > 0 && (
        <div className="muted tiny" style={{ marginTop: 8 }}>
          Tenés {pendientes} líneas pendientes. Para cerrar la conciliación, todas las líneas deben estar
          matcheadas o marcadas como "Ignorar".
        </div>
      )}
    </>
  );
}

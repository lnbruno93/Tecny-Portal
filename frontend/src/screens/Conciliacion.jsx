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
import { parseCsv, parseMonto, parseFecha } from '../lib/parsers';

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
      {/* 2026-06-19: h1 + subtítulo en div interno (sino space-between
          del page-head los separa horizontal). */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Conciliación bancaria</h1>
          <div className="page-sub">Importá el extracto del banco y matcheá con tu ledger.</div>
        </div>
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
      <div className="flex-between u-mb-12">
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
               <th className="u-text-right">Líneas</th>
               <th className="u-text-right">Matched</th>
               <th>Estado</th><th></th>
             </tr>
           </thead>
           <tbody>
             {items.map(c => (
               <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => onAbrir(c.id)}>
                 <td>{c.caja_nombre} <span className="muted tiny">({c.caja_moneda})</span></td>
                 <td className="mono tiny">{fmtFecha(c.fecha_desde)} → {fmtFecha(c.fecha_hasta)}</td>
                 <td className="mono u-text-right">{c.lineas_total}</td>
                 <td className="mono u-text-right">
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
              <label className="field-label">Caja a conciliar <span className="u-color-neg">*</span></label>
              <select className="input" value={cajaId} onChange={e => setCajaId(e.target.value)}>
                <option value="">— Elegí caja —</option>
                {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 160px' }}>
              <label className="field-label">Desde <span className="u-color-neg">*</span></label>
              <input type="date" className="input" value={fechaDesde} max={todayISO()} onChange={e => setFechaDesde(e.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 0 160px' }}>
              <label className="field-label">Hasta <span className="u-color-neg">*</span></label>
              <input type="date" className="input" value={fechaHasta} max={todayISO()} onChange={e => setFechaHasta(e.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 0 140px' }}>
              <label className="field-label">Tolerancia (días)</label>
              <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" max="30"
                     className="input mono" value={tolerancia}
                     onChange={e => setTolerancia(e.target.value)} />
              <div className="muted tiny u-mt-2">± días para auto-match</div>
            </div>
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <label className="field-label">Archivo del extracto (CSV o XLSX) <span className="u-color-neg">*</span></label>
            <input type="file" accept=".csv,.xlsx" onChange={handleArchivo}
                   disabled={!cajaId || !fechaDesde || !fechaHasta}
                   style={{ padding: '6px 0' }} />
            <div className="muted tiny u-mt-4">
              El archivo se procesa en tu navegador. Solo se mandan al servidor las líneas válidas (fecha + monto).
            </div>
          </div>
        </>
      )}

      {paso === 2 && (
        <>
          <div className="u-mb-10">
            <div className="muted tiny">Archivo: <strong>{archivoNombre}</strong> · {rows.length} filas detectadas</div>
          </div>
          <div className="row" style={{ gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: '0 0 200px' }}>
              <label className="field-label">Columna Fecha <span className="u-color-neg">*</span></label>
              <select className="input" value={map.fecha} onChange={e => setMap(m => ({ ...m, fecha: e.target.value }))}>
                <option value="">— Elegí —</option>
                {headers.map((h, i) => <option key={i} value={i}>{h || `Columna ${i + 1}`}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 200px' }}>
              <label className="field-label">Columna Monto <span className="u-color-neg">*</span></label>
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
  // Set de lineaIds en saving: muestra un spinner por línea sin pisar el resto.
  // Antes cada click llamaba setLoading(true)+reload → la pantalla parpadeaba
  // "Cargando…" y el usuario perdía contexto. Ahora solo la línea editada
  // se opaca/spin mientras la API responde.
  const [savingLineas, setSavingLineas] = useState(() => new Set());

  // initial=true sólo en el primer load. Refrescos posteriores no muestran
  // el spinner global — sólo actualizan data en background.
  function load({ initial = false } = {}) {
    if (initial) setLoading(true);
    return concApi.get(id).then(r => setData(r))
      .catch(e => toast.error(e.message))
      .finally(() => { if (initial) setLoading(false); });
  }
  useEffect(() => { load({ initial: true }); /* eslint-disable-next-line */ }, [id]);

  // Marca lineaId como "en saving", ejecuta la API call, y reload sin spinner global.
  async function withLineaSaving(lineaId, fn) {
    setSavingLineas(prev => { const next = new Set(prev); next.add(lineaId); return next; });
    try {
      await fn();
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingLineas(prev => { const next = new Set(prev); next.delete(lineaId); return next; });
    }
  }

  async function setMatch(lineaId, matchedId) {
    await withLineaSaving(lineaId, () =>
      concApi.updateLinea(id, lineaId, { matched_caja_mov_id: matchedId || null, ignorada: false })
    );
  }
  async function toggleIgnorada(lineaId, current) {
    await withLineaSaving(lineaId, () =>
      concApi.updateLinea(id, lineaId, { ignorada: !current, matched_caja_mov_id: null })
    );
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
      await load();
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
      <div className="flex-between u-mb-12">
        <button className="btn btn-ghost btn-sm" onClick={onVolver}>← Volver al listado</button>
        <div className="flex-row u-gap-8">
          {!cerrada && pendientes === 0 && (
            <button className="btn btn-primary" disabled={saving} onClick={cerrar}>
              {saving ? 'Cerrando…' : 'Cerrar conciliación'}
            </button>
          )}
          <button className="btn u-color-neg" onClick={eliminar}>Eliminar</button>
        </div>
      </div>

      <div className="card card-tight u-mb-12">
        <div className="flex-row" style={{ gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div className="muted tiny">Caja</div>
            <div className="u-fw-600">{data.caja_nombre} <span className="muted tiny">({data.caja_moneda})</span></div>
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
                <th className="u-text-right">Monto</th>
                <th>Match con movimiento</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.lineas.map(l => {
                const isSaving = savingLineas.has(l.id);
                return (
                <tr key={l.id} style={{
                  background: l.matched_caja_mov_id ? 'rgba(34,197,94,0.05)'
                            : l.ignorada            ? 'rgba(0,0,0,0.03)'
                            : 'rgba(234,179,8,0.05)',
                  opacity: isSaving ? 0.55 : 1,
                  transition: 'opacity 120ms',
                }} aria-busy={isSaving}>
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
                        disabled={cerrada || isSaving}
                        value={l.matched_caja_mov_id || ''}
                        onChange={e => setMatch(l.id, e.target.value ? Number(e.target.value) : null)}
                        aria-label={`Match para línea del ${fmtFecha(l.fecha)} por ${l.monto}`}
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
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={isSaving}
                        onClick={() => toggleIgnorada(l.id, l.ignorada)}
                      >
                        {isSaving ? '…' : (l.ignorada ? 'Restaurar' : 'Ignorar')}
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
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

import { useState, useEffect, useRef } from 'react';
import { Icons } from '../components/Icons';
import {
  comprobantes as compApi,
  pagos as pagosApi,
  vendedores as vendsApi,
  config as configApi,
  ocr as ocrApi,
} from '../lib/api';
import { exportCsv } from '../lib/exportCsv';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmt(n) {
  const v = Math.abs(Number(n));
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K';
  return Math.round(v).toLocaleString('es-AR');
}

function fmtARS(n) {
  return 'ARS ' + fmt(n);
}

function fmtFecha(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate.includes('T') ? isoDate : isoDate + 'T00:00:00');
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TIPOS_PAGO = [
  'Efectivo',
  'Transferencia BBVA LB',
  'Transferencia BBVA GL',
  'Recaudadora',
  'USD',
  'USDT',
  'USD BBVA LB',
  'USD BBVA GL',
  'Tarjeta de Crédito',
  'PayPal',
  'Takenos',
];

// ─── Helper components ───────────────────────────────────────────────────────

function Badge({ tone = 'default', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Status({ tone = 'default', children }) {
  return <span className={`status s-${tone}`}>{children}</span>;
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function Financiera() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const [tab, setTab] = useState('dashboard');
  const [pct, setPct] = useState(3);
  const [vendedores, setVendedores] = useState([]);

  // Dashboard
  const [dashData, setDashData] = useState(null);
  const [recentComps, setRecentComps] = useState([]);

  // Comprobantes tab
  const [comps, setComps] = useState([]);
  const [compSearch, setCompSearch] = useState('');
  const [compVendFilter, setCompVendFilter] = useState('todos');
  const [loadingComps, setLoadingComps] = useState(false);

  // Cargar tab (form state)
  const [cFecha, setCFecha] = useState(new Date().toLocaleDateString('sv'));
  const [cCliente, setCCliente] = useState('');
  const [cVendId, setCVendId] = useState('');
  const [cMonto, setCMonto] = useState('');
  const [cTipo, setCTipo] = useState('Transferencia BBVA LB');
  const [cFile, setCFile] = useState(null); // { name, base64, size, mimeType }
  const [ocrResult, setOcrResult] = useState(null); // { monto }
  const [ocrLoading, setOcrLoading] = useState(false);
  // Visor del comprobante adjunto
  const [viewFile, setViewFile] = useState(null); // { src, nombre, tipo } | 'loading' | null
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const fileInputRef = useRef(null);

  // Pagos tab
  const [pagosList, setPagosList] = useState([]);
  const [pagosTotales, setPagosTotales] = useState(null);
  const [pFecha, setPFecha] = useState(new Date().toLocaleDateString('sv'));
  const [pMonto, setPMonto] = useState('');
  const [pRef, setPRef] = useState('');
  const [savingPago, setSavingPago] = useState(false);

  // Vendedores tab
  const [newVend, setNewVend] = useState('');
  const [savingVend, setSavingVend] = useState(false);

  // Inline error states (replaces silent console.error)
  const [dashError, setDashError] = useState('');
  const [compsError, setCompsError] = useState('');
  const [pagosError, setPagosError] = useState('');

  // ── Live calculations ──────────────────────────────────────────────────────
  const monto = parseFloat(cMonto) || 0;
  const finCalc = monto * (pct / 100);
  const netoCalc = monto - finCalc;

  // ── Client-side filter for comprobantes ───────────────────────────────────
  const filteredComps = compSearch
    ? comps.filter(c => c.cliente?.toLowerCase().includes(compSearch.toLowerCase()))
    : comps;

  // ── Vendor lookup helper ───────────────────────────────────────────────────
  const vendName = (id) => vendedores.find(v => v.id === id)?.nombre || '—';

  // ── Load config + vendedores on mount ─────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    Promise.all([configApi.get(), vendsApi.list()])
      .then(([cfg, vends]) => {
        if (!mounted) return;
        setPct(parseFloat(cfg.pct_financiera) || 3);
        setVendedores(vends);
      })
      .catch(console.error);
    return () => { mounted = false; };
  }, []);

  // ── Dashboard data ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'dashboard') return;
    let mounted = true;
    setDashError('');
    const todayStr = new Date().toLocaleDateString('sv');
    Promise.all([
      compApi.totales({ desde: todayStr, hasta: todayStr }),
      compApi.list({ limit: 6 }),
    ])
      .then(([totals, list]) => {
        if (!mounted) return;
        setDashData(totals);
        setRecentComps(list.data || []);
      })
      .catch(err => { if (mounted) setDashError(err.message); });
    return () => { mounted = false; };
  }, [tab]);

  // ── Comprobantes tab ───────────────────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'comprobantes') return;
    let mounted = true;
    setLoadingComps(true);
    setCompsError('');
    const params = {};
    if (compVendFilter !== 'todos') params.vendedor = compVendFilter;
    compApi
      .list(params)
      .then(res => { if (mounted) setComps(res.data || []); })
      .catch(err => { if (mounted) setCompsError(err.message); })
      .finally(() => { if (mounted) setLoadingComps(false); });
    return () => { mounted = false; };
  }, [tab, compVendFilter]);

  // ── Pagos tab ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'pagos') return;
    let mounted = true;
    setPagosError('');
    Promise.all([pagosApi.list(), pagosApi.totales()])
      .then(([list, tots]) => {
        if (!mounted) return;
        setPagosList(list.data || []);
        setPagosTotales(tots);
      })
      .catch(err => { if (mounted) setPagosError(err.message); });
    return () => { mounted = false; };
  }, [tab]);

  // ── OCR file handling ──────────────────────────────────────────────────────
  async function handleFile(file) {
    if (!file || !file.type.match(/image\/(jpeg|png|webp)|application\/pdf/)) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target.result;
      const base64 = dataUrl.split(',')[1];
      setCFile({ name: file.name, size: file.size, base64, mimeType: file.type });
      // OCR para imágenes y PDF (Claude procesa ambos nativamente)
      if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.type)) { setOcrResult(null); return; }
      setOcrLoading(true);
      setOcrResult(null);
      try {
        const result = await ocrApi.extract(base64, file.type);  // { monto }
        setOcrResult(result);
        if (result.monto) setCMonto(String(result.monto));
      } catch (err) {
        console.warn('OCR error:', err);
      } finally {
        setOcrLoading(false);
      }
    };
    reader.readAsDataURL(file);
  }

  // Abrir/ver el archivo adjunto de un comprobante (se trae bajo demanda, no viaja en el listado)
  async function openArchivo(id) {
    setViewFile('loading');
    try {
      const r = await compApi.archivo(id); // { data, nombre, tipo }
      const src = r.data.startsWith('data:') ? r.data : `data:${r.tipo || 'image/png'};base64,${r.data}`;
      setViewFile({ src, nombre: r.nombre, tipo: r.tipo });
    } catch (err) {
      toast.error(err.message || 'No se pudo abrir el archivo.');
      setViewFile(null);
    }
  }

  // ── Save comprobante ───────────────────────────────────────────────────────
  async function handleSaveComprobante() {
    if (!cCliente.trim()) { setSaveError('El cliente es requerido'); return; }
    if (!cVendId) { setSaveError('Seleccioná un vendedor'); return; }
    if (!cMonto || Number(cMonto) <= 0) { setSaveError('El monto debe ser mayor a 0'); return; }
    setSaving(true);
    setSaveError('');
    try {
      const montoNum = Number(cMonto);
      const montoFin = montoNum * (pct / 100);
      const montoNeto = montoNum - montoFin;

      await compApi.create({
        fecha: cFecha,
        cliente: cCliente.trim(),
        vendedor_id: Number(cVendId),
        monto: montoNum,
        monto_financiera: montoFin,
        monto_neto: montoNeto,
        referencia: cTipo || null,
        archivo_data: cFile?.base64 || null,
        archivo_nombre: cFile?.name || null,
        archivo_tipo: cFile?.mimeType || null,
      });
      // Reset form and switch to comprobantes tab
      setCCliente('');
      setCVendId('');
      setCMonto('');
      setCTipo('Transferencia BBVA LB');
      setCFile(null);
      setOcrResult(null);
      setTab('comprobantes');
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Delete comprobante ────────────────────────────────────────────────���────
  async function handleDeleteComp(id) {
    const ok = await confirm({ title: 'Eliminar comprobante', message: 'Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await compApi.delete(id);
      setComps(prev => prev.filter(c => c.id !== id));
      toast.success('Comprobante eliminado.');
    } catch (e) {
      toast.error(e.message);
    }
  }

  // ── Save pago ──────────────────────────────────────────────────────────────
  async function handleSavePago() {
    if (!pMonto || Number(pMonto) <= 0) return;
    setSavingPago(true);
    try {
      const nuevo = await pagosApi.create({
        fecha: pFecha,
        monto: Number(pMonto),
        referencia: pRef || null,
      });
      setPagosList(prev => [nuevo, ...prev]);
      setPMonto('');
      setPRef('');
      const tots = await pagosApi.totales();
      setPagosTotales(tots);
      toast.success('Pago registrado.');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingPago(false);
    }
  }

  // ── Vendedores CRUD ────────────────────────────────────────────────────────
  async function handleAddVend() {
    if (!newVend.trim()) return;
    setSavingVend(true);
    try {
      const v = await vendsApi.create({ nombre: newVend.trim() });
      setVendedores(prev => [...prev, v]);
      setNewVend('');
      toast.success(`Vendedor "${v.nombre}" creado.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingVend(false);
    }
  }

  async function handleDeleteVend(id) {
    const ok = await confirm({ title: 'Eliminar vendedor', message: 'Se eliminarán también sus estadísticas asociadas.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await vendsApi.delete(id);
      setVendedores(prev => prev.filter(v => v.id !== id));
      toast.success('Vendedor eliminado.');
    } catch (e) {
      toast.error(e.message);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Page head */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Financiera</h1>
          <div className="page-sub">
            Comprobantes, pagos y OCR · retención al {pct.toFixed(1)}%
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setTab('cargar')}>
            <Icons.Upload size={14} /> Cargar OCR
          </button>
          <button className="btn btn-primary" onClick={() => setTab('cargar')}>
            <Icons.Plus size={14} /> Nuevo comprobante
          </button>
        </div>
      </div>

      {/* Tabs bar */}
      <div className="tabs" style={{ marginBottom: 20 }}>
        {[
          { value: 'dashboard',    label: 'Dashboard' },
          { value: 'cargar',       label: 'Cargar' },
          { value: 'comprobantes', label: 'Comprobantes' },
          { value: 'pagos',        label: 'Pagos' },
          { value: 'vendedores',   label: 'Vendedores' },
        ].map(t => (
          <button
            key={t.value}
            className={'tab' + (tab === t.value ? ' active' : '')}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════════
          DASHBOARD TAB
      ════════════════════════════════════════════════════════ */}
      {tab === 'dashboard' && (
        <>
          {dashError && (
            <div className="card" style={{ padding: '12px 16px', color: 'var(--neg)', fontSize: 13, marginBottom: 16 }}>
              Error cargando dashboard: {dashError}
            </div>
          )}
          {/* KPI cards */}
          <div className="row" style={{ marginBottom: 16 }}>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Monto bruto · hoy</div>
              <div className="kpi-value">
                <span className="ccy">ARS </span>
                <span className="mono">{fmt(dashData?.total_monto ?? 0)}</span>
              </div>
              <div className="muted tiny" style={{ marginTop: 6 }}>
                {dashData?.count ?? 0} comprobantes hoy
              </div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Retención financiera</div>
              <div className="kpi-value">
                <span className="ccy">ARS </span>
                <span className="mono" style={{ color: 'var(--accent)' }}>
                  {fmt(dashData?.total_financiera ?? 0)}
                </span>
              </div>
              <div className="muted tiny" style={{ marginTop: 6 }}>
                {pct.toFixed(1)}% del bruto
              </div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Nos queda · neto</div>
              <div className="kpi-value">
                <span className="ccy">ARS </span>
                <span className="mono pos">{fmt(dashData?.total_neto ?? 0)}</span>
              </div>
              <div className="muted tiny" style={{ marginTop: 6 }}>
                bruto − retención
              </div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Vendedores activos</div>
              <div className="kpi-value mono">{vendedores.length}</div>
              <div className="muted tiny" style={{ marginTop: 6 }}>
                en el equipo
              </div>
            </div>
          </div>

          {/* Recent comprobantes table */}
          <div className="card card-flush">
            <div className="card-hd">
              <h3>Comprobantes recientes</h3>
              <div className="flex-row" style={{ gap: 8 }}>
                <button
                  className="btn btn-sm"
                  onClick={() => exportCsv(
                    'comprobantes-recientes-' + new Date().toLocaleDateString('sv') + '.csv',
                    recentComps,
                    [
                      { key: 'fecha',      label: 'Fecha'      },
                      { key: 'cliente',    label: 'Cliente'    },
                      { key: 'tipo_pago',  label: 'Tipo pago'  },
                      { key: 'monto',      label: 'Monto'      },
                      { key: 'vendedor',   label: 'Vendedor'   },
                    ]
                  )}
                >
                  <Icons.Download size={13} /> Exportar CSV
                </button>
              </div>
            </div>
            {recentComps.length === 0 ? (
              <div className="empty">Sin comprobantes hoy</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Cliente</th>
                    <th>Vendedor</th>
                    <th>Forma de pago</th>
                    <th className="num">Bruto</th>
                    <th className="num">Retención</th>
                    <th className="num">Neto</th>
                    <th>Adjunto</th>
                  </tr>
                </thead>
                <tbody>
                  {recentComps.map(c => (
                    <tr key={c.id} className="tbl-row-click">
                      <td className="muted">{fmtFecha(c.fecha)}</td>
                      <td style={{ fontWeight: 600 }}>{c.cliente}</td>
                      <td className="muted">{c.vendedor_nombre || vendName(c.vendedor_id)}</td>
                      <td><Badge>{c.referencia || '—'}</Badge></td>
                      <td className="num mono">
                        <span className="muted" style={{ fontWeight: 500 }}>ARS </span>
                        {fmt(c.monto)}
                      </td>
                      <td className="num mono" style={{ color: 'var(--accent)' }}>
                        {fmt(c.monto_financiera)}
                      </td>
                      <td className="num mono pos" style={{ fontWeight: 600 }}>
                        {fmt(c.monto_neto)}
                      </td>
                      <td>
                        {c.tiene_archivo
                          ? <button type="button" className="btn btn-ghost btn-sm"
                              onClick={(e) => { e.stopPropagation(); openArchivo(c.id); }}>
                              <Icons.Eye size={13} /> Ver
                            </button>
                          : <span className="dim">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ════════════════════════════════════════════════════════
          CARGAR TAB
      ════════════════════════════════════════════════════════ */}
      {tab === 'cargar' && (
        <div className="split-2">
          {/* Form card */}
          <div className="card">
            <div className="card-hd">
              <div>
                <h3>Nuevo comprobante</h3>
                <div className="muted tiny">Los porcentajes se calculan automáticamente</div>
              </div>
            </div>
            <div style={{ padding: '0 18px 18px' }}>
              {/* Row 1: fecha + cliente */}
              <div className="row" style={{ marginBottom: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <div className="field-label">Fecha de pago</div>
                  <input
                    type="date"
                    className="input mono"
                    value={cFecha}
                    onChange={e => setCFecha(e.target.value)}
                  />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <div className="field-label">Cliente</div>
                  <input
                    className="input"
                    placeholder="Nombre completo"
                    value={cCliente}
                    onChange={e => setCCliente(e.target.value)}
                  />
                </div>
              </div>

              {/* Row 2: vendedor + monto */}
              <div className="row" style={{ marginBottom: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <div className="field-label">Vendedor</div>
                  <select
                    className="input"
                    value={cVendId}
                    onChange={e => setCVendId(e.target.value)}
                  >
                    <option value="">Seleccionar…</option>
                    {vendedores.map(v => (
                      <option key={v.id} value={v.id}>{v.nombre}</option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <div className="field-label">Monto bruto (ARS)</div>
                  <div className="input-group">
                    <span className="addon addon-l" style={{ color: 'var(--accent)' }}>$</span>
                    <input
                      type="number"
                      className="input mono"
                      placeholder="0,00"
                      value={cMonto}
                      onChange={e => setCMonto(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Forma de pago */}
              <div className="field" style={{ marginBottom: 12 }}>
                <div className="field-label">Forma de pago</div>
                <select
                  className="input"
                  value={cTipo}
                  onChange={e => setCTipo(e.target.value)}
                >
                  {TIPOS_PAGO.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              {/* Dropzone */}
              <div className="field" style={{ marginBottom: 18 }}>
                <div className="field-label">Comprobante adjunto</div>
                <div
                  className="dropzone"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,.pdf"
                    style={{ display: 'none' }}
                    onChange={e => handleFile(e.target.files[0])}
                  />
                  {ocrLoading ? (
                    <>
                      <Icons.Sparkle size={28} style={{ color: 'var(--accent)' }} />
                      <div style={{ fontWeight: 600, fontSize: 14 }}>Procesando OCR…</div>
                      <div className="muted tiny">Claude está extrayendo el monto</div>
                    </>
                  ) : cFile ? (
                    <>
                      <Icons.Sparkle size={28} style={{ color: 'var(--accent)' }} />
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{cFile.name}</div>
                      <div className="muted tiny">
                        {(cFile.size / 1024).toFixed(0)} KB
                        {ocrResult && ocrResult.monto && ` · OCR extrajo ${fmtARS(ocrResult.monto)}`}
                      </div>
                    </>
                  ) : (
                    <>
                      <Icons.Camera size={32} />
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        Imagen o PDF · OCR automático
                      </div>
                      <div className="muted tiny">
                        JPG, PNG, WEBP, PDF · máx 5 MB · 10 OCR/h por usuario
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Live calc summary */}
              <div style={{
                padding: '14px 16px',
                background: 'var(--surface-2)',
                borderRadius: 10,
                border: '1px solid var(--border)',
                marginBottom: 16,
              }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
                  <div>
                    <div className="muted tiny" style={{ fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      Total ingresado
                    </div>
                    <div className="mono" style={{ fontSize: 17, fontWeight: 600, marginTop: 4 }}>
                      ${fmt(monto)}
                    </div>
                  </div>
                  <div>
                    <div className="muted tiny" style={{ fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      Retención ({pct.toFixed(1)}%)
                    </div>
                    <div className="mono" style={{ fontSize: 17, fontWeight: 600, marginTop: 4, color: 'var(--accent)' }}>
                      ${fmt(finCalc)}
                    </div>
                  </div>
                  <div>
                    <div className="muted tiny" style={{ fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      Nos queda
                    </div>
                    <div className="mono pos" style={{ fontSize: 17, fontWeight: 600, marginTop: 4 }}>
                      ${fmt(netoCalc)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Error */}
              {saveError && (
                <div style={{ color: 'var(--neg)', fontSize: 13, marginBottom: 12 }}>
                  {saveError}
                </div>
              )}

              {/* Actions */}
              <div className="flex-row" style={{ gap: 8 }}>
                <button
                  className="btn btn-primary"
                  onClick={handleSaveComprobante}
                  disabled={saving}
                >
                  <Icons.Check size={14} />
                  {saving ? 'Guardando…' : 'Guardar comprobante'}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setCCliente('');
                    setCVendId('');
                    setCMonto('');
                    setCTipo('Transferencia BBVA LB');
                    setCFile(null);
                    setOcrResult(null);
                    setSaveError('');
                  }}
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>

          {/* Info card */}
          <div className="card">
            <div className="card-hd">
              <h3>¿Cómo funciona la retención?</h3>
            </div>
            <div style={{ padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <div className="muted tiny" style={{ fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                  Modelo
                </div>
                <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                  Por cada comprobante registrado, la financiera retiene un % global configurable.
                  El resto queda como saldo a cobrar — se liquida con pagos posteriores.
                </div>
              </div>
              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />
              <div>
                <div className="muted tiny" style={{ fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                  OCR automático
                </div>
                <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                  Subí una foto del comprobante y el sistema detecta el monto con Claude.
                  Si la confianza es alta (&gt;70%), se pre-llena. Si es baja, te avisa para que verifiques.
                </div>
              </div>
              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />
              <div>
                <div className="muted tiny" style={{ fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
                  Formatos aceptados
                </div>
                <div className="flex-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <Badge>JPG</Badge>
                  <Badge>PNG</Badge>
                  <Badge>WEBP</Badge>
                  <Badge>PDF</Badge>
                  <Badge tone="info">máx 5 MB</Badge>
                </div>
              </div>
              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />
              <div>
                <div className="muted tiny" style={{ fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                  Porcentaje actual
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--accent)' }}>
                  {pct.toFixed(1)}%
                </div>
                <div className="muted tiny" style={{ marginTop: 4 }}>
                  Configurable en Ajustes del portal
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          COMPROBANTES TAB
      ════════════════════════════════════════════════════════ */}
      {tab === 'comprobantes' && (
        <div className="card card-flush">
          <div className="card-hd">
            <h3>Comprobantes — {filteredComps.length}</h3>
            <div className="flex-row" style={{ gap: 8 }}>
              <div className="input-group" style={{ width: 220 }}>
                <span className="addon addon-l"><Icons.Search size={14} /></span>
                <input
                  className="input"
                  placeholder="Buscar cliente…"
                  value={compSearch}
                  onChange={e => setCompSearch(e.target.value)}
                />
              </div>
              <select
                className="input"
                style={{ width: 200 }}
                value={compVendFilter}
                onChange={e => setCompVendFilter(e.target.value)}
              >
                <option value="todos">Todos los vendedores</option>
                {vendedores.map(v => (
                  <option key={v.id} value={v.nombre}>{v.nombre}</option>
                ))}
              </select>
            </div>
          </div>
          {compsError ? (
            <div style={{ padding: '12px 16px', color: 'var(--neg)', fontSize: 13 }}>
              Error cargando comprobantes: {compsError}
            </div>
          ) : loadingComps ? (
            <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
              Cargando…
            </div>
          ) : filteredComps.length === 0 ? (
            <div className="empty">Sin comprobantes</div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Cliente</th>
                  <th>Vendedor</th>
                  <th>Forma de pago</th>
                  <th className="num">Bruto</th>
                  <th className="num">Retención</th>
                  <th className="num">Neto</th>
                  <th>Archivo</th>
                  <th style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredComps.map(c => (
                  <tr key={c.id} className="tbl-row-click">
                    <td className="muted">{fmtFecha(c.fecha)}</td>
                    <td style={{ fontWeight: 600 }}>{c.cliente}</td>
                    <td>{c.vendedor_nombre || vendName(c.vendedor_id)}</td>
                    <td><Badge>{c.referencia || '—'}</Badge></td>
                    <td className="num mono">
                      <span className="muted" style={{ fontWeight: 500 }}>ARS </span>
                      {fmt(c.monto)}
                    </td>
                    <td className="num mono" style={{ color: 'var(--accent)' }}>
                      {fmt(c.monto_financiera)}
                    </td>
                    <td className="num mono pos" style={{ fontWeight: 600 }}>
                      {fmt(c.monto_neto)}
                    </td>
                    <td>
                      {c.tiene_archivo
                        ? <button className="icon-btn" title="Ver comprobante"
                            onClick={(e) => { e.stopPropagation(); openArchivo(c.id); }}>
                            <Icons.Eye size={15} />
                          </button>
                        : <span className="dim tiny">—</span>}
                    </td>
                    <td>
                      <div className="flex-row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <button className="icon-btn" onClick={() => handleDeleteComp(c.id)}>
                          <Icons.Trash size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          PAGOS TAB
      ════════════════════════════════════════════════════════ */}
      {tab === 'pagos' && (
        <div className="split-2">
          {pagosError && (
            <div style={{ gridColumn: '1 / -1', padding: '12px 16px', color: 'var(--neg)', fontSize: 13, background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)' }}>
              Error cargando pagos: {pagosError}
            </div>
          )}
          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Register pago */}
            <div className="card">
              <div className="card-hd">
                <div>
                  <h3>Registrar pago de financiera</h3>
                  <div className="muted tiny">Liquidaciones que recibimos</div>
                </div>
              </div>
              <div style={{ padding: '0 18px 18px' }}>
                <div className="row" style={{ marginBottom: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <div className="field-label">Fecha</div>
                    <input
                      type="date"
                      className="input mono"
                      value={pFecha}
                      onChange={e => setPFecha(e.target.value)}
                    />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <div className="field-label">Monto (ARS)</div>
                    <div className="input-group">
                      <span className="addon addon-l" style={{ color: 'var(--accent)' }}>$</span>
                      <input
                        type="number"
                        className="input mono"
                        placeholder="0,00"
                        value={pMonto}
                        onChange={e => setPMonto(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
                <div className="field" style={{ marginBottom: 14 }}>
                  <div className="field-label">Referencia</div>
                  <input
                    className="input"
                    placeholder="Ej: Liquidación semana 4 mayo"
                    value={pRef}
                    onChange={e => setPRef(e.target.value)}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  onClick={handleSavePago}
                  disabled={savingPago}
                >
                  <Icons.Check size={14} />
                  {savingPago ? 'Registrando…' : 'Registrar pago'}
                </button>
              </div>
            </div>

            {/* Estado de cuenta */}
            {pagosTotales && (
              <div className="card">
                <div className="card-hd">
                  <h3>Estado de cuenta</h3>
                </div>
                <div style={{ padding: '0 18px 18px' }}>
                  <div className="row" style={{ marginBottom: 16 }}>
                    <div style={{ flex: 1 }}>
                      <div className="muted tiny" style={{ fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        Recibido
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 4 }}>
                        <span className="muted" style={{ fontSize: 12 }}>ARS </span>
                        <span className="mono pos">{fmt(pagosTotales.total_monto)}</span>
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="muted tiny" style={{ fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        N° pagos
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 4 }}>
                        <span className="mono">{pagosTotales.count}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right: pagos table */}
          <div className="card card-flush">
            <div className="card-hd">
              <h3>Pagos recibidos</h3>
            </div>
            {pagosList.length === 0 ? (
              <div className="empty">Sin pagos registrados</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Referencia</th>
                    <th className="num">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {pagosList.map(p => (
                    <tr key={p.id}>
                      <td className="muted">{fmtFecha(p.fecha)}</td>
                      <td>{p.referencia || <span className="dim">—</span>}</td>
                      <td className="num mono pos" style={{ fontWeight: 600 }}>
                        +{fmt(p.monto)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          VENDEDORES TAB
      ════════════════════════════════════════════════════════ */}
      {tab === 'vendedores' && (
        <div className="card card-flush">
          <div className="card-hd">
            <div>
              <h3>Equipo de ventas</h3>
              <div className="muted tiny">
                Asignan comprobantes — no son usuarios del portal
              </div>
            </div>
          </div>
          <div style={{ padding: 16 }}>
            {/* Add vendedor */}
            <div className="input-group" style={{ marginBottom: 16, maxWidth: 360 }}>
              <input
                className="input"
                placeholder="Nombre del nuevo vendedor"
                value={newVend}
                onChange={e => setNewVend(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddVend()}
              />
              <button
                className="addon"
                style={{
                  background: 'var(--accent)',
                  color: 'var(--accent-ink)',
                  cursor: 'pointer',
                  fontWeight: 700,
                  padding: '0 14px',
                  border: 'none',
                }}
                onClick={handleAddVend}
                disabled={savingVend}
              >
                {savingVend ? '…' : 'Agregar'}
              </button>
            </div>

            {/* Vendedores list */}
            {vendedores.length === 0 ? (
              <div className="empty">Sin vendedores registrados</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {vendedores.map(v => (
                  <div
                    key={v.id}
                    className="flex-between"
                    style={{
                      padding: '12px 14px',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                    }}
                  >
                    <div className="flex-row" style={{ gap: 12 }}>
                      <div style={{
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        background: 'var(--surface-3)',
                        display: 'grid',
                        placeItems: 'center',
                        fontWeight: 700,
                        fontSize: 11,
                      }}>
                        {v.nombre.split(' ').map(p => p[0]).slice(0, 2).join('')}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600 }}>{v.nombre}</div>
                        <div className="muted tiny">
                          {comps.filter(c => c.vendedor_id === v.id).length} comprobantes
                        </div>
                      </div>
                    </div>
                    <button className="icon-btn" onClick={() => handleDeleteVend(v.id)}>
                      <Icons.Trash size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Visor de comprobante adjunto ──────────────────────────────────── */}
      {viewFile && (
        <div className="modal-overlay" onClick={() => setViewFile(null)}>
          <div className="modal" style={{ maxWidth: 720 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>{viewFile === 'loading' ? 'Cargando…' : (viewFile.nombre || 'Comprobante')}</h3>
              <button className="icon-btn" onClick={() => setViewFile(null)}><Icons.X size={16} /></button>
            </div>
            <div className="modal-body" style={{ textAlign: 'center' }}>
              {viewFile === 'loading' ? (
                <div className="empty">Cargando archivo…</div>
              ) : viewFile.tipo === 'application/pdf' ? (
                <iframe title="comprobante" src={viewFile.src} style={{ width: '100%', height: '70vh', border: 0 }} />
              ) : (
                <img src={viewFile.src} alt={viewFile.nombre || 'comprobante'} style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 8 }} />
              )}
            </div>
            {viewFile !== 'loading' && (
              <div className="modal-ft">
                <a className="btn btn-ghost" href={viewFile.src} download={viewFile.nombre || 'comprobante'}>Descargar</a>
                <button className="btn btn-primary" onClick={() => setViewFile(null)}>Cerrar</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { Icons } from '../components/Icons';
import {
  comprobantes as compApi,
  pagos as pagosApi,
  vendedores as vendsApi,
  config as configApi,
  ocr as ocrApi,
  cajas as cajasApi,
} from '../lib/api';
import { exportCsv } from '../lib/exportCsv';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import CajaSelectHint from '../components/CajaSelectHint';


// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtARS(n) {
  return 'ARS ' + fmt(n);
}

// ─── Constants ───────────────────────────────────────────────────────────────


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

  // Rango del dashboard (KPIs + recientes). Default 'hoy' para no romper el
  // flujo operacional del día. Cuando hay ventas previas cargadas con fechas
  // pasadas, el operador puede cambiar a "Mes pasado" o un rango custom para
  // ver el agregado real. Se persiste en localStorage para no resetear cada
  // vez que recarga la pantalla.
  const RANGE_KEY = 'fin_dash_range';
  const [dashRange, setDashRange] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
      if (saved && saved.preset) return saved;
    } catch { /* ignore */ }
    return { preset: 'hoy', desde: '', hasta: '' };
  });
  useEffect(() => {
    try { localStorage.setItem(RANGE_KEY, JSON.stringify(dashRange)); } catch { /* ignore */ }
  }, [dashRange]);

  // Calcular { desde, hasta } a partir del preset. Para 'custom' usa los
  // valores del propio dashRange. Para 'todo' devuelve null/null para que
  // el caller NO pase desde/hasta al backend (= sin filtro). Toda fecha en
  // YYYY-MM-DD (string) — el backend la parsea como DATE sin shift de zona.
  function resolveRange(r) {
    const today = new Date().toLocaleDateString('sv');
    if (r.preset === 'todo') return { desde: null, hasta: null };
    if (r.preset === 'custom') return { desde: r.desde || today, hasta: r.hasta || today };
    const now = new Date();
    if (r.preset === 'mes_actual') {
      const y = now.getFullYear(), m = now.getMonth();
      return {
        desde: new Date(y, m, 1).toLocaleDateString('sv'),
        hasta: new Date(y, m + 1, 0).toLocaleDateString('sv'),
      };
    }
    if (r.preset === 'mes_pasado') {
      const y = now.getFullYear(), m = now.getMonth();
      return {
        desde: new Date(y, m - 1, 1).toLocaleDateString('sv'),
        hasta: new Date(y, m, 0).toLocaleDateString('sv'),
      };
    }
    // 'hoy' (default)
    return { desde: today, hasta: today };
  }

  // Construye el objeto de params para los endpoints. Si desde/hasta son null
  // (preset 'todo'), los OMITIMOS del payload — el backend interpreta su
  // ausencia como "sin filtro de fecha" y devuelve todo el histórico.
  function rangeToParams(r) {
    const { desde, hasta } = resolveRange(r);
    const params = {};
    if (desde) params.desde = desde;
    if (hasta) params.hasta = hasta;
    return params;
  }

  // Label corto del rango (para mostrar en KPIs en lugar de "hoy").
  function rangeLabel(r) {
    if (r.preset === 'todo') return 'todo el período';
    if (r.preset === 'hoy') return 'hoy';
    if (r.preset === 'mes_actual') return 'este mes';
    if (r.preset === 'mes_pasado') return 'mes pasado';
    const { desde, hasta } = resolveRange(r);
    return desde === hasta ? desde : `${desde} → ${hasta}`;
  }

  // Comprobantes tab
  const [comps, setComps] = useState([]);
  const [compsTotal, setCompsTotal] = useState(0);          // total real (pagination.total)
  const [compSearch, setCompSearch] = useState('');
  const [compVendFilter, setCompVendFilter] = useState('todos');
  const [loadingComps, setLoadingComps] = useState(false);

  // Rango de fechas para la tab Comprobantes — mismo patrón que Dashboard
  // pero default 'mes_actual' (no 'hoy'): en esta tab el operador busca y
  // revisa, no carga del día; el mes corriente es el scope típico.
  const COMP_RANGE_KEY = 'fin_comps_range';
  const [compRange, setCompRange] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COMP_RANGE_KEY) || 'null');
      if (saved && saved.preset) return saved;
    } catch { /* ignore */ }
    return { preset: 'mes_actual', desde: '', hasta: '' };
  });
  useEffect(() => {
    try { localStorage.setItem(COMP_RANGE_KEY, JSON.stringify(compRange)); } catch { /* ignore */ }
  }, [compRange]);

  // Cargar tab (form state)
  const [cFecha, setCFecha] = useState(new Date().toLocaleDateString('sv'));
  const [cCliente, setCCliente] = useState('');
  const [cVendId, setCVendId] = useState('');
  const [cMonto, setCMonto] = useState('');
  const [cFile, setCFile] = useState(null); // { name, base64, size, mimeType }
  const [ocrResult, setOcrResult] = useState(null); // { monto }
  const [ocrLoading, setOcrLoading] = useState(false);
  // Visor del comprobante adjunto
  const [viewFile, setViewFile] = useState(null); // { src, nombre, tipo } | 'loading' | null
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const fileInputRef = useRef(null);

  // Pagos tab — registro de pagos que recibimos de la financiera.
  //
  // Junio 2026: el form replica el patrón USD × TC = ARS de Tarjetas.
  // Casi siempre la financiera deposita en USD a un TC del día, cancelando
  // el saldo ARS pendiente. Los 3 inputs (usd, tc, ars) son editables y se
  // auto-completan entre sí; el operador puede sobreescribir cualquiera
  // para reflejar redondeos exactos del comprobante.
  //
  //   · USD recibido → entra a la caja USD destino.
  //   · TC del día   → se persiste en el pago para trazabilidad.
  //   · ARS          → descuenta del saldo pendiente con la financiera.
  //   · Caja destino → obligatoria; filtrada por moneda según el toggle.
  //
  // La elección "Convertir a USD" se persiste en localStorage para que la
  // próxima vez arranque con la misma config (espejo de Tarjetas).
  const [pagosList, setPagosList] = useState([]);
  const [pagosTotales, setPagosTotales] = useState(null);
  const [cajasList, setCajasList] = useState([]);
  const PAGO_USD_KEY = 'fin_pago_convertir_usd';
  const initialConvertirUSD = (() => {
    try { return localStorage.getItem(PAGO_USD_KEY) === '1'; } catch { return false; }
  })();
  const [pagoForm, setPagoForm] = useState({
    fecha:         new Date().toLocaleDateString('sv'),
    monto:         '',  // ARS — descuenta del saldo
    usd_recibido:  '',  // USD que entra a la caja
    tc:            '',
    caja_id:       '',
    referencia:    '',
    convertir_usd: initialConvertirUSD,
  });
  const [savingPago, setSavingPago] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(PAGO_USD_KEY, pagoForm.convertir_usd ? '1' : '0'); } catch { /* ignore */ }
  }, [pagoForm.convertir_usd]);

  // Helper de redondeo a 2 decimales (igual que Tarjetas).
  const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

  // Handlers de los 3 inputs enlazados. Cuando editás uno, los otros se
  // recalculan si hay info suficiente (USD × TC = ARS). Solo el handler del
  // campo editado dispara el recálculo → no hay loops circulares.
  const setPagoArs = (v) => {
    setPagoForm(f => {
      const ars = Number(v), tc = Number(f.tc);
      const next = { ...f, monto: v };
      if (Number.isFinite(ars) && ars > 0 && Number.isFinite(tc) && tc > 0) {
        next.usd_recibido = String(round2(ars / tc));
      }
      return next;
    });
  };
  const setPagoTc = (v) => {
    setPagoForm(f => {
      const tc = Number(v), usd = Number(f.usd_recibido), ars = Number(f.monto);
      const next = { ...f, tc: v };
      if (Number.isFinite(tc) && tc > 0) {
        if (Number.isFinite(usd) && usd > 0) next.monto = String(round2(usd * tc));
        else if (Number.isFinite(ars) && ars > 0) next.usd_recibido = String(round2(ars / tc));
      }
      return next;
    });
  };
  const setPagoUsd = (v) => {
    setPagoForm(f => {
      const usd = Number(v), tc = Number(f.tc);
      const next = { ...f, usd_recibido: v };
      if (Number.isFinite(usd) && usd > 0 && Number.isFinite(tc) && tc > 0) {
        next.monto = String(round2(usd * tc));
      }
      return next;
    });
  };

  // Vendedores tab
  const [newVend, setNewVend] = useState('');
  const [savingVend, setSavingVend] = useState(false);

  // Inline error states (replaces silent console.error)
  const [dashError, setDashError] = useState('');
  const [compsError, setCompsError] = useState('');
  const [pagosError, setPagosError] = useState('');

  // Comprobante manual (venta previa al sistema) — réplica del cobro previo
  // de Tarjetas. Modal único para alta y edición.
  const EMPTY_MANUAL = { fecha: new Date().toLocaleDateString('sv'), cliente: '', vendedor_id: '', monto_bruto: '', pct: '', referencia: '' };
  const [showManual, setShowManual] = useState(false);
  const [manualForm, setManualForm] = useState(EMPTY_MANUAL);
  const [editingManualId, setEditingManualId] = useState(null);
  const [savingManual, setSavingManual] = useState(false);
  const [manualError, setManualError] = useState('');

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
  // KPIs + recientes responden al rango filtrable (Hoy / Mes / Custom).
  // Antes el filtro era fijo "hoy" y las ventas previas no impactaban — el
  // operador no veía feedback de lo que cargaba con fechas pasadas.
  useEffect(() => {
    if (tab !== 'dashboard') return;
    let mounted = true;
    setDashError('');
    const baseParams = rangeToParams(dashRange);
    Promise.all([
      compApi.totales(baseParams),
      compApi.list({ ...baseParams, limit: 6 }),
    ])
      .then(([totals, list]) => {
        if (!mounted) return;
        setDashData(totals);
        setRecentComps(list.data || []);
      })
      .catch(err => { if (mounted) setDashError(err.message); });
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, dashRange]);

  // ── Comprobantes tab ───────────────────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'comprobantes') return;
    let mounted = true;
    setLoadingComps(true);
    setCompsError('');
    // Pasamos desde/hasta del compRange + limit alto. El backend devuelve
    // pagination.total con el conteo REAL (no recortado por limit), que es
    // lo que mostramos en el header — antes mostrábamos array.length que
    // mentía cuando el dataset crecía sobre el limit.
    const params = { ...rangeToParams(compRange), limit: 500 };
    if (compVendFilter !== 'todos') params.vendedor = compVendFilter;
    compApi
      .list(params)
      .then(res => {
        if (!mounted) return;
        setComps(res.data || []);
        setCompsTotal(res.pagination?.total ?? (res.data?.length || 0));
      })
      .catch(err => { if (mounted) setCompsError(err.message); })
      .finally(() => { if (mounted) setLoadingComps(false); });
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, compVendFilter, compRange]);

  // ── Pagos tab ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'pagos') return;
    let mounted = true;
    setPagosError('');
    Promise.all([pagosApi.list(), pagosApi.totales(), cajasApi.listCajas()])
      .then(([list, tots, cajas]) => {
        if (!mounted) return;
        setPagosList(list.data || []);
        setPagosTotales(tots);
        setCajasList(Array.isArray(cajas) ? cajas : []);
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
        // Antes era console.warn silencioso → si el OCR fallaba (rate limit,
        // imagen mala, Anthropic caído), el operador no se enteraba: el campo
        // de monto quedaba vacío y parecía "OCR procesa pero devuelve 0".
        // Ahora mostramos el mensaje (con el detalle del backend para rate
        // limit). El operador puede tipear el monto a mano.
        toast.error(err.message || 'No se pudo procesar el OCR. Cargá el monto a mano.');
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
      if (typeof r?.data !== 'string' || !r.data) { toast.error('Este comprobante no tiene archivo adjunto.'); setViewFile(null); return; }
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
        referencia: null,
        archivo_data: cFile?.base64 || null,
        archivo_nombre: cFile?.name || null,
        archivo_tipo: cFile?.mimeType || null,
      });
      // Reset form and switch to comprobantes tab
      setCCliente('');
      setCVendId('');
      setCMonto('');
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
  async function handleDeleteComp(c) {
    // canEdit: solo manuales (venta_id IS NULL) — los autogenerados se ajustan
    // editando la venta. El backend también lo bloquea con 400.
    const ok = await confirm({
      title: 'Eliminar venta previa',
      message: `Fecha ${fmtFecha(c.fecha)} · Cliente ${c.cliente} · Neto ARS ${fmt(c.monto_neto)}.\nEsta acción no se puede deshacer.`,
      confirmLabel: 'Eliminar', danger: true,
    });
    if (!ok) return;
    try {
      await compApi.delete(c.id);
      setComps(prev => prev.filter(x => x.id !== c.id));
      toast.success('Venta previa eliminada.');
    } catch (e) {
      toast.error(e.message);
    }
  }

  // ── Manual (venta previa) handlers ─────────────────────────────────────────
  // Edit + delete solo aplican a venta_id IS NULL. Los autogenerados desde
  // Ventas no muestran el botón (canEdit en la tabla más abajo).
  function openManualCreate() {
    setEditingManualId(null);
    setManualError('');
    setManualForm({ ...EMPTY_MANUAL, pct: String(pct) }); // default al pct global
    setShowManual(true);
  }

  function openManualEdit(c) {
    setEditingManualId(c.id);
    setManualError('');
    // Para edición pre-cargamos los valores del row. No persistimos pct (no es
    // columna), así que lo calculamos: pct = monto_financiera / monto_bruto * 100.
    const bruto = Number(c.monto) || 0;
    const fin = Number(c.monto_financiera) || 0;
    const pctCalc = bruto > 0 ? Math.round((fin / bruto) * 100 * 100) / 100 : pct;
    setManualForm({
      fecha: (c.fecha || '').slice(0, 10),
      cliente: c.cliente || '',
      vendedor_id: c.vendedor_id ? String(c.vendedor_id) : '',
      monto_bruto: String(bruto),
      pct: String(pctCalc),
      referencia: c.referencia || '',
    });
    setShowManual(true);
  }

  // Preview client-side del cálculo (el server recalcula al guardar).
  const manualBruto = Number(manualForm.monto_bruto) || 0;
  const manualPct = Number(manualForm.pct) || 0;
  const manualFinCalc = Math.round((manualBruto * manualPct)) / 100;
  const manualNetoCalc = Math.round((manualBruto - manualFinCalc) * 100) / 100;

  async function handleManualSave(e) {
    e?.preventDefault?.();
    setManualError('');
    if (!manualForm.cliente.trim()) { setManualError('Ingresá el cliente.'); return; }
    if (!(Number(manualForm.monto_bruto) > 0)) { setManualError('El bruto debe ser mayor a 0.'); return; }
    const payload = {
      fecha:       manualForm.fecha,
      cliente:     manualForm.cliente.trim(),
      vendedor_id: manualForm.vendedor_id ? Number(manualForm.vendedor_id) : null,
      monto_bruto: Number(manualForm.monto_bruto),
      pct:         manualForm.pct === '' ? undefined : Number(manualForm.pct),
      referencia:  manualForm.referencia.trim() || null,
    };
    setSavingManual(true);
    try {
      if (editingManualId) {
        const updated = await compApi.updateManual(editingManualId, payload);
        setComps(prev => prev.map(x => x.id === updated.id ? { ...x, ...updated, tiene_archivo: x.tiene_archivo } : x));
        toast.success('Venta previa actualizada.');
      } else {
        const created = await compApi.createManual(payload);
        // Inserta al principio. El listado se re-ordena por fecha al refetch.
        setComps(prev => [{ ...created, tiene_archivo: false, vendedor_nombre: vendName(created.vendedor_id) }, ...prev]);
        toast.success('Venta previa registrada.');
      }
      setShowManual(false);
    } catch (err) {
      setManualError(err.message || 'No se pudo guardar.');
    } finally {
      setSavingManual(false);
    }
  }

  // ── Save pago ──────────────────────────────────────────────────────────────
  // Submit del nuevo flujo (junio 2026): valida los 3 inputs, manda payload
  // completo al backend que crea el pago + postea ingreso a la caja en una tx.
  async function handleSavePago() {
    const ars = Number(pagoForm.monto) || 0;
    const tc  = Number(pagoForm.tc) || 0;
    const usd = Number(pagoForm.usd_recibido) || 0;
    if (ars <= 0)             { toast.error('Cargá el total ARS que descuenta del saldo.'); return; }
    if (!pagoForm.caja_id)    { toast.error('Elegí la caja destino.'); return; }
    if (pagoForm.convertir_usd) {
      if (tc <= 0)  { toast.error('Cargá el TC del día.'); return; }
      if (usd <= 0) { toast.error('Cargá el USD recibido.'); return; }
    }
    setSavingPago(true);
    try {
      const payload = {
        fecha:      pagoForm.fecha,
        monto:      ars,
        referencia: pagoForm.referencia.trim() || null,
        caja_id:    Number(pagoForm.caja_id),
        convertir_usd: !!pagoForm.convertir_usd,
        ...(pagoForm.convertir_usd ? { tc, monto_usd: usd } : {}),
      };
      const nuevo = await pagosApi.create(payload);
      setPagosList(prev => [nuevo, ...prev]);
      // Reset mantiene fecha + caja + convertir_usd. Limpiamos TC también
      // porque lunes/jueves suelen venir 2 liquidaciones con la misma fecha
      // de depósito pero DISTINTO TC; mantener el TC viejo hace que el
      // siguiente ARS se autocomplete con un TC equivocado.
      setPagoForm(f => ({
        ...f,
        monto: '', usd_recibido: '', tc: '', referencia: '',
      }));
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
          {/* Presets de rango: Hoy / Este mes / Mes pasado / Personalizado.
              Persistido en localStorage. Si elegís Personalizado, aparecen 2
              inputs date adicionales para Desde/Hasta. */}
          <div className="card card-tight" style={{ marginBottom: 14 }}>
            <div className="flex-row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="muted tiny" style={{ marginRight: 4 }}>Período:</span>
              {[
                { v: 'hoy',         l: 'Hoy' },
                { v: 'mes_actual',  l: 'Este mes' },
                { v: 'mes_pasado',  l: 'Mes pasado' },
                { v: 'todo',        l: 'Todo el período' },
                { v: 'custom',      l: 'Personalizado' },
              ].map(p => (
                <button key={p.v}
                        className={'btn btn-sm ' + (dashRange.preset === p.v ? 'btn-primary' : 'btn-ghost')}
                        onClick={() => setDashRange(r => ({ ...r, preset: p.v }))}>
                  {p.l}
                </button>
              ))}
              {dashRange.preset === 'custom' && (
                <>
                  <input type="date" className="input" style={{ width: 140, marginLeft: 6 }}
                         value={dashRange.desde}
                         onChange={e => setDashRange(r => ({ ...r, desde: e.target.value }))} />
                  <span className="muted tiny">a</span>
                  <input type="date" className="input" style={{ width: 140 }}
                         value={dashRange.hasta}
                         onChange={e => setDashRange(r => ({ ...r, hasta: e.target.value }))} />
                </>
              )}
            </div>
          </div>
          {/* KPI cards */}
          <div className="row" style={{ marginBottom: 16 }}>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Monto bruto · {rangeLabel(dashRange)}</div>
              <div className="kpi-value">
                <span className="ccy">ARS </span>
                <span className="mono">{fmt(dashData?.total_monto ?? 0)}</span>
              </div>
              <div className="muted tiny" style={{ marginTop: 6 }}>
                {dashData?.count ?? 0} comprobantes
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
              <h3>Comprobantes — {rangeLabel(dashRange)}</h3>
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
              <div className="empty">Sin comprobantes en el período seleccionado</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Cliente</th>
                    <th>Vendedor</th>
                    <th>Referencia</th>
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
                      type="number" onKeyDown={blockInvalidNumberKeys}
                      className="input mono"
                      placeholder="0,00"
                      value={cMonto}
                      onChange={e => setCMonto(e.target.value)}
                    />
                  </div>
                </div>
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
        <>
        {/* Barra de presets de rango (misma estética que Dashboard).
            Persistida en localStorage con clave distinta (fin_comps_range)
            para que cada tab recuerde su scope sin pisarse. */}
        <div className="card card-tight" style={{ marginBottom: 14 }}>
          <div className="flex-row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="muted tiny" style={{ marginRight: 4 }}>Período:</span>
            {[
              { v: 'hoy',         l: 'Hoy' },
              { v: 'mes_actual',  l: 'Este mes' },
              { v: 'mes_pasado',  l: 'Mes pasado' },
              { v: 'todo',        l: 'Todo el período' },
              { v: 'custom',      l: 'Personalizado' },
            ].map(p => (
              <button key={p.v}
                      className={'btn btn-sm ' + (compRange.preset === p.v ? 'btn-primary' : 'btn-ghost')}
                      onClick={() => setCompRange(r => ({ ...r, preset: p.v }))}>
                {p.l}
              </button>
            ))}
            {compRange.preset === 'custom' && (
              <>
                <input type="date" className="input" style={{ width: 140, marginLeft: 6 }}
                       value={compRange.desde}
                       onChange={e => setCompRange(r => ({ ...r, desde: e.target.value }))} />
                <span className="muted tiny">a</span>
                <input type="date" className="input" style={{ width: 140 }}
                       value={compRange.hasta}
                       onChange={e => setCompRange(r => ({ ...r, hasta: e.target.value }))} />
              </>
            )}
          </div>
        </div>
        <div className="card card-flush">
          <div className="card-hd">
            {/* compsTotal es pagination.total del backend (conteo real),
                NO el length del array (que está capado al limit=500).
                Cuando hay búsqueda local, mostramos también el sub-total. */}
            <h3>
              Comprobantes — {compsTotal}
              {compSearch && filteredComps.length !== comps.length && (
                <span className="muted tiny" style={{ marginLeft: 8, fontWeight: 400 }}>
                  · {filteredComps.length} coinciden con "{compSearch}"
                </span>
              )}
              {compsTotal > 500 && (
                <span className="muted tiny" style={{ marginLeft: 8, fontWeight: 400 }}>
                  · mostrando 500 más recientes — refiná el filtro de fecha
                </span>
              )}
            </h3>
            <div className="flex-row" style={{ gap: 8 }}>
              {/* Cargar venta previa: para registrar ventas anteriores al
                  sistema donde el cliente pagó con la caja Financiera.
                  Mismo patrón que "Cobro previo" en Tarjetas. */}
              <button className="btn btn-sm" onClick={openManualCreate}>
                <Icons.Plus size={13} /> Venta previa
              </button>
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
                  <th>Origen</th>
                  <th>Referencia</th>
                  <th className="num">Bruto</th>
                  <th className="num">Retención</th>
                  <th className="num">Neto</th>
                  <th>Archivo</th>
                  <th style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredComps.map(c => {
                  // Solo los manuales (venta_id IS NULL) se editan/eliminan desde acá.
                  // Los autogenerados se ajustan editando la venta.
                  const esManual = c.venta_id == null;
                  return (
                  <tr key={c.id} className="tbl-row-click">
                    <td className="muted">{fmtFecha(c.fecha)}</td>
                    <td style={{ fontWeight: 600 }}>{c.cliente}</td>
                    <td>{c.vendedor_nombre || vendName(c.vendedor_id)}</td>
                    <td>
                      {esManual
                        ? <Badge tone="warn">Venta previa</Badge>
                        : <Badge tone="info">Venta #{c.venta_id}</Badge>}
                    </td>
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
                        {esManual && (
                          <>
                            <button className="icon-btn" title="Editar venta previa" aria-label="Editar venta previa"
                                    onClick={() => openManualEdit(c)}>
                              <Icons.Edit size={14} />
                            </button>
                            <button className="icon-btn" title="Eliminar venta previa" aria-label="Eliminar venta previa"
                                    style={{ color: 'var(--neg)' }} onClick={() => handleDeleteComp(c)}>
                              <Icons.Trash size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );})}
              </tbody>
            </table>
          )}
        </div>
        </>
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
              {/* Envolver en <form> para que Enter submitee (espejo del form
                  Tarjetas). Antes era un <div> y Enter no hacía nada → fricción. */}
              <form onSubmit={e => { e.preventDefault(); if (!savingPago) handleSavePago(); }}
                    style={{ padding: '0 18px 18px' }}>
                {/* Fila 1: fecha + referencia + toggle USD. La elección se
                    persiste en localStorage (default según última vez). */}
                <div className="row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
                  <div className="field" style={{ width: 150 }}>
                    <div className="field-label">Fecha</div>
                    <input type="date" className="input mono"
                      value={pagoForm.fecha}
                      onChange={e => setPagoForm(f => ({ ...f, fecha: e.target.value }))} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <div className="field-label">Referencia</div>
                    <input className="input"
                      placeholder="Ej: Liquidación semana 4 mayo"
                      value={pagoForm.referencia}
                      onChange={e => setPagoForm(f => ({ ...f, referencia: e.target.value }))} />
                  </div>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', paddingBottom: 8 }}>
                    <input type="checkbox"
                      checked={pagoForm.convertir_usd}
                      onChange={e => setPagoForm(f => ({
                        ...f,
                        convertir_usd: e.target.checked,
                        // Reset: el filtro de cajas cambia con la moneda.
                        // Si DESACTIVA el toggle, además limpiamos TC y USD
                        // para que no queden valores fantasma en el state.
                        caja_id: '',
                        ...(e.target.checked ? {} : { tc: '', usd_recibido: '' }),
                      }))} />
                    <span style={{ fontSize: 13, fontWeight: 600 }}>Convertir a USD</span>
                  </label>
                </div>

                {/* Fila 2: USD × TC = ARS (cuando hay conversión). Los 3
                    inputs son editables; cuando edits uno, los otros se
                    auto-completan vía USD × TC = ARS. */}
                {pagoForm.convertir_usd && (
                  <div className="row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
                    <div className="field" style={{ width: 180 }}>
                      <div className="field-label">USD recibido (caja)</div>
                      <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                        className="input mono" placeholder="0"
                        value={pagoForm.usd_recibido}
                        onChange={e => setPagoUsd(e.target.value)} />
                    </div>
                    <div style={{ paddingBottom: 8, color: 'var(--text-muted)', fontWeight: 700, fontSize: 18 }}>×</div>
                    <div className="field" style={{ width: 140 }}>
                      <div className="field-label">TC del día</div>
                      <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                        className="input mono" placeholder="0"
                        value={pagoForm.tc}
                        onChange={e => setPagoTc(e.target.value)} />
                    </div>
                    <div style={{ paddingBottom: 8, color: 'var(--text-muted)', fontWeight: 700, fontSize: 18 }}>=</div>
                    <div className="field" style={{ flex: 1 }}>
                      <div className="field-label">Total ARS (descuenta del saldo)</div>
                      <div className="input-group">
                        <span className="addon addon-l" style={{ color: 'var(--accent)' }}>$</span>
                        <input type="number" onKeyDown={blockInvalidNumberKeys} min="0"
                          className="input mono" placeholder="0,00"
                          value={pagoForm.monto}
                          onChange={e => setPagoArs(e.target.value)} />
                      </div>
                    </div>
                  </div>
                )}

                {/* Sin conversión: solo input ARS. */}
                {!pagoForm.convertir_usd && (
                  <div className="field" style={{ marginBottom: 12 }}>
                    <div className="field-label">Monto (ARS)</div>
                    <div className="input-group">
                      <span className="addon addon-l" style={{ color: 'var(--accent)' }}>$</span>
                      <input type="number" onKeyDown={blockInvalidNumberKeys} min="0"
                        className="input mono" placeholder="0,00"
                        value={pagoForm.monto}
                        onChange={e => setPagoForm(f => ({ ...f, monto: e.target.value }))} />
                    </div>
                  </div>
                )}

                {/* Caja destino: filtrada por moneda según el toggle. */}
                <div className="field" style={{ marginBottom: 14 }}>
                  <div className="field-label">Entra a la caja {pagoForm.convertir_usd ? '(USD)' : '(ARS)'}</div>
                  <select className="input"
                    value={pagoForm.caja_id}
                    onChange={e => setPagoForm(f => ({ ...f, caja_id: e.target.value }))}>
                    <option value="">Elegí la caja…</option>
                    {cajasList
                      .filter(c => !c.es_tarjeta)
                      .filter(c => pagoForm.convertir_usd
                        ? (c.moneda === 'USD' || c.moneda === 'USDT')
                        : c.moneda === 'ARS')
                      .map(c => (
                        <option key={c.id} value={c.id}>{c.nombre}{c.moneda ? ' · ' + c.moneda : ''}</option>
                      ))}
                    <CajaSelectHint />
                  </select>
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={savingPago}
                >
                  <Icons.Check size={14} />
                  {savingPago ? 'Registrando…' : 'Registrar pago'}
                </button>
              </form>
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

      {/* ── Modal: Cargar / editar venta previa ── */}
      {showManual && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="manual-title"
             onClick={(e) => { if (e.target === e.currentTarget && !savingManual) setShowManual(false); }}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3 id="manual-title">{editingManualId ? 'Editar venta previa' : 'Cargar venta previa'}</h3>
              <button className="icon-btn" aria-label="Cerrar modal" onClick={() => setShowManual(false)} disabled={savingManual}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleManualSave}>
              <div className="modal-body">
                <fieldset disabled={savingManual} style={{ border: 0, padding: 0, margin: 0 }}>
                <div className="muted tiny" style={{ marginBottom: 14, lineHeight: 1.5 }}>
                  Para ventas anteriores al sistema cobradas con la caja Financiera.
                  NO crea una venta — solo agrega el comprobante al resumen
                  (bruto, retención, neto). Cargá el % efectivo que la financiera
                  aplicó en esa venta (por default usa el {pct}% global).
                </div>
                <div className="stack" style={{ gap: 12 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <div className="field" style={{ width: 150 }}>
                      <label className="field-label">Fecha</label>
                      <input type="date" className="input" value={manualForm.fecha}
                             onChange={e => setManualForm(f => ({ ...f, fecha: e.target.value }))} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Cliente <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input className="input" placeholder="Nombre del cliente" autoFocus
                             value={manualForm.cliente}
                             onChange={e => setManualForm(f => ({ ...f, cliente: e.target.value }))} />
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">Vendedor</label>
                    <select className="input" value={manualForm.vendedor_id}
                            onChange={e => setManualForm(f => ({ ...f, vendedor_id: e.target.value }))}>
                      <option value="">— Sin vendedor —</option>
                      {vendedores.map(v => <option key={v.id} value={v.id}>{v.nombre}</option>)}
                    </select>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Monto bruto <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                             className="input mono" placeholder="0"
                             value={manualForm.monto_bruto}
                             onChange={e => setManualForm(f => ({ ...f, monto_bruto: e.target.value }))} />
                    </div>
                    <div className="field" style={{ width: 110 }}>
                      <label className="field-label">% retención</label>
                      <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" max="100" step="0.01"
                             className="input mono"
                             value={manualForm.pct}
                             onChange={e => setManualForm(f => ({ ...f, pct: e.target.value }))} />
                    </div>
                  </div>
                  {manualBruto > 0 && (
                    <div style={{
                      padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 6,
                      fontSize: 13, lineHeight: 1.6,
                    }}>
                      <div className="flex-between"><span className="muted">Bruto:</span><span className="mono">ARS {fmt(manualBruto)}</span></div>
                      <div className="flex-between"><span className="muted">Retención ({manualPct}%):</span><span className="mono" style={{ color: 'var(--accent)' }}>− ARS {fmt(manualFinCalc)}</span></div>
                      <div className="flex-between" style={{ paddingTop: 4, borderTop: '1px solid var(--hairline)', marginTop: 4 }}>
                        <strong>Neto recibido:</strong>
                        <span className="mono pos" style={{ fontWeight: 700 }}>ARS {fmt(manualNetoCalc)}</span>
                      </div>
                    </div>
                  )}
                  <div className="field">
                    <label className="field-label">Referencia</label>
                    <input className="input" placeholder="ej. Operación #1234"
                           value={manualForm.referencia}
                           onChange={e => setManualForm(f => ({ ...f, referencia: e.target.value }))} />
                  </div>
                  {manualError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{manualError}</div>}
                </div>
                </fieldset>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowManual(false)} disabled={savingManual}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingManual}>
                  {savingManual ? 'Guardando…' : (editingManualId ? 'Guardar cambios' : 'Registrar venta previa')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

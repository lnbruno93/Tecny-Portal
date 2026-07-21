import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { silentReport } from '../lib/reportError';
import { downloadBlob } from '../lib/downloadBlob';
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
import { round2 } from '../lib/money';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import { generarComprobantesResumenPdf } from '../lib/generarComprobantesResumenPdf';
import { generarComprobantesResumenXlsx } from '../lib/generarComprobantesResumenXlsx';
import CajaSelectHint from '../components/CajaSelectHint';
import TcWarning from '../components/TcWarning';
import Badge from '../components/Badge';
// 2026-06-29 Multi-país F5: el filtro de cajas locales del form de pago
// no puede asumir ARS — para tenants UY debe ser UYU. Ver bug flagueado en F3.
import { useMonedasTenant } from '../lib/useMonedasTenant';


// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtARS(n) {
  return 'ARS ' + fmt(n);
}

// ─── Constants ───────────────────────────────────────────────────────────────


// ─── Helper components ───────────────────────────────────────────────────────
// Badge ahora vive en frontend/src/components/Badge.jsx (U-13 dedup,
// auditoría 2026-06-10) — importado arriba.

function Status({ tone = 'default', children }) {
  return <span className={`status s-${tone}`}>{children}</span>;
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function Financiera() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  // 2026-06-29 Multi-país F5: monedaLocal del tenant (ARS para AR, UYU para UY).
  // Reemplaza `'ARS'` hardcodeado en el filtro de cajas del form de pagos —
  // tenants UY operan contra cajas UYU, no ARS. Ver bug flagueado en F3.
  // El resto de los strings "ARS" en este file son del flow AR-only (USD×TC=ARS
  // de financiera tradicional) y se mantienen — Financiera es módulo AR-céntrico
  // por ahora; cuando UY lo necesite tendrá su propio sprint de adaptación.
  const { monedaLocal } = useMonedasTenant();
  // Auditoría 2026-06-30 F-09: tab + filtros de tab Comprobantes persisten
  // en la URL. Antes el tab se reseteaba al refrescar (Dashboard siempre)
  // y los filtros locales (búsqueda cliente, vendedor) se perdían. Defaults
  // NO escriben URL; replace:true para no inflar history.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') || 'dashboard';
  // 2026-07-01: el tab 'vendedores' fue eliminado (movido a modal en Ventas).
  // Si alguien llega con ?tab=vendedores (bookmark viejo, link compartido),
  // caemos a 'dashboard' para no renderizar una pantalla vacía. La URL no
  // se reescribe automáticamente — el próximo click en un tab la limpia.
  const tab = rawTab === 'vendedores' ? 'dashboard' : rawTab;
  const setParam = useCallback((key, value, def) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === def) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const setTab = useCallback((v) => setParam('tab', v, 'dashboard'), [setParam]);
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
  // Auditoría 2026-06-30 F-09: compSearch + compVendFilter en URL.
  // Permite compartir un link "Comprobantes filtrados por vendedor X y buscando
  // cliente Y" o que el F5 no borre el filtro.
  const compSearch = searchParams.get('q') || '';
  const compVendFilter = searchParams.get('vend') || 'todos';
  const setCompSearch = useCallback((v) => setParam('q', v, ''), [setParam]);
  const setCompVendFilter = useCallback((v) => setParam('vend', v, 'todos'), [setParam]);
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

  // Export — un solo state ('zip'|'pdf'|'xlsx'|null) basta para mostrar el
  // spinner en el botón en curso y deshabilitar los otros mientras tanto
  // (no permitimos exports concurrentes para no saturar la conexión / ledger).
  const [exporting, setExporting] = useState(null);

  // Helper: params actuales del filtro de comprobantes (mismo shape que la
  // query de la lista). Usado por los 3 botones de export.
  function compParamsActuales() {
    const p = { ...rangeToParams(compRange) };
    if (compVendFilter !== 'todos') p.vendedor = compVendFilter;
    return p;
  }

  // Fetch fresco para los exports de resumen — el listado en pantalla está
  // capado a 500. Para el PDF/XLSX queremos TODOS los del período (un mes real
  // puede tener >500). Tope defensivo de 5000: si lo supera, el contador debe
  // refinar el filtro y exportar por partes.
  async function fetchTodoElPeriodo() {
    const p = { ...compParamsActuales(), limit: 5000 };
    const [{ data = [] }, totales] = await Promise.all([
      compApi.list(p),
      compApi.totales(p),
    ]);
    if (totales.count > 5000) {
      throw new Error(`El período tiene ${totales.count} comprobantes (tope 5000). Refiná el filtro de fecha y exportá por partes.`);
    }
    return { comprobantes: data, totales };
  }

  // ── ZIP de archivos físicos del período ───────────────────────────────────
  async function exportZipComprobantes() {
    setExporting('zip');
    try {
      const params = compParamsActuales();
      const blob = await compApi.exportZip(params);
      const { desde, hasta } = params;
      const tag = desde && hasta ? `${desde}_${hasta}` : (desde || hasta || new Date().toISOString().slice(0, 10));
      downloadBlob(blob, `comprobantes_${tag}.zip`);
      toast.success('ZIP descargado');
    } catch (err) {
      toast.error(err);
    } finally {
      setExporting(null);
    }
  }

  // ── PDF resumen del período ───────────────────────────────────────────────
  async function exportPdfComprobantes() {
    setExporting('pdf');
    try {
      const { comprobantes, totales } = await fetchTodoElPeriodo();
      if (!comprobantes.length) {
        toast.error('No hay comprobantes en el período seleccionado.');
        return;
      }
      await generarComprobantesResumenPdf({
        comprobantes,
        totales,
        periodoLabel: rangeLabel(compRange),
      });
      toast.success('PDF generado');
    } catch (err) {
      toast.error(err);
    } finally {
      setExporting(null);
    }
  }

  // ── XLSX resumen del período ──────────────────────────────────────────────
  async function exportXlsxComprobantes() {
    setExporting('xlsx');
    try {
      const { comprobantes, totales } = await fetchTodoElPeriodo();
      if (!comprobantes.length) {
        toast.error('No hay comprobantes en el período seleccionado.');
        return;
      }
      generarComprobantesResumenXlsx({
        comprobantes,
        totales,
        periodoLabel: rangeLabel(compRange),
      });
      toast.success('Planilla generada');
    } catch (err) {
      toast.error(err);
    } finally {
      setExporting(null);
    }
  }

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
  // 2026-07-01: newVend/savingVend eliminados junto con el tab "Vendedores".
  // El CRUD del catálogo se movió a un modal en Ventas.jsx
  // (VendedoresCatalogModal) — reportado por cliente Uruguay. El state
  // `vendedores` sigue acá porque el catálogo se sigue LEYENDO en el form
  // de comprobantes (dropdown), el KPI del dashboard y el filtro de la
  // lista de comprobantes.

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
      .catch(silentReport);
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
    // 2026-06-19: limit subido de 6 → 20 a pedido de Lucas. Con 6 se veían
    // muy pocas filas en la tab Dashboard cuando el rango era "Todo el período"
    // (el KPI mostraba 235 pero la tabla solo 6). 20 es buen balance: triplica
    // visibilidad sin engordar el bundle de respuesta del dashboard. Si en el
    // futuro queremos paginación real en esta tabla del dashboard, ahí evaluar
    // un wrapper más sofisticado.
    Promise.all([
      compApi.totales(baseParams),
      compApi.list({ ...baseParams, limit: 20 }),
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
      message: `Fecha ${fmtFecha(c.fecha)} · Cliente ${c.cliente || 'Sin cliente'} · Neto ARS ${fmt(c.monto_neto)}.\nEsta acción no se puede deshacer.`,
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

  // ── Render ─────────────────────────────────────────────────────────────────
  // 2026-07-01: handleAddVend / handleDeleteVend eliminados junto con el tab
  // "Vendedores". CRUD del catálogo ahora vive en VendedoresCatalogModal
  // (montado desde la toolbar de Ventas.jsx).
  return (
    <div>
      {/* Page head — 2026-06-19 Lucas: solo título + subtítulo, los botones
          bajan a la fila de tabs. */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Transferencias</h1>
          <div className="page-sub">
            Comprobantes, pagos y OCR · retención al {pct.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Tabs bar + botones en la misma fila */}
      <div className="flex-between" style={{ marginBottom: 20, gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="tabs">
          {[
            { value: 'dashboard',    label: 'Dashboard' },
            { value: 'cargar',       label: 'Cargar' },
            { value: 'comprobantes', label: 'Comprobantes' },
            { value: 'pagos',        label: 'Pagos' },
            // 2026-07-01: tab "Vendedores" eliminado — admin del catálogo
            // se movió a Ventas.jsx (VendedoresCatalogModal).
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
        <div className="page-actions">
          <button className="btn" onClick={() => setTab('cargar')}>
            <Icons.Upload size={14} /> Cargar OCR
          </button>
          <button className="btn btn-primary" onClick={() => setTab('cargar')}>
            <Icons.Plus size={14} /> Nuevo comprobante
          </button>
        </div>
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
          <div className="card card-tight u-mb-14">
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
          <div className="row u-mb-16">
            <div className="card card-tight u-flex-1">
              <div className="kpi-label">Monto bruto · {rangeLabel(dashRange)}</div>
              <div className="kpi-value">
                <span className="ccy">ARS </span>
                <span className="mono">{fmt(dashData?.total_monto ?? 0)}</span>
              </div>
              <div className="muted tiny u-mt-6">
                {dashData?.count ?? 0} comprobantes
              </div>
            </div>
            <div className="card card-tight u-flex-1">
              <div className="kpi-label">Retención financiera</div>
              <div className="kpi-value">
                <span className="ccy">ARS </span>
                <span className="mono u-color-accent">
                  {fmt(dashData?.total_financiera ?? 0)}
                </span>
              </div>
              <div className="muted tiny u-mt-6">
                {pct.toFixed(1)}% del bruto
              </div>
            </div>
            <div className="card card-tight u-flex-1">
              <div className="kpi-label">Nos queda · neto</div>
              <div className="kpi-value">
                <span className="ccy">ARS </span>
                <span className="mono pos">{fmt(dashData?.total_neto ?? 0)}</span>
              </div>
              <div className="muted tiny u-mt-6">
                bruto − retención
              </div>
            </div>
            <div className="card card-tight u-flex-1">
              <div className="kpi-label">Vendedores activos</div>
              <div className="kpi-value mono">{vendedores.length}</div>
              <div className="muted tiny u-mt-6">
                en el equipo
              </div>
            </div>
          </div>

          {/* Recent comprobantes table */}
          <div className="card card-flush">
            <div className="card-hd">
              <h3>Comprobantes — {rangeLabel(dashRange)}</h3>
              <div className="flex-row u-gap-8">
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
                      <td className="u-fw-600">{c.cliente || <span className="muted">Sin cliente</span>}</td>
                      <td className="muted">{c.vendedor_nombre || vendName(c.vendedor_id)}</td>
                      <td><Badge>{c.referencia || '—'}</Badge></td>
                      <td className="num mono">
                        <span className="muted u-fw-500">ARS </span>
                        {fmt(c.monto)}
                      </td>
                      <td className="num mono u-color-accent">
                        <span className="muted u-fw-500">ARS </span>
                        {fmt(c.monto_financiera)}
                      </td>
                      <td className="num mono pos u-fw-600">
                        <span className="muted u-fw-500">ARS </span>
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
              <div className="row u-mb-12">
                <div className="field u-flex-1">
                  <div className="field-label">Fecha de pago</div>
                  <input
                    type="date"
                    className="input mono"
                    value={cFecha}
                    onChange={e => setCFecha(e.target.value)}
                  />
                </div>
                <div className="field u-flex-1">
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
              <div className="row u-mb-12">
                <div className="field u-flex-1">
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
                <div className="field u-flex-1">
                  <div className="field-label">Monto bruto (ARS)</div>
                  <div className="input-group">
                    <span className="addon addon-l u-color-accent">$</span>
                    <input
                      type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
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
                      <Icons.Sparkle size={28} className="u-color-accent" />
                      <div className="u-fs-14-fw-600">Procesando OCR…</div>
                      <div className="muted tiny">Claude está extrayendo el monto</div>
                    </>
                  ) : cFile ? (
                    <>
                      <Icons.Sparkle size={28} className="u-color-accent" />
                      <div className="u-fs-14-fw-600">{cFile.name}</div>
                      <div className="muted tiny">
                        {(cFile.size / 1024).toFixed(0)} KB
                        {ocrResult && ocrResult.monto && ` · OCR extrajo ${fmtARS(ocrResult.monto)}`}
                      </div>
                    </>
                  ) : (
                    <>
                      <Icons.Camera size={32} />
                      <div className="u-fs-14-fw-600">
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
                {/* 2026-06-24 mobile lote D: usar .kpi-grid que respeta el
                    breakpoint <=640px (1 col en mobile) en vez de 3 fijas
                    que truncan los valores numéricos. */}
                <div className="kpi-grid u-gap-14">
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
              <div className="flex-row u-gap-8">
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
                <div className="muted tiny u-mt-4">
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
        <div className="card card-tight u-mb-14">
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
            <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {/* Exportar el período actual: ZIP de archivos físicos + resumen
                  PDF/XLSX. Los 3 botones respetan el filtro de período + vendedor
                  visible arriba; el ZIP además es streamed server-side. */}
              <button className="btn btn-sm btn-ghost" onClick={exportZipComprobantes}
                      disabled={!!exporting} title="Descarga un .zip con los archivos del período + manifest.csv">
                <Icons.Download size={13} />
                {exporting === 'zip' ? ' Generando ZIP…' : ' ZIP archivos'}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={exportPdfComprobantes}
                      disabled={!!exporting} title="PDF con KPIs + tabla detalle del período">
                <Icons.FileText size={13} />
                {exporting === 'pdf' ? ' Generando PDF…' : ' PDF resumen'}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={exportXlsxComprobantes}
                      disabled={!!exporting} title="Planilla Excel con KPIs + detalle (montos como números)">
                <Icons.Sheet size={13} />
                {exporting === 'xlsx' ? ' Generando XLSX…' : ' XLSX resumen'}
              </button>
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
                    <td className="u-fw-600">{c.cliente || <span className="muted">Sin cliente</span>}</td>
                    <td>{c.vendedor_nombre || vendName(c.vendedor_id)}</td>
                    <td>
                      {esManual
                        ? <Badge tone="warn">Venta previa</Badge>
                        : <Badge tone="info">Venta #{c.venta_id}</Badge>}
                    </td>
                    <td><Badge>{c.referencia || '—'}</Badge></td>
                    <td className="num mono">
                      <span className="muted u-fw-500">ARS </span>
                      {fmt(c.monto)}
                    </td>
                    <td className="num mono u-color-accent">
                      {fmt(c.monto_financiera)}
                    </td>
                    <td className="num mono pos u-fw-600">
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
                            <button className="icon-btn u-color-neg" title="Eliminar venta previa" aria-label="Eliminar venta previa" onClick={() => handleDeleteComp(c)}>
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
                  <div className="field u-w-150px">
                    <div className="field-label">Fecha</div>
                    <input type="date" className="input mono"
                      value={pagoForm.fecha}
                      onChange={e => setPagoForm(f => ({ ...f, fecha: e.target.value }))} />
                  </div>
                  <div className="field u-flex-1">
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
                    <span className="u-fs-13-fw-600">Convertir a USD</span>
                  </label>
                </div>

                {/* Fila 2: USD × TC = ARS (cuando hay conversión). Los 3
                    inputs son editables; cuando edits uno, los otros se
                    auto-completan vía USD × TC = ARS.
                    U4/U11/U13/U6 auditoría 2026-06-06: labels con htmlFor,
                    anchos fluidos, alerta TC fuera de rango, indicador de
                    descalce USD×TC vs ARS. */}
                {pagoForm.convertir_usd && (
                  <>
                  <div className="row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
                    <div className="field" style={{ flex: '1 1 140px', minWidth: 140 }}>
                      <label htmlFor="pago-usd" className="field-label">USD recibido (caja)</label>
                      <input id="pago-usd" type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                        className="input mono" placeholder="0"
                        value={pagoForm.usd_recibido}
                        onChange={e => setPagoUsd(e.target.value)} />
                    </div>
                    <div aria-hidden="true" style={{ paddingBottom: 8, color: 'var(--text-muted)', fontWeight: 700, fontSize: 18 }}>×</div>
                    <div className="field" style={{ flex: '1 1 120px', minWidth: 120 }}>
                      <label htmlFor="pago-tc" className="field-label">TC del día</label>
                      <input id="pago-tc" type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                        className="input mono" placeholder="0"
                        value={pagoForm.tc}
                        onChange={e => setPagoTc(e.target.value)} />
                      <TcWarning tc={pagoForm.tc} />
                    </div>
                    <div aria-hidden="true" style={{ paddingBottom: 8, color: 'var(--text-muted)', fontWeight: 700, fontSize: 18 }}>=</div>
                    <div className="field" style={{ flex: '1 1 160px', minWidth: 160 }}>
                      <label htmlFor="pago-ars" className="field-label">Total ARS (descuenta del saldo)</label>
                      <div className="input-group">
                        <span className="addon addon-l u-color-accent">$</span>
                        <input id="pago-ars" type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0"
                          className="input mono" placeholder="0,00"
                          value={pagoForm.monto}
                          onChange={e => setPagoArs(e.target.value)} />
                      </div>
                    </div>
                  </div>
                  {/* U6: indicador de descalce USD×TC vs ARS. Lucas puede
                      mantenerlos descalzados por redondeo (comportamiento
                      esperado), pero el chip ayuda a detectar un cero de
                      más en el tipeo. */}
                  {(() => {
                    const usd = Number(pagoForm.usd_recibido) || 0;
                    const tc  = Number(pagoForm.tc) || 0;
                    const ars = Number(pagoForm.monto) || 0;
                    if (!(usd > 0 && tc > 0 && ars > 0)) return null;
                    const arsCalc = usd * tc;
                    const delta = ars - arsCalc;
                    if (Math.abs(delta) < 0.01) return null;
                    const color = Math.abs(delta) < 100 ? 'var(--text-muted)' : 'var(--warn, #d97706)';
                    return (
                      <div className="mono tiny" style={{ color, marginTop: -8, marginBottom: 8 }} role="status">
                        USD × TC = $ {fmt(arsCalc)} (Δ {delta >= 0 ? '+' : ''}{fmt(delta)})
                        {Math.abs(delta) >= 100 && ' — revisá si es lo que dice la planilla.'}
                      </div>
                    );
                  })()}
                  </>
                )}

                {/* Sin conversión: solo input ARS. */}
                {!pagoForm.convertir_usd && (
                  <div className="field u-mb-12">
                    <label htmlFor="pago-ars-only" className="field-label">Monto (ARS)</label>
                    <div className="input-group">
                      <span className="addon addon-l u-color-accent">$</span>
                      <input id="pago-ars-only" type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0"
                        className="input mono" placeholder="0,00"
                        value={pagoForm.monto}
                        onChange={e => setPagoForm(f => ({ ...f, monto: e.target.value }))} />
                    </div>
                  </div>
                )}

                {/* Caja destino: filtrada por moneda según el toggle.
                    F5: el branch "no convertir USD" filtra por moneda LOCAL del
                    tenant (ARS para AR, UYU para UY). Antes era ARS hardcoded
                    — para tenants UY no aparecía ninguna caja válida. */}
                <div className="field u-mb-14">
                  <div className="field-label">Entra a la caja {pagoForm.convertir_usd ? '(USD)' : `(${monedaLocal})`}</div>
                  <select className="input"
                    value={pagoForm.caja_id}
                    onChange={e => setPagoForm(f => ({ ...f, caja_id: e.target.value }))}>
                    <option value="">Elegí la caja…</option>
                    {cajasList
                      .filter(c => !c.es_tarjeta)
                      .filter(c => pagoForm.convertir_usd
                        ? (c.moneda === 'USD' || c.moneda === 'USDT')
                        : c.moneda === monedaLocal)
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
                  <div className="row u-mb-16">
                    <div className="u-flex-1">
                      <div className="muted tiny" style={{ fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        Recibido
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 4 }}>
                        <span className="muted u-fs-12">ARS </span>
                        <span className="mono pos">{fmt(pagosTotales.total_monto)}</span>
                      </div>
                    </div>
                    <div className="u-flex-1">
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
                      <td className="num mono pos u-fw-600">
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

      {/* 2026-07-01: tab "Vendedores" eliminado — la administración del
          catálogo se movió a un modal en Ventas.jsx (VendedoresCatalogModal),
          reportado por cliente Uruguay. El catálogo se sigue LEYENDO acá
          (form de comprobantes, KPI, filtro), pero el CRUD ya no vive en
          Transferencias. */}

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
          <div className="modal u-mw-520" onClick={e => e.stopPropagation()}>
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
                <div className="stack u-gap-12">
                  <div className="row u-gap-8">
                    <div className="field u-w-150px">
                      <label className="field-label">Fecha</label>
                      <input type="date" className="input" value={manualForm.fecha}
                             onChange={e => setManualForm(f => ({ ...f, fecha: e.target.value }))} />
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Cliente <span className="u-color-neg">*</span></label>
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
                  <div className="row u-gap-8">
                    <div className="field u-flex-1">
                      <label className="field-label">Monto bruto <span className="u-color-neg">*</span></label>
                      <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                             className="input mono" placeholder="0"
                             value={manualForm.monto_bruto}
                             onChange={e => setManualForm(f => ({ ...f, monto_bruto: e.target.value }))} />
                    </div>
                    <div className="field u-w-110px">
                      <label className="field-label">% retención</label>
                      <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" max="100" step="0.01"
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
                      <div className="flex-between"><span className="muted">Retención ({manualPct}%):</span><span className="mono u-color-accent">− ARS {fmt(manualFinCalc)}</span></div>
                      <div className="flex-between" style={{ paddingTop: 4, borderTop: '1px solid var(--hairline)', marginTop: 4 }}>
                        <strong>Neto recibido:</strong>
                        <span className="mono pos u-fw-700">ARS {fmt(manualNetoCalc)}</span>
                      </div>
                    </div>
                  )}
                  <div className="field">
                    <label className="field-label">Referencia</label>
                    <input className="input" placeholder="ej. Operación #1234"
                           value={manualForm.referencia}
                           onChange={e => setManualForm(f => ({ ...f, referencia: e.target.value }))} />
                  </div>
                  {manualError && <div className="u-color-neg-fs-13">{manualError}</div>}
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

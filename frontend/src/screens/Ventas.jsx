import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { ventas, inventario, vendedores as vendedoresApi, cuentas as cuentasApi, contactos as contactosApi } from '../lib/api';
import { exportCsv } from '../lib/exportCsv';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import useLoadingAction from '../lib/useLoadingAction'; // #F-2
import useModal from '../lib/useModal';
import TcWarning from '../components/TcWarning';
import Badge from '../components/Badge';
import { fmt, fmt2 } from '../lib/format';

// Componentes y helpers locales del módulo Ventas — extraídos a archivos
// dedicados para mantener este screen enfocado en orchestration.
import Seg from './ventas/Seg';
import Dashboard from './ventas/Dashboard';
import DiffModal from './ventas/DiffModal';
import ExitoModal from './ventas/ExitoModal';
import VentasList from './ventas/VentasList';
import { sym, toUsd, todayStr, shiftDate, monthStart, weekStart } from './ventas/utils';

const ESTADO_DISPLAY = {
  acreditado: { label: 'Acreditado', tone: 'pos' },
  pendiente:  { label: 'Pendiente',  tone: 'warn' },
  cancelado:  { label: 'Cancelado',  tone: 'neg' },
};
const ESTADO_LABEL = { acreditado: 'Acreditado', pendiente: 'Pendiente', cancelado: 'Cancelado' };
const GARANTIA_FALLBACK = 'Este comprobante es tu nota de compra y avala la operación comercial entre partes. No es una factura ni comprobante fiscal.\n\nNos responsabilizamos por 12 meses, desde la fecha de compra, ante cualquier error, falla o mal funcionamiento propio de software y hardware.\n\niPro | Tech Reseller';

const EMPTY_VENTA = {
  fecha: todayStr(), hora: '', cliente_nombre: '', cliente_id: '', cliente_cc_id: '', etiqueta_id: '', garantia_id: '',
  vendedor_id: '', comision: '', tc_venta: '', estado: 'pendiente', notas: '',
  // Junio 2026: canjes pasa de 1 sola entrada con 4 campos a array de hasta N
  // canjes con 10 campos c/u — cada canje puede ir a Inventario con todos sus
  // datos. Ver schema canjeSchema en backend/src/schemas/ventas.js.
  canjes: [],
};

// Forma de un canje vacío para usar como template al "+ Agregar equipo".
const EMPTY_CANJE = {
  descripcion: '', imei: '', gb: '', color: '', bateria: '',
  valor_toma: '', moneda: 'USD', agregar_stock: true,
  categoria_id: '', condicion: 'usado',
  precio_venta_sugerido: '', observaciones: '',
};

// ─── Pantalla ──────────────────────────────────────────────────────────────────
export default function Ventas() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { setPrimaryAction } = usePageActions();
  const navigate = useNavigate();

  const [lista, setLista] = useState([]);
  const [dash, setDash] = useState(null);
  const [rapidas, setRapidas] = useState([]);
  const [loading, setLoading] = useState(true);

  const [periodo, setPeriodo] = useState('hoy');
  const [desde, setDesde] = useState(todayStr());
  const [hasta, setHasta] = useState(todayStr());
  const [estadoFilter, setEstadoFilter] = useState('');
  const [search, setSearch] = useState('');
  const dSearch = useDebouncedValue(search, 350); // no fetch en cada keystroke

  // Catálogos
  const [vendedores, setVendedores] = useState([]);
  const [etiquetas, setEtiquetas] = useState([]);
  // Categorías de Inventario — usadas en el picker del canje (junio 2026)
  // para que un equipo tomado entre directo en su categoría correcta.
  const [categoriasInv, setCategoriasInv] = useState([]);
  const [metodos, setMetodos] = useState([]);
  const [garantias, setGarantias] = useState([]);
  const [clientesCC, setClientesCC] = useState([]);
  const [contactos, setContactos] = useState([]);
  const [clienteDrop, setClienteDrop] = useState(false);

  // Modal de diferencia en pagos (visual rico, custom — no usa ConfirmModal)
  // y modal de éxito post-venta con descargar comprobante en PDF.
  const [diffModal, setDiffModal] = useState({ open: false, items: 0, cubierto: 0, dif: 0, resolve: null });
  const [exitoModal, setExitoModal] = useState({ open: false, venta: null });
  // #M-12 / #F-2: loading state del PDF compartido entre modal éxito y grilla.
  // Extraído al hook useLoadingAction — el patrón se reutiliza para cualquier
  // acción async con anti-click-spam.
  const { loading: pdfLoading, run: withPdfLoading } = useLoadingAction();

  // Modales
  const [showVenta, setShowVenta] = useState(false);
  const [showRapida, setShowRapida] = useState(false);
  const [showGarantias, setShowGarantias] = useState(false);
  const [showEtiquetas, setShowEtiquetas] = useState(false);
  const [nuevaEtiqueta, setNuevaEtiqueta] = useState('');
  const [showComprob, setShowComprob] = useState(null); // venta id
  const [comprobList, setComprobList] = useState([]);
  // useModal — auditoría 2026-06-06 UX B2: Esc cierra los modales,
  // focus trap, body scroll lock. Aplicado a los 3 modales operativos
  // más usados (venta nueva, venta rápida, garantías). showEtiquetas y
  // showComprob (poco frecuentes) quedan para una iteración posterior.
  const ventaModalRef = useRef(null);
  const rapidaModalRef = useRef(null);
  const garantiasModalRef = useRef(null);
  useModal({ open: showVenta, onClose: () => setShowVenta(false), overlayRef: ventaModalRef });
  useModal({ open: showRapida, onClose: () => setShowRapida(false), overlayRef: rapidaModalRef });
  useModal({ open: showGarantias, onClose: () => setShowGarantias(false), overlayRef: garantiasModalRef });

  // ── Carga ──
  const loadDash = useCallback(async () => {
    try { setDash(await ventas.dashboard({ desde, hasta })); } catch (_) {}
  }, [desde, hasta]);

  const loadLista = useCallback(async () => {
    setLoading(true);
    try {
      const params = { desde, hasta, limit: 200 };
      if (estadoFilter) params.estado = estadoFilter;
      if (dSearch.trim()) params.buscar = dSearch.trim();
      const res = await ventas.list(params);
      setLista(res.data || []);
    } catch (e) { toast.error(e.message); } finally { setLoading(false); }
  }, [desde, hasta, estadoFilter, dSearch, toast]);

  const loadRapidas = useCallback(async () => {
    try { setRapidas(await ventas.rapidas({ estado: 'pendiente' })); } catch (_) { setRapidas([]); }
  }, []);

  const loadCatalogos = useCallback(async () => {
    const safe = (p) => p.then(r => r).catch(() => []);
    const [v, e, m, g, cc, ct, cats] = await Promise.all([
      safe(vendedoresApi.list()), safe(ventas.etiquetas()), safe(ventas.metodosPago()), safe(ventas.garantias()), safe(cuentasApi.clientes()), safe(contactosApi.list()),
      safe(inventario.categorias()), // categorías para el picker del canje (junio 2026)
    ]);
    // Los endpoints paginados devuelven { data, pagination }. Usamos un
    // unwrap defensivo: si vino array (endpoint no-paginado o vacío), tomar
    // tal cual; si vino objeto con .data, extraerlo.
    const unwrap = (r) => Array.isArray(r) ? r : (r?.data ?? []);
    const ccArr = unwrap(cc);
    const ctArr = unwrap(ct); // post-audit: contactos ahora paginado
    setVendedores(v); setEtiquetas(e); setMetodos(m); setGarantias(g); setClientesCC(ccArr); setContactos(ctArr);
    setCategoriasInv(unwrap(cats));
  }, []);

  useEffect(() => { loadCatalogos(); }, [loadCatalogos]);
  useEffect(() => { loadDash(); loadLista(); loadRapidas(); }, [loadDash, loadLista, loadRapidas]);

  function setPeriodoRange(p) {
    setPeriodo(p);
    const today = todayStr();
    if (p === 'hoy') { setDesde(today); setHasta(today); }
    else if (p === 'ayer') { const y = shiftDate(today, -1); setDesde(y); setHasta(y); }
    else if (p === 'semana') { setDesde(weekStart()); setHasta(today); }
    else if (p === 'mes') { setDesde(monthStart()); setHasta(today); }
    // 'custom' → el usuario edita los date inputs
  }

  // ── Nueva venta ──
  const [vForm, setVForm] = useState(EMPTY_VENTA);
  const [cart, setCart] = useState([]);
  const [pagos, setPagos] = useState([]);
  const [comprobantes, setComprobantes] = useState([]);
  const [procRapidaId, setProcRapidaId] = useState(null);
  const [editId, setEditId] = useState(null);
  const [savingVenta, setSavingVenta] = useState(false);
  const [ventaError, setVentaError] = useState('');
  const [prodSearch, setProdSearch] = useState('');
  const [prodResults, setProdResults] = useState([]);
  const prodTimer = useRef(null);
  const prodReq = useRef(0); // token "última request gana" (evita que una respuesta lenta pise a una nueva)
  const setVF = (k, v) => setVForm(f => ({ ...f, [k]: v }));

  function openEdit(v) {
    setEditId(v.id); setProcRapidaId(null); setComprobantes([]); setVentaError(''); setProdSearch(''); setProdResults([]);
    setVForm({
      ...EMPTY_VENTA,
      fecha: (v.fecha || '').substring(0, 10), hora: v.hora ? v.hora.substring(0, 5) : '',
      cliente_nombre: v.cliente_nombre || '', cliente_id: v.cliente_id || '', cliente_cc_id: v.cliente_cc_id || '', etiqueta_id: v.etiqueta_id || '', garantia_id: v.garantia_id || '',
      vendedor_id: (v.items.find(i => i.vendedor_id) || {}).vendedor_id || '', comision: v.items[0]?.comision || '',
      tc_venta: v.tc_venta || '', estado: v.estado, notas: v.notas || '',
      // Junio 2026: canjes existentes vienen del backend con descripcion + imei + gb + color +
      // bateria + valor_toma + moneda + producto_id. Reconstruimos el form con esos campos +
      // defaults para los nuevos (categoria/condicion/precio_venta_sugerido/observaciones) —
      // edición de canjes existentes no permite cambiar campos que ya viajaron a Inventario.
      canjes: (v.canjes || []).map(c => ({
        descripcion: c.descripcion || '',
        imei: c.imei || '', gb: c.gb || '', color: c.color || '', bateria: c.bateria ?? '',
        valor_toma: c.valor_toma || '', moneda: c.moneda || 'USD',
        agregar_stock: !!c.producto_id, // si ya tiene producto_id, está en Inventario
        categoria_id: '', condicion: 'usado',
        precio_venta_sugerido: '', observaciones: '',
        _existing: true, // flag: este canje ya existe en DB, no se re-crea producto
      })),
    });
    setCart((v.items || []).map(it => ({ producto_id: it.producto_id, descripcion: it.descripcion, imei: it.imei || '', cantidad: it.cantidad, precio_vendido: Number(it.precio_vendido), costo: Number(it.costo), moneda: it.moneda })));
    setPagos((v.pagos || []).map(p => ({ metodo_pago_id: p.metodo_pago_id ?? null, metodo_nombre: p.metodo_nombre, monto: Number(p.monto), moneda: p.moneda, tc: p.tc || '', es_cuenta_corriente: !!p.es_cuenta_corriente })));
    setShowVenta(true);
  }

  function openVenta(rapida) {
    setVForm({ ...EMPTY_VENTA, fecha: todayStr() });
    setCart([]); setPagos([]); setComprobantes([]); setVentaError(''); setProdSearch(''); setProdResults([]);
    setProcRapidaId(null); setEditId(null);
    if (rapida) {
      setProcRapidaId(rapida.id);
      setVForm(f => ({ ...f, cliente_nombre: rapida.cliente_texto || '', notas: rapida.detalle || '' }));
      const vend = vendedores.find(v => v.nombre.toLowerCase() === (rapida.vendedor_nombre || '').toLowerCase());
      if (vend) setVForm(f => ({ ...f, vendedor_id: vend.id }));
      setCart([{ producto_id: null, descripcion: '', imei: '', cantidad: 1, precio_vendido: 0, costo: 0, moneda: 'USD' }]);
    }
    setShowVenta(true);
  }

  useEffect(() => {
    setPrimaryAction({ label: 'Nueva venta', onClick: () => openVenta(null) });
    return () => setPrimaryAction(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPrimaryAction, vendedores]);

  function searchProducto(q) {
    setProdSearch(q);
    clearTimeout(prodTimer.current);
    if (q.trim().length < 2) { setProdResults([]); return; }
    const reqId = ++prodReq.current;
    prodTimer.current = setTimeout(async () => {
      try {
        const res = await inventario.productos({ solo_stock: 'true', limit: 8, buscar: q.trim() });
        if (reqId === prodReq.current) setProdResults(res.data || []);
      } catch (_) { if (reqId === prodReq.current) setProdResults([]); }
    }, 300);
  }
  function addProd(p) {
    setCart(c => [...c, {
      producto_id: p.id,
      descripcion: [p.nombre, p.color, p.gb ? p.gb + 'GB' : ''].filter(Boolean).join(' '),
      imei: p.imei || '', cantidad: 1, precio_vendido: Number(p.precio_venta) || 0, costo: Number(p.costo) || 0, moneda: p.precio_moneda || 'USD',
    }]);
    setProdSearch(''); setProdResults([]);
  }
  const addItemManual = () => setCart(c => [...c, { producto_id: null, descripcion: '', imei: '', cantidad: 1, precio_vendido: 0, costo: 0, moneda: 'USD' }]);
  const setItem = (i, k, v) => setCart(c => c.map((it, j) => j === i ? { ...it, [k]: (k === 'cantidad' || k === 'precio_vendido' || k === 'costo') ? (v === '' ? '' : Number(v)) : v } : it));
  const rmItem = (i) => setCart(c => c.filter((_, j) => j !== i));

  const addPago = () => setPagos(p => [...p, { metodo_pago_id: null, metodo_nombre: '', monto: '', moneda: 'ARS', tc: '', es_cuenta_corriente: false }]);
  const setPago = (i, k, v) => setPagos(p => p.map((pg, j) => j === i ? { ...pg, [k]: v } : pg));
  const rmPago = (i) => setPagos(p => p.filter((_, j) => j !== i));
  function setPagoMetodo(i, value) {
    if (value === '__CC__') {
      setPagos(p => p.map((pg, j) => j === i ? { ...pg, metodo_pago_id: null, metodo_nombre: 'Cuenta corriente', es_cuenta_corriente: true, moneda: pg.moneda || 'USD' } : pg));
      return;
    }
    const m = metodos.find(x => x.nombre === value);
    setPagos(p => p.map((pg, j) => j === i ? { ...pg, metodo_pago_id: m ? m.id : null, metodo_nombre: value, es_cuenta_corriente: false, moneda: m ? m.moneda : pg.moneda } : pg));
  }

  function onComprobFiles(e) {
    const files = [...(e.target.files || [])];
    const MAX = 6 * 1024 * 1024;
    const next = [];
    let pending = files.length;
    if (!pending) { setComprobantes([]); return; }
    files.forEach(f => {
      if (f.size > MAX) { pending--; return; }
      const r = new FileReader();
      r.onload = ev => { next.push({ nombre: f.name, tipo: f.type, data: String(ev.target.result).split(',')[1] }); pending--; if (pending === 0) setComprobantes([...next]); };
      r.onerror = () => { pending--; if (pending === 0) setComprobantes([...next]); };
      r.readAsDataURL(f);
    });
  }

  const totales = useMemo(() => {
    const tc = Number(vForm.tc_venta) || null;
    let items = 0; cart.forEach(it => { items += toUsd((Number(it.precio_vendido) || 0) * (Number(it.cantidad) || 0), it.moneda, tc); });
    let pg = 0; pagos.forEach(p => { pg += toUsd(p.monto, p.moneda, p.tc || tc); });
    // Suma de TODOS los valor_toma de canjes (asumimos USD — el form solo permite USD por canje).
    const canjeTotal = (vForm.canjes || []).reduce((acc, c) => acc + (Number(c.valor_toma) || 0), 0);
    const cubierto = pg + canjeTotal;
    return { items, cubierto, dif: cubierto - items, canjeTotal };
  }, [cart, pagos, vForm.tc_venta, vForm.canjes]);

  // ── Helpers para manipular el array de canjes (junio 2026) ─────────────
  const addCanje = () => setVForm(f => ({ ...f, canjes: [...(f.canjes || []), { ...EMPTY_CANJE }] }));
  const rmCanje = (i) => setVForm(f => ({ ...f, canjes: (f.canjes || []).filter((_, idx) => idx !== i) }));
  const setCanje = (i, k, v) => setVForm(f => ({
    ...f,
    canjes: (f.canjes || []).map((c, idx) => idx === i ? { ...c, [k]: v } : c),
  }));

  async function handleSaveVenta(e) {
    e.preventDefault();
    setVentaError('');
    const items = cart.filter(it => String(it.descripcion).trim()).map((it, idx) => ({
      producto_id: it.producto_id || null,
      vendedor_id: vForm.vendedor_id || null,
      descripcion: String(it.descripcion).trim(),
      imei: it.imei ? String(it.imei).trim() : null,
      cantidad: Number(it.cantidad) || 1,
      precio_vendido: Number(it.precio_vendido) || 0,
      costo: Number(it.costo) || 0,
      moneda: it.moneda || 'USD',
      comision: idx === 0 ? (Number(vForm.comision) || 0) : 0,
    }));
    if (!items.length) { setVentaError('Agregá al menos un producto con descripción.'); return; }
    const pagosPayload = pagos.filter(p => p.metodo_nombre && (Number(p.monto) || 0) > 0).map(p => ({
      metodo_pago_id: p.metodo_pago_id ?? null,
      metodo_nombre: p.metodo_nombre, monto: Number(p.monto) || 0, moneda: p.moneda, tc: p.tc ? Number(p.tc) : null,
      es_cuenta_corriente: !!p.es_cuenta_corriente,
    }));
    // Caja Financiera: si un pago la usa, exigir el comprobante (en alta) para que
    // se auto-genere el comprobante de Financiera y no haya doble carga.
    const finCaja = metodos.find(m => m.es_financiera);
    const usaFinanciera = !!finCaja && pagosPayload.some(p => p.metodo_pago_id === finCaja.id);
    if (!editId && usaFinanciera && comprobantes.length === 0) {
      setVentaError('Esta venta se cobra por la Financiera: adjuntá el comprobante antes de guardar.');
      return;
    }
    // Junio 2026: array de canjes (puede ser N, ya no 1 fijo). Cada canje se
    // sanitiza individualmente y se ignora cualquiera sin descripción ni valor.
    // Los _existing (canjes que vienen de la DB en edit) se mandan con sus
    // campos básicos pero NO con los nuevos (categoria/condicion/etc) porque
    // edit no re-crea el producto en Inventario.
    const canjes = (vForm.canjes || [])
      .filter(c => String(c.descripcion || '').trim() || Number(c.valor_toma) > 0)
      .map(c => {
        const base = {
          descripcion: String(c.descripcion || 'Canje').trim(),
          imei: c.imei ? String(c.imei).trim() : null,
          gb: c.gb ? String(c.gb).trim() : null,
          color: c.color ? String(c.color).trim() : null,
          bateria: c.bateria === '' || c.bateria == null ? null : Number(c.bateria),
          valor_toma: Number(c.valor_toma) || 0,
          moneda: c.moneda || 'USD',
          agregar_stock: !!c.agregar_stock,
        };
        // Solo enviamos los campos extra si va a Inventario (sino no aportan nada).
        if (c.agregar_stock) {
          if (c.categoria_id)          base.categoria_id          = Number(c.categoria_id);
          if (c.condicion)             base.condicion             = c.condicion;
          if (c.precio_venta_sugerido) base.precio_venta_sugerido = Number(c.precio_venta_sugerido);
          if (c.observaciones?.trim()) base.observaciones         = c.observaciones.trim();
        }
        return base;
      });

    // Aviso de diferencia: si el total cobrado != total de items (con canje),
    // mostramos un modal visual rico (no el ConfirmModal genérico) con desglose
    // total/cobrado/restante, y dos opciones: "Corregir" (volver al form) o
    // "Aceptar igual" (proceder + inyectar item "Diferencia").
    //
    // El item de diferencia se calcula:
    //   · A favor (cobrado de más):  precio_vendido = +dif, costo = 0
    //     → sube total_usd y ganancia_usd.
    //   · En contra (cobrado de menos): precio_vendido = 0, costo = |dif|
    //     → no toca total_usd pero baja ganancia_usd.
    // (No usamos precio negativo: la DB tiene CHECK precio_vendido >= 0.)
    // Tolerancia 0.005 USD para no marcar errores de redondeo por floats.
    if (Math.abs(totales.dif) > 0.005) {
      // Promesa que el modal resuelve con true (aceptar) o false (corregir).
      const aceptado = await new Promise(resolve => {
        setDiffModal({ open: true, items: totales.items, cubierto: totales.cubierto, dif: totales.dif, resolve });
      });
      if (!aceptado) return;
      const aFavor = totales.dif > 0;
      const dif = Math.abs(totales.dif);
      items.push({
        producto_id:   null,
        vendedor_id:   vForm.vendedor_id || null,
        descripcion:   aFavor ? 'Diferencia de cambio (a favor)' : 'Diferencia de cambio (en contra)',
        imei:          null,
        cantidad:      1,
        precio_vendido: aFavor ? dif : 0,
        costo:         aFavor ? 0 : dif,
        moneda:        'USD',
        comision:      0,
      });
    }

    const payload = {
      fecha: vForm.fecha, hora: vForm.hora || null, cliente_nombre: vForm.cliente_nombre.trim() || null,
      cliente_id: vForm.cliente_id || null, cliente_cc_id: vForm.cliente_cc_id || null,
      etiqueta_id: vForm.etiqueta_id || null, garantia_id: vForm.garantia_id || null,
      estado: vForm.estado, tc_venta: vForm.tc_venta ? Number(vForm.tc_venta) : null,
      notas: vForm.notas.trim() || null, items, pagos: pagosPayload, canjes,
    };
    setSavingVenta(true);
    try {
      const venta = editId ? await ventas.update(editId, payload) : await ventas.create(payload);
      let uploadFalló = false;
      for (const c of comprobantes) {
        try { await ventas.uploadComprobante(venta.id, { archivo_data: c.data, archivo_nombre: c.nombre, archivo_tipo: c.tipo }); }
        catch (e) { uploadFalló = true; console.warn('Error al adjuntar comprobante:', e); }
      }
      if (!editId && procRapidaId) { try { await ventas.updateRapida(procRapidaId, { estado: 'procesada', venta_id: venta.id }); } catch (_) {} }
      // Si el adjunto falló no podemos cantar éxito (y en el flujo financiera el
      // comprobante de Financiera NO se habría auto-generado): avisamos.
      if (uploadFalló) toast.error('La venta se guardó, pero el comprobante no se pudo adjuntar. Subilo de nuevo desde la venta.');
      setShowVenta(false);
      // Cobro por Financiera con comprobante OK: ya se auto-generó el de Financiera → ir a verificarlo.
      if (!editId && usaFinanciera && !uploadFalló) { navigate('/financiera'); return; }
      await Promise.all([loadDash(), loadLista(), loadRapidas()]);
      // Modal de éxito con opción de descargar comprobante PDF. Reemplaza
      // al toast minimalista — da feedback claro y permite imprimir el
      // comprobante para el cliente sin pasos extra.
      //
      // IMPORTANTE: el endpoint POST/PUT /api/ventas devuelve solo la fila
      // de `ventas`, sin items ni pagos embebidos. Para el PDF reusamos el
      // payload del frontend (con los datos que el usuario acaba de cargar)
      // y los mergeamos sobre la respuesta. monto_usd se calcula con toUsd.
      if (!uploadFalló) {
        const tcVenta = Number(vForm.tc_venta) || null;
        // items: agregamos imei tomado del cart original (cart[i] tiene imei,
        // items no lo lleva al payload). Para mantener orden, indexamos por idx.
        const itemsPdf = items.map((it, idx) => ({
          descripcion:    it.descripcion,
          cantidad:       Number(it.cantidad) || 1,
          precio_vendido: Number(it.precio_vendido) || 0,
          costo:          Number(it.costo) || 0,
          moneda:         it.moneda || 'USD',
          imei:           cart[idx]?.imei || null,
        }));
        const pagosPdf = pagosPayload.map(p => ({
          metodo_nombre: p.metodo_nombre,
          monto:         Number(p.monto) || 0,
          moneda:        p.moneda,
          tc:            p.tc ? Number(p.tc) : null,
          monto_usd:     toUsd(p.monto, p.moneda, p.tc || tcVenta),
          es_cuenta_corriente: !!p.es_cuenta_corriente,
        }));
        // Cliente completo: si está vinculado por id, traemos del state de
        // contactos; sino solo el nombre que tipeó el operador.
        const contactoVinculado = vForm.cliente_id
          ? contactos.find(c => String(c.id) === String(vForm.cliente_id))
          : null;
        const vendedorNombre = vForm.vendedor_id
          ? (vendedores.find(v => String(v.id) === String(vForm.vendedor_id))?.nombre || null)
          : null;
        // Mismo criterio que el botón de imprimir en la grilla: garantía
        // elegida, o la default del catálogo si no se eligió. Si tampoco hay
        // default, queda el fallback hardcoded (GARANTIA_FALLBACK).
        const garantiaSel = vForm.garantia_id
          ? garantias.find(g => String(g.id) === String(vForm.garantia_id))
          : garantias.find(g => g.es_default);
        const ventaCompleta = {
          ...venta,
          total_usd: venta.total_usd != null ? venta.total_usd :
            itemsPdf.reduce((s, it) => s + toUsd(it.precio_vendido * it.cantidad, it.moneda, tcVenta), 0),
          cliente_nombre: venta.cliente_nombre || vForm.cliente_nombre || 'Consumidor final',
          cliente_apellido: contactoVinculado?.apellido || null,
          cliente_dni:      contactoVinculado?.dni      || null,
          cliente_telefono: contactoVinculado?.telefono || null,
          cliente_email:    contactoVinculado?.email    || null,
          vendedor_nombre:  vendedorNombre,
          hora:             venta.hora    || vForm.hora || null,
          fecha:            venta.fecha   || vForm.fecha,
          notas:            venta.notas   || vForm.notas,
          garantia_nombre:  garantiaSel?.nombre || (vForm.garantia_id ? null : 'Predeterminada'),
          garantia_texto:   garantiaSel?.texto  || GARANTIA_FALLBACK,
          items:            itemsPdf,
          pagos:            pagosPdf,
        };
        setExitoModal({ open: true, venta: ventaCompleta });
      }
    } catch (err) { setVentaError(err.message); } finally { setSavingVenta(false); }
  }

  async function changeEstado(id, estado) {
    try { await ventas.update(id, { estado }); toast.success('Estado actualizado.'); await Promise.all([loadLista(), loadDash()]); }
    catch (e) { toast.error(e.message); }
  }
  async function deleteVenta(v) {
    const ok = await confirm({ title: 'Eliminar venta', message: 'Se repondrá el stock de los productos vinculados. Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await ventas.delete(v.id); toast.success('Venta eliminada.'); await Promise.all([loadLista(), loadDash()]); }
    catch (e) { toast.error(e.message); }
  }
  async function deleteRapida(id) {
    const ok = await confirm({ title: 'Eliminar venta rápida', message: '¿Seguro?', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await ventas.deleteRapida(id); await loadRapidas(); } catch (e) { toast.error(e.message); }
  }

  // ── Quick-add de cliente embebido (form mini) ─────────────────────────
  // Antes creábamos el contacto con solo `nombre`. Ahora pedimos también DNI,
  // WhatsApp, email y fecha de nacimiento — todos opcionales menos nombre.
  // Estos datos son insumo para Data Science (cumpleaños, perfilado) y para
  // contacto post-venta. El form se monta en línea dentro del dropdown.
  const [quickClient, setQuickClient] = useState({ open: false, nombre: '', dni: '', telefono: '', email: '', fecha_nacimiento: '' });
  const [quickClientSaving, setQuickClientSaving] = useState(false);
  const [quickClientError, setQuickClientError] = useState('');

  function abrirQuickClient(nombre) {
    setQuickClient({ open: true, nombre: nombre.trim(), dni: '', telefono: '', email: '', fecha_nacimiento: '' });
    setQuickClientError('');
  }
  function cerrarQuickClient() {
    setQuickClient(q => ({ ...q, open: false }));
    setQuickClientError('');
  }
  async function guardarQuickClient(e) {
    e?.preventDefault?.();
    const n = quickClient.nombre.trim();
    if (!n) { setQuickClientError('El nombre es obligatorio.'); return; }
    setQuickClientSaving(true);
    setQuickClientError('');
    try {
      const payload = {
        nombre: n,
        tipo: 'cliente',
        dni:              quickClient.dni.trim()      || null,
        telefono:         quickClient.telefono.trim() || null,
        email:            quickClient.email.trim()    || null,
        fecha_nacimiento: quickClient.fecha_nacimiento || null,
      };
      const c = await contactosApi.create(payload);
      setContactos(prev => [...prev, c]);
      setVForm(f => ({ ...f, cliente_nombre: c.nombre, cliente_id: c.id }));
      setClienteDrop(false);
      setQuickClient({ open: false, nombre: '', dni: '', telefono: '', email: '', fecha_nacimiento: '' });
      toast.success('Cliente creado y vinculado.');
    } catch (e) {
      setQuickClientError(e.message || 'No se pudo crear el cliente.');
    } finally {
      setQuickClientSaving(false);
    }
  }

  // ── Venta rápida ──
  const [rForm, setRForm] = useState({ vendedor_nombre: '', cliente_texto: '', detalle: '' });
  const [savingRapida, setSavingRapida] = useState(false);
  async function handleSaveRapida(e) {
    e.preventDefault();
    if (!rForm.detalle.trim()) return;
    setSavingRapida(true);
    try {
      await ventas.createRapida({ fecha: todayStr(), detalle: rForm.detalle.trim(), cliente_texto: rForm.cliente_texto.trim() || null, vendedor_nombre: rForm.vendedor_nombre.trim() || null });
      toast.success('Venta rápida guardada.');
      setShowRapida(false); setRForm({ vendedor_nombre: '', cliente_texto: '', detalle: '' });
      await loadRapidas();
    } catch (err) { toast.error(err.message); } finally { setSavingRapida(false); }
  }

  // ── Garantías (gestión) ──
  const [gForm, setGForm] = useState({ id: null, nombre: '', texto: '', es_default: false });
  const [savingGar, setSavingGar] = useState(false);
  async function reloadGarantias() { try { setGarantias(await ventas.garantias()); } catch (_) {} }
  async function handleSaveGarantia(e) {
    e.preventDefault();
    if (!gForm.nombre.trim() || !gForm.texto.trim()) return;
    setSavingGar(true);
    try {
      const body = { nombre: gForm.nombre.trim(), texto: gForm.texto.trim(), es_default: gForm.es_default };
      if (gForm.id) await ventas.updateGarantia(gForm.id, body); else await ventas.createGarantia(body);
      toast.success('Plantilla guardada.');
      setGForm({ id: null, nombre: '', texto: '', es_default: false });
      await reloadGarantias();
    } catch (err) { toast.error(err.message); } finally { setSavingGar(false); }
  }
  async function deleteGarantia(id) {
    const ok = await confirm({ title: 'Eliminar plantilla', message: '¿Seguro?', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await ventas.deleteGarantia(id); await reloadGarantias(); } catch (e) { toast.error(e.message); }
  }

  // ── Etiquetas (gestión) ──
  async function addEtiqueta() {
    const nombre = nuevaEtiqueta.trim();
    if (!nombre) return;
    try { await ventas.createEtiqueta({ nombre }); setNuevaEtiqueta(''); setEtiquetas(await ventas.etiquetas()); }
    catch (e) { toast.error(e.message); }
  }
  async function delEtiqueta(id) {
    const ok = await confirm({ title: 'Eliminar etiqueta', message: 'Las ventas con esta etiqueta quedarán sin etiqueta.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await ventas.deleteEtiqueta(id); setEtiquetas(await ventas.etiquetas()); } catch (e) { toast.error(e.message); }
  }

  // ── Comprobantes adjuntos (ver) ──
  async function openComprob(id) {
    setShowComprob(id); setComprobList(null);
    try { setComprobList(await ventas.comprobantes(id)); } catch (_) { setComprobList([]); }
  }
  async function abrirComprob(cid) {
    try {
      const c = await ventas.getComprobante(cid);
      const w = window.open('', '_blank');
      if (!w) { toast.error('Permití las ventanas emergentes.'); return; }
      // Allowlist estricta de mime y de base64 — el visor inserta `data:<tipo>;base64,...`
      // y un tipo o data adulterado podría inyectar HTML en la ventana hija.
      const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
      const tipo = ALLOWED.includes(c.archivo_tipo) ? c.archivo_tipo : 'image/png';
      const dataOk = typeof c.archivo_data === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(c.archivo_data);
      if (!dataOk) { toast.error('Archivo inválido.'); w.close(); return; }
      const url = `data:${tipo};base64,${c.archivo_data.replace(/\s/g, '')}`;
      // Construimos el DOM con la API de elementos (sin document.write de strings interpolados):
      const body = w.document.body;
      body.style.cssText = 'margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh';
      const el = tipo === 'application/pdf' ? w.document.createElement('iframe') : w.document.createElement('img');
      el.src = url;
      el.style.cssText = tipo === 'application/pdf'
        ? 'position:fixed;inset:0;width:100%;height:100%;border:none'
        : 'max-width:100%;max-height:100vh';
      body.appendChild(el);
    } catch (e) { toast.error('Error al abrir.'); }
  }

  // ── Comprobante PDF (mismo flujo que el modal de éxito) ──
  // Antes había dos comprobantes: el PDF del modal y un HTML imprimible
  // que abría una ventana nueva. Unificamos en uno solo: ambos puntos de
  // entrada (botón "Descargar comprobante" del modal y icono impresora en
  // la grilla) generan el mismo PDF con el mismo layout sobrio.
  async function comprobantePDF(v) {
    await withPdfLoading(async () => {
      const contactoVinculado = v.cliente_id
        ? contactos.find(c => String(c.id) === String(v.cliente_id))
        : null;
      // Cuando la venta viene del backend (lista), los items tienen vendedor_id;
      // usamos el primer item con vendedor para resolver el nombre.
      const vendedorId = (v.items || []).find(i => i.vendedor_id)?.vendedor_id;
      const vendedorNombre = vendedorId
        ? (vendedores.find(x => String(x.id) === String(vendedorId))?.nombre || null)
        : null;
      // Garantía: la elegida en la venta, o la default del catálogo, o el fallback.
      const garFuente = v.garantia_id
        ? garantias.find(g => String(g.id) === String(v.garantia_id))
        : garantias.find(g => g.es_default);
      const ventaEnriquecida = {
        ...v,
        cliente_apellido: contactoVinculado?.apellido || null,
        cliente_dni:      contactoVinculado?.dni      || null,
        cliente_telefono: contactoVinculado?.telefono || null,
        cliente_email:    contactoVinculado?.email    || null,
        vendedor_nombre:  vendedorNombre,
        garantia_nombre:  garFuente?.nombre || (v.garantia_id ? null : 'Predeterminada'),
        garantia_texto:   garFuente?.texto  || GARANTIA_FALLBACK,
      };
      try {
        const mod = await import('../lib/generarComprobantePdf');
        await mod.generarComprobantePdf(ventaEnriquecida);
      } catch (e) {
        console.error('PDF error:', e);
        toast.error(`No se pudo generar el comprobante PDF: ${e?.message || e}`, { duration: 12000 });
      }
    });
  }

  function exportarExcel() {
    if (!lista.length) { toast.error('No hay ventas para exportar.'); return; }
    const rows = lista.map(v => ({
      order_id: v.order_id, fecha: (v.fecha || '').substring(0, 10), hora: v.hora ? v.hora.substring(0, 5) : '',
      cliente: v.cliente_nombre || '', etiqueta: v.etiqueta_nombre || '', estado: v.estado,
      productos: (v.items || []).map(i => i.descripcion + (i.cantidad > 1 ? ' x' + i.cantidad : '')).join(' | '),
      imei: (v.items || []).map(i => i.imei).filter(Boolean).join(' | '),
      pagos: (v.pagos || []).map(p => `${p.metodo_nombre} ${p.moneda} ${p.monto}`).join(' | '),
      tc_venta: v.tc_venta || '', total_usd: v.total_usd, ganancia_usd: v.ganancia_usd,
    }));
    const cols = ['order_id', 'fecha', 'hora', 'cliente', 'etiqueta', 'estado', 'productos', 'imei', 'pagos', 'tc_venta', 'total_usd', 'ganancia_usd'];
    exportCsv(`ventas_${desde}_${hasta}.csv`, rows, cols.map(k => ({ key: k, label: k })));
  }

  function estadoBadge(s) { const d = ESTADO_DISPLAY[s] || { label: s, tone: 'default' }; return <Badge tone={d.tone}>{d.label}</Badge>; }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Ventas</h1>
          <div className="page-sub">Dashboard, movimientos y carga de ventas</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => { loadDash(); loadLista(); loadRapidas(); }}><Icons.Refresh size={14} /> Actualizar</button>
          <button className="btn" onClick={() => setShowGarantias(true)}><Icons.Shield size={14} /> Plantillas</button>
          <button className="btn" onClick={() => setShowEtiquetas(true)}><Icons.Tag size={14} /> Etiquetas</button>
          <button className="btn" onClick={() => setShowRapida(true)}><Icons.Bolt size={14} /> Venta rápida</button>
          <button className="btn" onClick={exportarExcel}><Icons.Download size={14} /> Exportar</button>
          <button className="btn btn-primary" onClick={() => openVenta(null)}><Icons.Plus size={14} /> Nueva venta</button>
        </div>
      </div>

      {/* Período */}
      <div style={{ marginBottom: 14 }}>
        <Seg value={periodo} options={[
          { value: 'hoy', label: 'Hoy' }, { value: 'ayer', label: 'Ayer' }, { value: 'semana', label: 'Esta semana' },
          { value: 'mes', label: 'Este mes' }, { value: 'custom', label: 'Personalizado' },
        ]} onChange={setPeriodoRange} />
      </div>

      {/* Dashboard */}
      <Dashboard d={dash} />

      {/* Filtros lista */}
      <div className="flex-between" style={{ marginBottom: 14 }}>
        <div className="flex-row" style={{ gap: 8 }}>
          <input type="date" className="input" style={{ width: 150 }} value={desde} onChange={e => { setPeriodo('custom'); setDesde(e.target.value); }} />
          <input type="date" className="input" style={{ width: 150 }} value={hasta} onChange={e => { setPeriodo('custom'); setHasta(e.target.value); }} />
        </div>
        <div className="flex-row" style={{ gap: 8 }}>
          <div className="input-group" style={{ width: 280 }}>
            <span className="addon addon-l"><Icons.Search size={14} /></span>
            <input className="input" placeholder="Order ID, cliente, producto, IMEI…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Seg value={estadoFilter} options={[
            { value: '', label: 'Todos' }, { value: 'acreditado', label: 'Acreditados' }, { value: 'pendiente', label: 'Pendientes' }, { value: 'cancelado', label: 'Cancelados' },
          ]} onChange={setEstadoFilter} />
        </div>
      </div>

      {/* Ventas rápidas pendientes */}
      {rapidas.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div className="kpi-label" style={{ color: 'var(--warn)', marginBottom: 8 }}><Icons.Bolt size={12} /> Ventas rápidas pendientes ({rapidas.length})</div>
          {rapidas.map(r => (
            <div key={r.id} className="flex-between" style={{ gap: 8, padding: '8px 0', borderBottom: '1px solid var(--hairline)', alignItems: 'flex-start' }}>
              <div style={{ fontSize: 13 }}>
                <strong>{r.vendedor_nombre || '—'}</strong>{r.cliente_texto ? ' · ' + r.cliente_texto : ''}
                <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{r.detalle}</div>
              </div>
              <div className="flex-row" style={{ gap: 6, flexShrink: 0 }}>
                <button className="btn btn-sm" onClick={() => openVenta(r)}><Icons.Check size={13} /> Procesar</button>
                <button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => deleteRapida(r.id)}><Icons.Trash size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Lista de movimientos */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>Cargando…</div>
      ) : lista.length === 0 ? (
        <div className="empty">Sin ventas en el período</div>
      ) : (
        <VentasList
          lista={lista}
          estadoBadge={estadoBadge}
          changeEstado={changeEstado}
          openEdit={openEdit}
          comprobantePDF={comprobantePDF}
          openComprob={openComprob}
          deleteVenta={deleteVenta}
        />
      )}

      {/* ── Modal Nueva venta ── */}
      {showVenta && (
        <div ref={ventaModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowVenta(false)}>
          <div className="modal" style={{ maxWidth: 720 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>{editId ? 'Editar venta' : procRapidaId ? 'Procesar venta rápida' : 'Nueva venta'}</h3><button type="button" className="icon-btn" onClick={() => setShowVenta(false)} aria-label="Cerrar" title="Cerrar"><Icons.X size={16} /></button></div>
            <form onSubmit={handleSaveVenta}>
              <div className="modal-body" style={{ maxHeight: '74vh', overflowY: 'auto' }}>
                <div className="stack" style={{ gap: 14 }}>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Fecha <span style={{ color: 'var(--neg)' }}>*</span></label><input type="date" className="input" value={vForm.fecha} onChange={e => setVF('fecha', e.target.value)} /></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Hora</label><input type="time" className="input" value={vForm.hora} onChange={e => setVF('hora', e.target.value)} /></div>
                  </div>

                  {/* Productos */}
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Productos</div>
                    <div style={{ position: 'relative' }}>
                      <input className="input" placeholder="Buscar producto del inventario (nombre, IMEI, color…)" value={prodSearch} onChange={e => searchProducto(e.target.value)} />
                      {prodResults.length > 0 && (
                        <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60, maxHeight: 220, overflowY: 'auto', marginTop: 2, padding: 4 }}>
                          {prodResults.map(p => (
                            <div key={p.id} className="nav-item" style={{ cursor: 'pointer', fontSize: 13 }} onClick={() => addProd(p)}>
                              <strong>{p.nombre}</strong>&nbsp;{p.color || ''} {p.gb ? p.gb + 'GB' : ''} · {sym(p.precio_moneda)}{fmt(p.precio_venta)}{p.imei ? ' · IMEI ' + p.imei : ''}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                      {cart.map((it, i) => (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 90px 78px auto', gap: 6, alignItems: 'center' }}>
                          <input className="input" placeholder="Producto" value={it.descripcion} onChange={e => setItem(i, 'descripcion', e.target.value)} />
                          <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="1" value={it.cantidad} onChange={e => setItem(i, 'cantidad', e.target.value)} />
                          <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="Precio" value={it.precio_vendido} onChange={e => setItem(i, 'precio_vendido', e.target.value)} />
                          <select className="input" value={it.moneda} onChange={e => setItem(i, 'moneda', e.target.value)}><option>USD</option><option>ARS</option></select>
                          <button type="button" className="icon-btn" onClick={() => rmItem(i)}><Icons.X size={14} /></button>
                        </div>
                      ))}
                    </div>
                    <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={addItemManual}><Icons.Plus size={13} /> Ítem manual</button>
                  </div>

                  {/* Vendedor / cliente */}
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Vendedor</label><select className="input" value={vForm.vendedor_id} onChange={e => setVF('vendedor_id', e.target.value)}><option value="">—</option>{vendedores.map(v => <option key={v.id} value={v.id}>{v.nombre}</option>)}</select></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Comisión (USD)</label><input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="0" value={vForm.comision} onChange={e => setVF('comision', e.target.value)} /></div>
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1, position: 'relative' }}>
                      <label className="field-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>Cliente</span>
                        {/* Botón siempre visible para abrir el mini-form de cliente nuevo
                            sin tener que tipear primero en el buscador. Si el operador
                            quiere cargar un cliente con datos completos directo, hace
                            click acá. (También se sigue ofreciendo desde el dropdown
                            como "Crear cliente «X»" si tipea algo nuevo.) */}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => abrirQuickClient(vForm.cliente_nombre)}>
                          <Icons.Plus size={11} /> Nuevo cliente
                        </button>
                      </label>
                      <input className="input" placeholder="Buscar cliente..." autoComplete="off"
                        value={vForm.cliente_nombre}
                        onChange={e => { setVForm(f => ({ ...f, cliente_nombre: e.target.value, cliente_id: '' })); setClienteDrop(true); }}
                        onFocus={() => setClienteDrop(true)}
                        onBlur={() => setTimeout(() => setClienteDrop(false), 150)} />
                      {clienteDrop && (() => {
                        const q = vForm.cliente_nombre.trim();
                        const ql = q.toLowerCase();
                        const matches = contactos.filter(c => (`${c.nombre} ${c.apellido || ''}`).toLowerCase().includes(ql)).slice(0, 8);
                        const exact = contactos.some(c => `${c.nombre}${c.apellido ? ' ' + c.apellido : ''}`.trim().toLowerCase() === ql);
                        const showCreate = q.length >= 2 && !exact;
                        if (!matches.length && !showCreate) return null;
                        return (
                          <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60, maxHeight: 220, overflowY: 'auto', marginTop: 2, padding: 4 }}>
                            {matches.map(c => (
                              <div key={c.id} className="nav-item" style={{ cursor: 'pointer', fontSize: 13 }}
                                onMouseDown={() => { setVForm(f => ({ ...f, cliente_nombre: `${c.nombre}${c.apellido ? ' ' + c.apellido : ''}`, cliente_id: c.id })); setClienteDrop(false); }}>
                                {c.nombre}{c.apellido ? ' ' + c.apellido : ''} {c.tipo && <span className="muted tiny">· {c.tipo}</span>}
                              </div>
                            ))}
                            {showCreate && (
                              <div className="nav-item" style={{ cursor: 'pointer', fontSize: 13, color: 'var(--accent)' }} onMouseDown={() => abrirQuickClient(q)}>
                                <Icons.Plus size={12} /> Crear cliente «{q}»
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {vForm.cliente_id && <div className="tiny pos" style={{ marginTop: 2 }}>✓ vinculado a la base de clientes</div>}

                      {/* Mini-form embebido — Nuevo cliente con datos completos
                          (DNI, WhatsApp, email, fecha de nacimiento). Se abre al
                          clickear "Crear cliente «X»" en el dropdown. */}
                      {quickClient.open && (
                        <div className="card card-tight" style={{ marginTop: 10, padding: 14, background: 'var(--surface-2)' }}>
                          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Nuevo cliente</div>
                          <div className="muted tiny" style={{ marginBottom: 12 }}>
                            Solo el nombre es obligatorio. El resto es opcional pero ayuda al seguimiento post-venta.
                          </div>
                          <div className="stack" style={{ gap: 10 }}>
                            <div className="field">
                              <label className="field-label" htmlFor="qc-nombre">Nombre completo <span style={{ color: 'var(--neg)' }}>*</span></label>
                              <input id="qc-nombre" className="input" autoFocus
                                value={quickClient.nombre}
                                onChange={e => setQuickClient(q => ({ ...q, nombre: e.target.value }))} />
                            </div>
                            <div className="row" style={{ gap: 10 }}>
                              <div className="field" style={{ flex: 1 }}>
                                <label className="field-label" htmlFor="qc-dni">DNI</label>
                                <input id="qc-dni" className="input" inputMode="numeric" pattern="[0-9]*" placeholder="Ej: 12345678"
                                  value={quickClient.dni}
                                  onChange={e => setQuickClient(q => ({ ...q, dni: e.target.value }))} />
                              </div>
                              <div className="field" style={{ flex: 1 }}>
                                <label className="field-label" htmlFor="qc-tel">WhatsApp</label>
                                <input id="qc-tel" className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder="Ej: 1123456789"
                                  value={quickClient.telefono}
                                  onChange={e => setQuickClient(q => ({ ...q, telefono: e.target.value }))} />
                              </div>
                            </div>
                            <div className="row" style={{ gap: 10 }}>
                              <div className="field" style={{ flex: 1 }}>
                                <label className="field-label" htmlFor="qc-email">Correo electrónico</label>
                                <input id="qc-email" className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" placeholder="email@ejemplo.com"
                                  value={quickClient.email}
                                  onChange={e => setQuickClient(q => ({ ...q, email: e.target.value }))} />
                              </div>
                              <div className="field" style={{ flex: 1 }}>
                                <label className="field-label" htmlFor="qc-fnac">Fecha de nacimiento</label>
                                <input id="qc-fnac" className="input" type="date"
                                  value={quickClient.fecha_nacimiento}
                                  onChange={e => setQuickClient(q => ({ ...q, fecha_nacimiento: e.target.value }))} />
                              </div>
                            </div>
                            {quickClientError && (
                              <div style={{ color: 'var(--neg)', fontSize: 13 }} role="alert">{quickClientError}</div>
                            )}
                            <div className="flex-row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={cerrarQuickClient} disabled={quickClientSaving}>Cancelar</button>
                              <button type="button" className="btn btn-primary btn-sm" onClick={guardarQuickClient} disabled={quickClientSaving}>
                                {quickClientSaving ? 'Guardando…' : 'Guardar y vincular'}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label" style={{ display: 'flex', justifyContent: 'space-between' }}>Etiqueta <button type="button" className="btn btn-sm" onClick={() => setShowEtiquetas(true)}><Icons.Settings size={11} /> Gestionar</button></label><select className="input" value={vForm.etiqueta_id} onChange={e => setVF('etiqueta_id', e.target.value)}><option value="">Sin etiqueta</option>{etiquetas.map(et => <option key={et.id} value={et.id}>{et.nombre}</option>)}</select></div>
                  </div>
                  <div className="field">
                    <label className="field-label">Cliente cuenta corriente <span className="muted tiny">(requerido si pagás en CC)</span></label>
                    <select className="input" value={vForm.cliente_cc_id} onChange={e => setVF('cliente_cc_id', e.target.value)}>
                      <option value="">— Ninguno —</option>
                      {clientesCC.map(c => <option key={c.id} value={c.id}>{c.nombre}{c.apellido ? ' ' + c.apellido : ''}</option>)}
                    </select>
                    {(() => {
                      const cc = clientesCC.find(c => String(c.id) === String(vForm.cliente_cc_id));
                      if (!cc) return null;
                      const s = Number(cc.saldo) || 0;
                      return <div className="tiny" style={{ marginTop: 4 }}>Saldo actual: {s > 0 ? <span className="neg">debe u$s{fmt(s)}</span> : s < 0 ? <span className="pos">a favor u$s{fmt(-s)}</span> : <span className="muted">sin deuda</span>}</div>;
                    })()}
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label className="field-label">TC venta (ARS/USD)</label><input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="1425" value={vForm.tc_venta} onChange={e => setVF('tc_venta', e.target.value)} /><TcWarning tc={vForm.tc_venta} /></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Estado</label><select className="input" value={vForm.estado} onChange={e => setVF('estado', e.target.value)}><option value="pendiente">Pendiente</option><option value="acreditado">Acreditado</option></select></div>
                  </div>
                  <div className="field">
                    <label className="field-label" style={{ display: 'flex', justifyContent: 'space-between' }}>Garantía (para el comprobante)
                      <button type="button" className="btn btn-sm" onClick={() => setShowGarantias(true)}><Icons.Settings size={11} /> Gestionar</button>
                    </label>
                    <select className="input" value={vForm.garantia_id} onChange={e => setVF('garantia_id', e.target.value)}>
                      <option value="">Predeterminada{garantias.find(g => g.es_default) ? ' (' + garantias.find(g => g.es_default).nombre + ')' : ''}</option>
                      {garantias.map(g => <option key={g.id} value={g.id}>{g.nombre}{g.es_default ? ' ★' : ''}</option>)}
                    </select>
                  </div>

                  {/* Canjes — equipos tomados en parte de pago (junio 2026: array de N)
                      Si "A inventario" está activo, el equipo se crea como producto
                      en Inventario con todos los campos cargados. */}
                  <div>
                    <div className="flex-between" style={{ alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        Equipos en canje {(vForm.canjes || []).length > 0 && <span className="muted tiny">({vForm.canjes.length})</span>}
                      </div>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={addCanje}>
                        <Icons.Plus size={12} /> Agregar equipo
                      </button>
                    </div>
                    {(vForm.canjes || []).length === 0 && (
                      <div className="muted tiny" style={{ padding: '6px 0' }}>
                        Sin equipos en canje. Si el cliente entrega uno como parte de pago, agregalo acá.
                      </div>
                    )}
                    <div className="stack" style={{ gap: 10 }}>
                      {(vForm.canjes || []).map((c, i) => (
                        <div key={i} style={{
                          padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)',
                          borderRadius: 8,
                        }}>
                          {/* Header del canje: índice + botón quitar */}
                          <div className="flex-between" style={{ alignItems: 'center', marginBottom: 8 }}>
                            <div className="muted tiny" style={{ fontWeight: 600 }}>
                              Equipo {i + 1}
                              {c._existing && <span style={{ marginLeft: 6, color: 'var(--accent)' }}>(ya en Inventario)</span>}
                            </div>
                            <button type="button" className="icon-btn" aria-label="Quitar equipo" onClick={() => rmCanje(i)}>
                              <Icons.X size={14} />
                            </button>
                          </div>

                          {/* Fila 1: descripción + IMEI + valor toma */}
                          <div className="row" style={{ marginBottom: 8 }}>
                            <div className="field" style={{ flex: 2 }}>
                              <label className="field-label">Descripción</label>
                              <input className="input" placeholder="iPhone 13 Pro 256 Sierra Blue"
                                     value={c.descripcion} onChange={e => setCanje(i, 'descripcion', e.target.value)} />
                            </div>
                            <div className="field" style={{ flex: 1.2 }}>
                              <label className="field-label">IMEI / Nº serie</label>
                              <input className="input mono" placeholder="35..."
                                     value={c.imei} onChange={e => setCanje(i, 'imei', e.target.value)} />
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label className="field-label">Valor toma (USD)</label>
                              <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono"
                                     placeholder="0" value={c.valor_toma} onChange={e => setCanje(i, 'valor_toma', e.target.value)} />
                            </div>
                          </div>

                          {/* Fila 2: GB, color, batería, condición */}
                          <div className="row" style={{ marginBottom: 8 }}>
                            <div className="field" style={{ flex: 0.7 }}>
                              <label className="field-label">GB</label>
                              <input className="input" placeholder="256"
                                     value={c.gb} onChange={e => setCanje(i, 'gb', e.target.value)} />
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label className="field-label">Color</label>
                              <input className="input" placeholder="Sierra Blue"
                                     value={c.color} onChange={e => setCanje(i, 'color', e.target.value)} />
                            </div>
                            <div className="field" style={{ flex: 0.7 }}>
                              <label className="field-label">% Batería</label>
                              <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono"
                                     min="0" max="100" placeholder="100"
                                     value={c.bateria} onChange={e => setCanje(i, 'bateria', e.target.value)} />
                            </div>
                            <div className="field" style={{ flex: 0.8 }}>
                              <label className="field-label">Condición</label>
                              <select className="input" value={c.condicion}
                                      onChange={e => setCanje(i, 'condicion', e.target.value)}>
                                <option value="usado">Usado</option>
                                <option value="nuevo">Nuevo</option>
                              </select>
                            </div>
                          </div>

                          {/* Fila 3: categoría + precio sugerido + a inventario */}
                          <div className="row" style={{ marginBottom: 8 }}>
                            <div className="field" style={{ flex: 1.5 }}>
                              <label className="field-label">Categoría Inventario</label>
                              <select className="input" value={c.categoria_id}
                                      onChange={e => setCanje(i, 'categoria_id', e.target.value)}
                                      disabled={c._existing}>
                                <option value="">— sin asignar —</option>
                                {categoriasInv.map(cat => (
                                  <option key={cat.id} value={cat.id}>{cat.nombre}</option>
                                ))}
                              </select>
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label className="field-label">Precio venta sugerido (USD)</label>
                              <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono"
                                     placeholder="0 (editar en Inventario después)"
                                     value={c.precio_venta_sugerido}
                                     onChange={e => setCanje(i, 'precio_venta_sugerido', e.target.value)}
                                     disabled={c._existing} />
                            </div>
                            <div className="field" style={{ flex: 0.8, alignSelf: 'end' }}>
                              <label className="flex-row" style={{ gap: 6, fontSize: 12, cursor: c._existing ? 'not-allowed' : 'pointer' }}>
                                <input type="checkbox" checked={c.agregar_stock}
                                       disabled={c._existing}
                                       onChange={e => setCanje(i, 'agregar_stock', e.target.checked)} />
                                A inventario
                              </label>
                            </div>
                          </div>

                          {/* Fila 4: observaciones (solo si va a inventario, sino no aporta) */}
                          {c.agregar_stock && !c._existing && (
                            <div className="field">
                              <label className="field-label">Observaciones (opcional)</label>
                              <input className="input" placeholder="Pantalla sin raspones, caja original, batería al 87%"
                                     value={c.observaciones}
                                     onChange={e => setCanje(i, 'observaciones', e.target.value)} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Pagos */}
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Pagos</div>
                    <div className="stack" style={{ gap: 6 }}>
                      {pagos.map((p, i) => (
                        <div key={i}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 78px 78px auto', gap: 6, alignItems: 'center' }}>
                            <select className="input" value={p.es_cuenta_corriente ? '__CC__' : p.metodo_nombre} onChange={e => setPagoMetodo(i, e.target.value)}><option value="">Método…</option>{metodos.map(m => <option key={m.id} value={m.nombre}>{m.nombre}</option>)}<option value="__CC__">Cuenta corriente (deuda)</option></select>
                            <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="Monto" value={p.monto} onChange={e => setPago(i, 'monto', e.target.value)} />
                            <select className="input" value={p.moneda} onChange={e => setPago(i, 'moneda', e.target.value)}><option>ARS</option><option>USD</option><option>USDT</option></select>
                            <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="TC" value={p.tc} onChange={e => setPago(i, 'tc', e.target.value)} />
                            <button type="button" className="icon-btn" onClick={() => rmPago(i)}><Icons.X size={14} /></button>
                          </div>
                          <TcWarning tc={p.tc} />
                        </div>
                      ))}
                    </div>
                    <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={addPago}><Icons.Plus size={13} /> Agregar método</button>
                  </div>

                  {/* Totales */}
                  <div className="card card-tight" style={{ padding: '10px 14px' }}>
                    <div className="flex-between" style={{ fontSize: 13 }}><span className="muted">Total venta</span><span className="mono" style={{ fontWeight: 700 }}>u$s{fmt(totales.items)}</span></div>
                    <div className="flex-between" style={{ fontSize: 13 }}><span className="muted">Pagos{(vForm.canjes || []).length > 0 ? ` + ${vForm.canjes.length} canje${vForm.canjes.length > 1 ? 's' : ''}` : ''}</span><span className="mono">u$s{fmt(totales.cubierto)}</span></div>
                    <div className="flex-between" style={{ fontSize: 13 }}><span className="muted">Diferencia</span>
                      <span>{Math.abs(totales.dif) < 0.01 ? <span className="pos">Cubierto ✓</span> : totales.dif < 0 ? <span className="neg">Falta u$s{fmt(-totales.dif)}</span> : <span className="warn">Sobra u$s{fmt(totales.dif)}</span>}</span>
                    </div>
                  </div>

                  {/* Comprobantes */}
                  <div className="field">
                    <label className="field-label">Comprobantes de pago (imágenes/PDF, máx 6MB c/u)</label>
                    <input type="file" multiple accept="image/*,application/pdf" className="input" onChange={onComprobFiles} />
                    {comprobantes.length > 0 && <div className="muted tiny" style={{ marginTop: 4 }}>{comprobantes.length} archivo(s) listo(s)</div>}
                  </div>

                  <div className="field"><label className="field-label">Observaciones</label><input className="input" placeholder="Notas adicionales…" value={vForm.notas} onChange={e => setVF('notas', e.target.value)} /></div>
                  {ventaError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{ventaError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowVenta(false)}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={savingVenta}>{savingVenta ? 'Guardando…' : 'Guardar venta'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal Venta rápida ── */}
      {showRapida && (
        <div ref={rapidaModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowRapida(false)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Venta rápida</h3><button type="button" className="icon-btn" onClick={() => setShowRapida(false)} aria-label="Cerrar" title="Cerrar"><Icons.X size={16} /></button></div>
            <form onSubmit={handleSaveRapida}>
              <div className="modal-body">
                <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Nota rápida para cargar después como venta completa.</p>
                <div className="row">
                  <div className="field" style={{ flex: 1 }}><label className="field-label">Vendedor</label><input className="input" value={rForm.vendedor_nombre} onChange={e => setRForm(f => ({ ...f, vendedor_nombre: e.target.value }))} /></div>
                  <div className="field" style={{ flex: 1 }}><label className="field-label">Cliente</label><input className="input" value={rForm.cliente_texto} onChange={e => setRForm(f => ({ ...f, cliente_texto: e.target.value }))} /></div>
                </div>
                <div className="field"><label className="field-label">Detalle <span style={{ color: 'var(--neg)' }}>*</span></label><textarea className="input" rows={3} placeholder="iPhone 15 Pro 256 White — 500 efectivo + 338 transferencia" value={rForm.detalle} onChange={e => setRForm(f => ({ ...f, detalle: e.target.value }))} /></div>
              </div>
              <div className="modal-ft"><button type="button" className="btn btn-ghost" onClick={() => setShowRapida(false)}>Cancelar</button><button type="submit" className="btn btn-primary" disabled={savingRapida}>{savingRapida ? 'Guardando…' : 'Guardar'}</button></div>
            </form>
          </div>
        </div>
      )}


      {/* ── Modal Garantías ── */}
      {showGarantias && (
        <div ref={garantiasModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowGarantias(false)}>
          <div className="modal" style={{ maxWidth: 720 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Plantillas de garantía</h3><button type="button" className="icon-btn" onClick={() => setShowGarantias(false)} aria-label="Cerrar" title="Cerrar"><Icons.X size={16} /></button></div>
            <div className="modal-body" style={{ maxHeight: '74vh', overflowY: 'auto' }}>
              <div className="stack" style={{ gap: 6, marginBottom: 14 }}>
                {garantias.length === 0 && <div className="empty">Sin plantillas</div>}
                {garantias.map(g => (
                  <div key={g.id} className="flex-between" style={{ gap: 8, padding: '8px 0', borderBottom: '1px solid var(--hairline)', alignItems: 'flex-start' }}>
                    <div style={{ fontSize: 13, maxWidth: '78%' }}><strong>{g.nombre}</strong>{g.es_default && <> <Badge tone="pos">Predeterminada</Badge></>}<div className="muted tiny" style={{ whiteSpace: 'pre-wrap', maxHeight: 50, overflow: 'hidden' }}>{g.texto}</div></div>
                    <div className="flex-row" style={{ gap: 6, flexShrink: 0 }}>
                      <button className="icon-btn" onClick={() => setGForm({ id: g.id, nombre: g.nombre, texto: g.texto, es_default: !!g.es_default })}><Icons.Edit size={14} /></button>
                      <button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => deleteGarantia(g.id)}><Icons.Trash size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
              <form onSubmit={handleSaveGarantia}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>{gForm.id ? 'Editar plantilla' : 'Nueva plantilla'}</div>
                <div className="field"><label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label><input className="input" placeholder="General, Apple discontinuado…" value={gForm.nombre} onChange={e => setGForm(f => ({ ...f, nombre: e.target.value }))} /></div>
                <div className="field">
                  <label className="field-label">Texto <span style={{ color: 'var(--neg)' }}>*</span></label>
                  <textarea
                    className="input"
                    rows={10}
                    value={gForm.texto}
                    onChange={e => setGForm(f => ({ ...f, texto: e.target.value }))}
                    style={{ height: 'auto', minHeight: 220, padding: '12px 14px', lineHeight: 1.55, fontSize: 14, resize: 'vertical', whiteSpace: 'pre-wrap' }}
                  />
                </div>
                <label className="flex-row" style={{ gap: 8, fontSize: 13, marginBottom: 10, cursor: 'pointer' }}><input type="checkbox" checked={gForm.es_default} onChange={e => setGForm(f => ({ ...f, es_default: e.target.checked }))} /> Marcar como predeterminada</label>
                <div className="flex-row" style={{ gap: 8 }}>
                  <button type="button" className="btn btn-ghost" onClick={() => setGForm({ id: null, nombre: '', texto: '', es_default: false })}>Limpiar</button>
                  <button type="submit" className="btn btn-primary" disabled={savingGar}>{savingGar ? 'Guardando…' : 'Guardar plantilla'}</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal etiquetas ── */}
      {showEtiquetas && (
        <div className="modal-overlay" onClick={() => setShowEtiquetas(false)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Etiquetas de venta</h3><button className="icon-btn" onClick={() => setShowEtiquetas(false)}><Icons.X size={16} /></button></div>
            <div className="modal-body">
              <div className="flex-row" style={{ gap: 6, marginBottom: 10 }}>
                <input className="input" placeholder="Nueva etiqueta (ej. Mayorista)" value={nuevaEtiqueta} onChange={e => setNuevaEtiqueta(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEtiqueta(); } }} />
                <button className="btn btn-sm" onClick={addEtiqueta}><Icons.Plus size={13} /></button>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                {etiquetas.length === 0 && <div className="muted tiny">Sin etiquetas</div>}
                {etiquetas.map(et => (
                  <div key={et.id} className="flex-between" style={{ fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--hairline)' }}>
                    <span>{et.nombre}</span>
                    <button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => delEtiqueta(et.id)}><Icons.Trash size={13} /></button>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-primary" onClick={() => setShowEtiquetas(false)}>Listo</button></div>
          </div>
        </div>
      )}

      {/* ── Modal ver comprobantes adjuntos ── */}
      {showComprob != null && (
        <div className="modal-overlay" onClick={() => setShowComprob(null)}>
          <div className="modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Comprobantes de la venta</h3><button className="icon-btn" onClick={() => setShowComprob(null)}><Icons.X size={16} /></button></div>
            <div className="modal-body">
              {comprobList == null ? <div className="muted">Cargando…</div> : comprobList.length === 0 ? <div className="empty">Sin comprobantes</div> : (
                comprobList.map(c => (
                  <div key={c.id} className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--hairline)' }}>
                    <span style={{ fontSize: 13 }}>{c.archivo_nombre || 'archivo'}</span>
                    <button className="btn btn-sm" onClick={() => abrirComprob(c.id)}><Icons.Eye size={13} /> Ver</button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal: diferencia en métodos de pago. Custom (no ConfirmModal) para
          tener desglose visual con colores y dos acciones: corregir / aceptar igual. */}
      <DiffModal
        state={diffModal}
        onClose={() => setDiffModal({ open: false, items: 0, cubierto: 0, dif: 0, resolve: null })}
      />

      {/* Modal: venta guardada con opción de descargar PDF (lazy import del
          módulo para no inflar el bundle principal — solo se carga cuando el
          usuario hace click). */}
      <ExitoModal
        state={exitoModal}
        onClose={() => setExitoModal({ open: false, venta: null })}
        pdfLoading={pdfLoading}
        onDescargar={(venta) => withPdfLoading(async () => {
          try {
            const mod = await import('../lib/generarComprobantePdf');
            await mod.generarComprobantePdf(venta);
          } catch (e) {
            // Mostramos el error real para que el usuario lo pueda reportar
            // sin tener que abrir la consola. El stack queda en console.error
            // como antes para debugging.
            console.error('PDF error:', e);
            const detalle = e?.message || String(e);
            toast.error(`No se pudo generar el comprobante PDF: ${detalle}`, { duration: 12000 });
          }
        })}
      />
    </div>
  );
}

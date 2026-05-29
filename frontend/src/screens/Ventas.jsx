import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { ventas, inventario, vendedores as vendedoresApi, cuentas as cuentasApi, contactos as contactosApi } from '../lib/api';
import { exportCsv } from '../lib/exportCsv';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n) { return Math.round(Number(n) || 0).toLocaleString('es-AR'); }
function fmt2(n) { return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function sym(m) { return m === 'ARS' ? '$' : 'u$s'; }
function toUsd(monto, moneda, tc) {
  const m = Number(monto) || 0;
  if (moneda === 'USD' || moneda === 'USDT') return m;
  if (moneda === 'ARS') return tc && Number(tc) > 0 ? m / Number(tc) : 0;
  return m;
}
function todayStr() { return new Date().toLocaleDateString('sv'); }
function shiftDate(iso, days) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toLocaleDateString('sv'); }
function monthStart() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('sv'); }
function weekStart() { const d = new Date(); const off = (d.getDay() + 6) % 7; d.setDate(d.getDate() - off); return d.toLocaleDateString('sv'); }

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
  canjeOn: false, canjeDesc: '', canjeValor: '', canjeStock: false,
};

function Badge({ tone = 'default', children }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
function Seg({ value, options, onChange }) {
  return <div className="seg">{options.map(o => <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────
function HourChart({ data }) {
  const byH = {}; (data || []).forEach(h => { byH[h.hora] = h.n; });
  const max = Math.max(1, ...Object.values(byH));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 110 }}>
      {Array.from({ length: 24 }, (_, h) => {
        const n = byH[h] || 0;
        const pct = Math.round((n / max) * 100);
        return (
          <div key={h} title={`${h}:00 — ${n} venta(s)`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 3 }}>
            <div style={{ width: '62%', height: Math.max(pct, 3) + '%', background: n ? 'var(--pos)' : 'var(--border)', borderRadius: '2px 2px 0 0' }} />
            <div className="muted" style={{ fontSize: 8 }}>{h % 4 === 0 ? String(h).padStart(2, '0') : ' '}</div>
          </div>
        );
      })}
    </div>
  );
}

function Dashboard({ d }) {
  if (!d) return null;
  const i = d.ingresos, dif = d.diferencias;
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div className="kpi-label">Ingresos totales</div>
        <div style={{ fontSize: 26, fontWeight: 700, margin: '4px 0' }}>
          <span className="mono">u$s{fmt(i.usd)}</span> <span className="muted" style={{ fontSize: 17 }}>+ ${fmt(i.ars)} ARS</span>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>USD equivalente: <span className="pos mono" style={{ fontWeight: 600 }}>u$s{fmt(i.total_usd_equiv)}</span> · {d.ventas_count} venta{d.ventas_count === 1 ? '' : 's'}</div>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Unidades vendidas</div>
          <div className="kpi-value" style={{ fontSize: 17 }}>📱 {d.unidades.celulares} · 🎧 {d.unidades.accesorios}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Ganancia neta</div>
          <div className="kpi-value mono pos" style={{ fontSize: 17 }}>u$s{fmt(d.ganancia_neta_usd)}</div>
          <div className="muted tiny" style={{ marginTop: 4 }}>{d.margen_pct}% · egresos u$s{fmt(d.egresos_usd)}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Costos productos</div>
          <div className="kpi-value mono" style={{ fontSize: 17 }}>u$s{fmt(d.costos_usd)}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Inversión canjes</div>
          <div className="kpi-value mono" style={{ fontSize: 17, color: 'var(--warn)' }}>u$s{fmt(d.inversion_canjes_usd)}</div>
        </div>
      </div>
      <div className="row">
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label" style={{ marginBottom: 8 }}>Métodos de pago</div>
          <table className="table" style={{ fontSize: 12 }}>
            <tbody>
              {d.metodos_pago.length === 0 && <tr><td className="muted">Sin pagos</td></tr>}
              {d.metodos_pago.map((m, k) => (
                <tr key={k}><td>{m.metodo_nombre}</td><td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>{sym(m.moneda)}{fmt(m.total)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 11, marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            Diferencias — sobrepagos <span className="pos">u$s{fmt(dif.sobrepagos)}</span> · faltantes <span className="neg">u$s{fmt(dif.faltantes)}</span> · neto <strong>u$s{fmt(dif.neto)}</strong>
          </div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label" style={{ marginBottom: 8 }}>Ventas por horario</div>
          <HourChart data={d.por_horario} />
          <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
            Etiquetas: {d.por_etiqueta.length ? d.por_etiqueta.map((e, k) => <span key={k} className="badge badge-default" style={{ marginRight: 6 }}>{e.etiqueta}: {e.n}</span>) : '—'}
          </div>
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Ticket promedio</div>
          <div className="kpi-value mono" style={{ fontSize: 17 }}>u$s{fmt(d.ticket_promedio_usd)}</div>
          <div className="muted tiny" style={{ marginTop: 4 }}>{d.ventas_count} venta{d.ventas_count === 1 ? '' : 's'}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label" style={{ marginBottom: 8 }}>Top productos</div>
          {(d.top_productos || []).length === 0 ? <div className="muted tiny">—</div> : d.top_productos.map((p, k) => (
            <div key={k} className="flex-between" style={{ fontSize: 12, padding: '2px 0' }}><span>{p.descripcion}</span><span className="mono muted">{p.unidades}u</span></div>
          ))}
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label" style={{ marginBottom: 8 }}>Top vendedores</div>
          {(d.top_vendedores || []).length === 0 ? <div className="muted tiny">—</div> : d.top_vendedores.map((v, k) => (
            <div key={k} className="flex-between" style={{ fontSize: 12, padding: '2px 0' }}><span>{v.vendedor}</span><span className="mono pos">u$s{fmt(v.total_usd)}</span></div>
          ))}
        </div>
      </div>
    </div>
  );
}

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
  const [metodos, setMetodos] = useState([]);
  const [garantias, setGarantias] = useState([]);
  const [clientesCC, setClientesCC] = useState([]);
  const [contactos, setContactos] = useState([]);
  const [clienteDrop, setClienteDrop] = useState(false);

  // Modales
  const [showVenta, setShowVenta] = useState(false);
  const [showRapida, setShowRapida] = useState(false);
  const [showGarantias, setShowGarantias] = useState(false);
  const [showEtiquetas, setShowEtiquetas] = useState(false);
  const [nuevaEtiqueta, setNuevaEtiqueta] = useState('');
  const [showComprob, setShowComprob] = useState(null); // venta id
  const [comprobList, setComprobList] = useState([]);

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
    const [v, e, m, g, cc, ct] = await Promise.all([
      safe(vendedoresApi.list()), safe(ventas.etiquetas()), safe(ventas.metodosPago()), safe(ventas.garantias()), safe(cuentasApi.clientes()), safe(contactosApi.list()),
    ]);
    // El endpoint de clientes B2B está paginado → { data, pagination }. Tomamos el array.
    const ccArr = Array.isArray(cc) ? cc : (cc?.data ?? []);
    setVendedores(v); setEtiquetas(e); setMetodos(m); setGarantias(g); setClientesCC(ccArr); setContactos(ct);
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
      canjeOn: (v.canjes || []).length > 0, canjeDesc: v.canjes?.[0]?.descripcion || '', canjeValor: v.canjes?.[0]?.valor_toma || '',
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
    const canje = vForm.canjeOn ? (Number(vForm.canjeValor) || 0) : 0;
    const cubierto = pg + canje;
    return { items, cubierto, dif: cubierto - items };
  }, [cart, pagos, vForm.tc_venta, vForm.canjeOn, vForm.canjeValor]);

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
    const canjes = vForm.canjeOn ? [{ descripcion: (vForm.canjeDesc || 'Canje').trim(), valor_toma: Number(vForm.canjeValor) || 0, moneda: 'USD', agregar_stock: vForm.canjeStock }] : [];

    // Aviso de diferencia: si el total cobrado != total de items (con canje),
    // pedir confirmación explícita y, si el operador acepta, agregar un item
    // "Diferencia" para que el profit refleje la realidad:
    //   · A favor (cobrado de más):  precio_vendido = +dif, costo = 0
    //     → sube total_usd y ganancia_usd.
    //   · En contra (cobrado de menos): precio_vendido = 0, costo = |dif|
    //     → no toca total_usd pero baja ganancia_usd.
    // (No usamos precio negativo: la DB tiene CHECK precio_vendido >= 0.)
    // Tolerancia 0.005 USD para no marcar errores de redondeo por floats.
    if (Math.abs(totales.dif) > 0.005) {
      const aFavor = totales.dif > 0;
      const monto = Math.abs(totales.dif).toFixed(2);
      const ok = await confirm({
        title: 'Hay una diferencia en esta venta',
        message:
          `Total productos: u$s ${totales.items.toFixed(2)}\n` +
          `Total cobrado:   u$s ${totales.cubierto.toFixed(2)}\n` +
          `Diferencia:      u$s ${monto} ${aFavor ? 'a favor (cobrado de más)' : 'en contra (falta cobrar)'}\n\n` +
          `Si aceptás, se sumará como un ítem "Diferencia" para que el profit lo refleje. ¿Guardar igual?`,
        confirmLabel: 'Guardar igual',
        cancelLabel:  'Volver a editar',
        danger: !aFavor,
      });
      if (!ok) return;
      // Inyectamos el item de diferencia al payload (no al state del cart,
      // para no enredar el render). Se etiqueta claro para que se vea
      // en la grilla de Ventas y en el detalle del comprobante.
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
      else toast.success(editId ? 'Venta actualizada.' : 'Venta registrada.');
      setShowVenta(false);
      // Cobro por Financiera con comprobante OK: ya se auto-generó el de Financiera → ir a verificarlo.
      if (!editId && usaFinanciera && !uploadFalló) { navigate('/financiera'); return; }
      await Promise.all([loadDash(), loadLista(), loadRapidas()]);
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

  // ── Comprobante imprimible / PDF ──
  function comprobantePDF(v) {
    const garFuente = v.garantia_id ? garantias.find(g => g.id === v.garantia_id) : garantias.find(g => g.es_default);
    const garTexto = (garFuente ? garFuente.texto : GARANTIA_FALLBACK).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
    const vend = vendedores.find(x => x.id === (v.items.find(i => i.vendedor_id) || {}).vendedor_id);
    const fechaHora = (v.fecha || '').substring(0, 10).split('-').reverse().join('/') + (v.hora ? ' ' + v.hora.substring(0, 5) : '');
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const filas = (v.items || []).map(it => `<tr><td style="font-weight:700">${esc(it.descripcion)}</td><td style="color:#555">${it.imei ? 'IMEI: ' + esc(it.imei) : '—'}</td><td style="text-align:center">${it.cantidad}</td><td>${sym(it.moneda)}${fmt2(it.precio_vendido)}</td><td>${sym(it.moneda)}${fmt2(it.precio_vendido * it.cantidad)}</td></tr>`).join('');
    const pgs = (v.pagos || []).map(p => `<li>${esc(p.metodo_nombre)}: ${sym(p.moneda)}${fmt2(p.monto)}</li>`).join('') || '<li>—</li>';
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Comprobante #${esc(v.order_id)}</title><style>
      *{box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif}body{margin:0;background:#f5f6f8;color:#1a1a2e;padding:24px}
      .sheet{max-width:760px;margin:0 auto;background:#fff;padding:32px 36px;border-radius:10px;box-shadow:0 2px 14px rgba(0,0,0,.08)}
      .logo{width:84px;height:84px;background:#0d2a4d;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:22px;margin:0 auto}
      h1{text-align:center;color:#1f6fe5;font-size:26px;margin:18px 0 2px}.orden{text-align:center;color:#555;margin:0 0 14px}
      .rule{border:none;border-top:3px solid #1f6fe5;margin:14px 0 22px}.card{border:1px solid #e3e6ea;border-radius:8px;padding:14px 16px;margin-bottom:16px}
      .card h2{color:#1f6fe5;font-size:15px;margin:0 0 8px}.card p{margin:3px 0;font-size:14px}table{width:100%;border-collapse:collapse;margin-bottom:4px}
      th{background:#f0f2f5;text-align:left;padding:9px 10px;font-size:12px;border:1px solid #e3e6ea}td{padding:9px 10px;font-size:13px;border:1px solid #e3e6ea}
      .totbox{border:1px solid #e3e6ea;border-radius:8px;padding:12px 16px;margin-bottom:16px}.totrow{display:flex;justify-content:space-between;font-size:14px;padding:3px 0}
      .total{display:flex;justify-content:space-between;border-top:3px solid #1f6fe5;margin-top:8px;padding-top:10px;font-size:20px;font-weight:800;color:#1f6fe5}
      .pagos{background:#eef4ff;border-radius:8px;padding:12px 16px;margin-bottom:16px}.pagos h2{color:#1f6fe5;font-size:15px;margin:0 0 6px}.pagos ul{margin:0;padding-left:18px;font-size:14px}
      .garantia{border:2px dashed #34a853;border-radius:8px;padding:14px 16px;background:#f4fbf6;font-size:13px;line-height:1.5}.garantia h2{color:#2e7d46;font-size:15px;margin:0 0 8px}
      .foot{text-align:center;color:#888;font-size:12px;margin-top:20px}.toolbar{max-width:760px;margin:0 auto 14px;text-align:right}
      .btn{background:#1f6fe5;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer}
      @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0;max-width:100%}.toolbar{display:none}}</style></head><body>
      <div class="toolbar"><button class="btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
      <div class="sheet"><div class="logo">iPro</div><h1>COMPROBANTE DE VENTA</h1><p class="orden">Orden #${esc(v.order_id)}</p><hr class="rule">
      <div class="card"><h2>🧾 Información de la Venta</h2><p><strong>Fecha:</strong> ${esc(fechaHora)}</p><p><strong>Estado:</strong> ${ESTADO_LABEL[v.estado] || esc(v.estado)}</p><p><strong>Vendedor:</strong> ${vend ? esc(vend.nombre) : '—'}</p></div>
      <div class="card"><h2>👤 Información del Cliente</h2><p><strong>Nombre:</strong> ${esc(v.cliente_nombre) || 'Consumidor final'}</p></div>
      <h2 style="color:#1f6fe5;font-size:15px">📦 Productos</h2><table><thead><tr><th>Producto</th><th>Detalles</th><th style="text-align:center">Cant.</th><th>Precio Unit.</th><th>Subtotal</th></tr></thead><tbody>${filas}</tbody></table>
      <div class="totbox"><div class="totrow"><span>Subtotal:</span><span>u$s${fmt2(v.total_usd)}</span></div><div class="total"><span>TOTAL:</span><span>u$s${fmt2(v.total_usd)}</span></div></div>
      <div class="pagos"><h2>💳 Métodos de Pago</h2><ul>${pgs}</ul></div>
      <div class="garantia"><h2>🛡️ GARANTÍA</h2>${garTexto}</div>
      <div class="foot">Comprobante generado electrónicamente el ${esc(new Date().toLocaleString('es-AR'))}<br>iPro — Tech Reseller</div></div></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { toast.error('Permití las ventanas emergentes.'); return; }
    w.document.write(html); w.document.close();
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
        <div className="card card-flush">
          <table className="table">
            <thead><tr><th>Estado</th><th>Fecha</th><th>Cliente</th><th>Productos</th><th>Pagos</th><th>Ganancia</th><th>Total</th><th></th></tr></thead>
            <tbody>
              {lista.map(v => (
                <tr key={v.id}>
                  <td>{estadoBadge(v.estado)}<div className="muted tiny mono" style={{ marginTop: 3 }}>{v.order_id}</div></td>
                  <td className="muted tiny" style={{ whiteSpace: 'nowrap' }}>{(v.fecha || '').substring(0, 10)}{v.hora ? <><br />{v.hora.substring(0, 5)}</> : ''}</td>
                  <td>{v.cliente_nombre || '—'}{v.etiqueta_nombre && <><br /><Badge tone="default">{v.etiqueta_nombre}</Badge></>}</td>
                  <td style={{ fontSize: 12 }}>{(v.items || []).map((i, k) => <div key={k}>{i.descripcion}{i.cantidad > 1 ? ' ×' + i.cantidad : ''}</div>)}{(v.canjes || []).map((c, k) => <div key={'c' + k} style={{ color: 'var(--warn)', fontSize: 11 }}>↺ {c.descripcion}</div>)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{(v.pagos || []).map((p, k) => <div key={k}>{p.metodo_nombre}: {sym(p.moneda)}{fmt(p.monto)}</div>)}</td>
                  <td className="mono pos" style={{ fontWeight: 600 }}>u$s{fmt(v.ganancia_usd)}</td>
                  <td className="mono" style={{ fontWeight: 600 }}>u$s{fmt(v.total_usd)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <select className="input" style={{ width: 'auto', display: 'inline-block', padding: '4px 6px', fontSize: 11 }} value={v.estado} onChange={e => changeEstado(v.id, e.target.value)}>
                      <option value="acreditado">Acreditado</option><option value="pendiente">Pendiente</option><option value="cancelado">Cancelado</option>
                    </select>{' '}
                    <button className="icon-btn" title="Editar venta" onClick={() => openEdit(v)}><Icons.Edit size={14} /></button>
                    <button className="icon-btn" title="Comprobante (imprimir/PDF)" onClick={() => comprobantePDF(v)}><Icons.Print size={14} /></button>
                    {Number(v.comprobantes_count) > 0 && <button className="icon-btn" title="Comprobantes adjuntos" onClick={() => openComprob(v.id)}><Icons.Eye size={14} /></button>}
                    <button className="icon-btn" style={{ color: 'var(--neg)' }} title="Eliminar" onClick={() => deleteVenta(v)}><Icons.Trash size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Modal Nueva venta ── */}
      {showVenta && (
        <div className="modal-overlay" onClick={() => setShowVenta(false)}>
          <div className="modal" style={{ maxWidth: 720 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>{editId ? 'Editar venta' : procRapidaId ? 'Procesar venta rápida' : 'Nueva venta'}</h3><button className="icon-btn" onClick={() => setShowVenta(false)}><Icons.X size={16} /></button></div>
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
                          <input type="number" className="input mono" placeholder="1" value={it.cantidad} onChange={e => setItem(i, 'cantidad', e.target.value)} />
                          <input type="number" className="input mono" placeholder="Precio" value={it.precio_vendido} onChange={e => setItem(i, 'precio_vendido', e.target.value)} />
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
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Comisión (USD)</label><input type="number" className="input mono" placeholder="0" value={vForm.comision} onChange={e => setVF('comision', e.target.value)} /></div>
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
                    <div className="field" style={{ flex: 1 }}><label className="field-label">TC venta (ARS/USD)</label><input type="number" className="input mono" placeholder="1425" value={vForm.tc_venta} onChange={e => setVF('tc_venta', e.target.value)} /></div>
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

                  {/* Canje */}
                  <div>
                    <label className="flex-row" style={{ gap: 8, fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={vForm.canjeOn} onChange={e => setVF('canjeOn', e.target.checked)} /> Incluir equipo en canje</label>
                    {vForm.canjeOn && (
                      <div className="row" style={{ marginTop: 8 }}>
                        <div className="field" style={{ flex: 2 }}><label className="field-label">Equipo tomado</label><input className="input" placeholder="iPhone 12 usado" value={vForm.canjeDesc} onChange={e => setVF('canjeDesc', e.target.value)} /></div>
                        <div className="field" style={{ flex: 1 }}><label className="field-label">Valor toma (USD)</label><input type="number" className="input mono" placeholder="0" value={vForm.canjeValor} onChange={e => setVF('canjeValor', e.target.value)} /></div>
                        <div className="field" style={{ flex: 1, alignSelf: 'end' }}><label className="flex-row" style={{ gap: 6, fontSize: 12, cursor: 'pointer' }}><input type="checkbox" checked={vForm.canjeStock} onChange={e => setVF('canjeStock', e.target.checked)} /> A inventario</label></div>
                      </div>
                    )}
                  </div>

                  {/* Pagos */}
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Pagos</div>
                    <div className="stack" style={{ gap: 6 }}>
                      {pagos.map((p, i) => (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 78px 78px auto', gap: 6, alignItems: 'center' }}>
                          <select className="input" value={p.es_cuenta_corriente ? '__CC__' : p.metodo_nombre} onChange={e => setPagoMetodo(i, e.target.value)}><option value="">Método…</option>{metodos.map(m => <option key={m.id} value={m.nombre}>{m.nombre}</option>)}<option value="__CC__">Cuenta corriente (deuda)</option></select>
                          <input type="number" className="input mono" placeholder="Monto" value={p.monto} onChange={e => setPago(i, 'monto', e.target.value)} />
                          <select className="input" value={p.moneda} onChange={e => setPago(i, 'moneda', e.target.value)}><option>ARS</option><option>USD</option><option>USDT</option></select>
                          <input type="number" className="input mono" placeholder="TC" value={p.tc} onChange={e => setPago(i, 'tc', e.target.value)} />
                          <button type="button" className="icon-btn" onClick={() => rmPago(i)}><Icons.X size={14} /></button>
                        </div>
                      ))}
                    </div>
                    <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={addPago}><Icons.Plus size={13} /> Agregar método</button>
                  </div>

                  {/* Totales */}
                  <div className="card card-tight" style={{ padding: '10px 14px' }}>
                    <div className="flex-between" style={{ fontSize: 13 }}><span className="muted">Total venta</span><span className="mono" style={{ fontWeight: 700 }}>u$s{fmt(totales.items)}</span></div>
                    <div className="flex-between" style={{ fontSize: 13 }}><span className="muted">Pagos{vForm.canjeOn ? ' + canje' : ''}</span><span className="mono">u$s{fmt(totales.cubierto)}</span></div>
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
        <div className="modal-overlay" onClick={() => setShowRapida(false)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Venta rápida</h3><button className="icon-btn" onClick={() => setShowRapida(false)}><Icons.X size={16} /></button></div>
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
        <div className="modal-overlay" onClick={() => setShowGarantias(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Plantillas de garantía</h3><button className="icon-btn" onClick={() => setShowGarantias(false)}><Icons.X size={16} /></button></div>
            <div className="modal-body" style={{ maxHeight: '74vh', overflowY: 'auto' }}>
              <div className="stack" style={{ gap: 6, marginBottom: 14 }}>
                {garantias.length === 0 && <div className="empty">Sin plantillas</div>}
                {garantias.map(g => (
                  <div key={g.id} className="flex-between" style={{ gap: 8, padding: '8px 0', borderBottom: '1px solid var(--hairline)', alignItems: 'flex-start' }}>
                    <div style={{ fontSize: 13, maxWidth: '74%' }}><strong>{g.nombre}</strong>{g.es_default && <> <Badge tone="pos">Predeterminada</Badge></>}<div className="muted tiny" style={{ whiteSpace: 'pre-wrap', maxHeight: 34, overflow: 'hidden' }}>{g.texto}</div></div>
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
                <div className="field"><label className="field-label">Texto <span style={{ color: 'var(--neg)' }}>*</span></label><textarea className="input" rows={5} value={gForm.texto} onChange={e => setGForm(f => ({ ...f, texto: e.target.value }))} /></div>
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
    </div>
  );
}

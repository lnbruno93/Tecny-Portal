import { useState, useEffect, useMemo } from 'react';
import { Icons } from '../components/Icons';
import { cajas, contactos as contactosApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';

// ─── Formatters ───────────────────────────────────────────────────────────────
function todayISO() {
  return new Date().toLocaleDateString('sv'); // YYYY-MM-DD
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const TIPO_TONE  = { amigo: 'info', familiar: 'accent', cliente: 'pos', inversor: 'warn', 'ipro team': 'default' };
const TIPO_LABEL = { amigo: 'Amigo', familiar: 'Familiar', cliente: 'Cliente', inversor: 'Inversor', 'ipro team': 'iPro team' };

// Origen de un movimiento de caja (ledger)
const ORIGEN_LABEL = {
  venta: 'Venta', b2b: 'B2B', financiera: 'Financiera', envio: 'Envío',
  egreso: 'Egreso', proveedor: 'Proveedor', transferencia: 'Transferencia', ajuste: 'Ajuste',
};
const ORIGEN_TONE = {
  venta: 'pos', b2b: 'pos', financiera: 'accent', envio: 'pos',
  egreso: 'neg', proveedor: 'neg', transferencia: 'info', ajuste: 'warn',
};

function Badge({ tone = 'default', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
function Status({ tone = 'default', children }) {
  return <span className={`status s-${tone}`}>{children}</span>;
}

// Group deuda movements by contacto_id, compute net saldo
function groupDeudas(movs) {
  const map = {};
  movs.forEach(m => {
    const id = m.contacto_id;
    if (!map[id]) {
      map[id] = {
        contacto_id: id,
        nombre: m.nombre,
        apellido: m.apellido,
        contacto_tipo: m.contacto_tipo,
        saldo_ars: 0,
        saldo_usd: 0,
        movimientos: 0,
        ultima: null,
      };
    }
    const sign = m.mov_tipo === 'debe' ? 1 : -1;
    map[id].saldo_ars += sign * (parseFloat(m.monto_ars) || 0);
    map[id].saldo_usd += sign * (parseFloat(m.monto_usd) || 0);
    map[id].movimientos++;
    if (!map[id].ultima || m.fecha > map[id].ultima) map[id].ultima = m.fecha;
  });
  return Object.values(map).sort((a, b) => b.saldo_ars - a.saldo_ars);
}

const EMPTY_DEUDA = () => ({ fecha: todayISO(), contacto_id: '', tipo: 'debe', monto_ars: '', monto_usd: '', concepto: '' });
const EMPTY_INV   = () => ({ fecha: todayISO(), contacto_id: '', monto: '', tasa: '' });

// ─── Main component ───────────────────────────────────────────────────────────
export default function Cajas() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const [tab, setTab] = useState('config');

  // Deudas
  const [deudaMovs, setDeudaMovs] = useState([]);
  const [selectedContactoId, setSelectedContactoId] = useState(null);
  const [loadingDeudas, setLoadingDeudas] = useState(false);
  const [contactoMovs, setContactoMovs] = useState([]);
  const [loadingContactoMovs, setLoadingContactoMovs] = useState(false);

  // Inversiones
  const [inversiones, setInversiones] = useState([]);
  const [loadingInv, setLoadingInv] = useState(false);

  // All contacts for dropdowns (loaded once)
  const [allContacts, setAllContacts] = useState([]);
  useEffect(() => {
    // contactos API returns a plain array (not paginated)
    contactosApi.list({ limit: 500 })
      .then(rows => setAllContacts(Array.isArray(rows) ? rows : []))
      .catch(console.error);
  }, []);

  // ── Crear contacto ────────────────────────────────────────────────────────
  const [showContacto, setShowContacto] = useState(false);
  const [cForm, setCForm] = useState({ nombre: '', apellido: '', tipo: 'amigo' });
  const [cCreating, setCCreating] = useState(false);
  const [cError, setCError] = useState('');

  // ── Crear movimiento de deuda ─────────────────────────────────────────────
  const [showDeuda, setShowDeuda] = useState(false);
  const [deudaForm, setDeudaForm] = useState(EMPTY_DEUDA);
  const [deudaCreating, setDeudaCreating] = useState(false);
  const [deudaError, setDeudaError] = useState('');

  // ── Crear inversión ───────────────────────────────────────────────────────
  const [showInv, setShowInv] = useState(false);
  const [invForm, setInvForm] = useState(EMPTY_INV);
  const [invCreating, setInvCreating] = useState(false);
  const [invError, setInvError] = useState('');

  // ── Config Cajas (cuentas de dinero = metodos_pago) ───────────────────────
  const [cajasList, setCajasList] = useState([]);
  const [loadingCajas, setLoadingCajas] = useState(false);
  const [cajaForm, setCajaForm] = useState({ nombre: '', moneda: 'ARS', saldo_inicial: '', es_tarjeta: false, comision_pct: '' });
  const [cajaSaving, setCajaSaving] = useState(false);
  const [cajaError, setCajaError] = useState('');
  // Ledger de una caja (modal con movimientos + ajuste manual + saldo inicial)
  const [cajaSel, setCajaSel] = useState(null);
  const [cajaMovs, setCajaMovs] = useState([]);
  const [ajusteForm, setAjusteForm] = useState({ fecha: todayISO(), tipo: 'ingreso', monto: '', tc: '', concepto: '' });
  const [ajusteSaving, setAjusteSaving] = useState(false);

  // ── Movimientos (ledger global de todas las cajas) ────────────────────────
  const EMPTY_LEDGER_FILTROS = { caja_id: '', desde: '', hasta: '', origen: '', tipo: '', page: 1 };
  const [ledgerFiltros, setLedgerFiltros] = useState(EMPTY_LEDGER_FILTROS);
  const [ledgerData, setLedgerData] = useState({ data: [], pagination: { pages: 1, page: 1, total: 0 }, totales: { ingresos_usd: 0, egresos_usd: 0, neto_usd: 0, count: 0 } });
  const [loadingLedger, setLoadingLedger] = useState(false);
  const setLF = (field, val) => setLedgerFiltros(f => ({ ...f, [field]: val, page: field === 'page' ? val : 1 }));

  // ── Tab-aware primary action ──────────────────────────────────────────────
  const { setPrimaryAction } = usePageActions();
  useEffect(() => {
    if (tab === 'deudas') {
      setPrimaryAction({
        label: 'Nuevo movimiento',
        onClick: () => { setDeudaForm(EMPTY_DEUDA()); setDeudaError(''); setShowDeuda(true); },
      });
    } else if (tab === 'inversiones') {
      setPrimaryAction({
        label: 'Nueva inversión',
        onClick: () => { setInvForm(EMPTY_INV()); setInvError(''); setShowInv(true); },
      });
    } else {
      setPrimaryAction(null); // Config Cajas usa formulario inline
    }
    return () => setPrimaryAction(null);
  }, [tab, setPrimaryAction]);

  // Cargar cajas al entrar a la hoja Config
  async function loadCajas() {
    setLoadingCajas(true);
    try { setCajasList(await cajas.listCajas() || []); }
    catch (e) { console.error(e); }
    finally { setLoadingCajas(false); }
  }
  useEffect(() => { if (tab === 'config') loadCajas(); }, [tab]);

  // Movimientos (ledger): cargar lista de cajas (para el filtro) y los datos al entrar / cambiar filtros
  useEffect(() => { if (tab === 'movimientos' && cajasList.length === 0) loadCajas(); }, [tab]); // eslint-disable-line
  useEffect(() => {
    if (tab !== 'movimientos') return;
    setLoadingLedger(true);
    cajas.ledger(ledgerFiltros)
      .then(setLedgerData)
      .catch(e => toast.error(e.message))
      .finally(() => setLoadingLedger(false));
  }, [tab, ledgerFiltros]); // eslint-disable-line

  // ── Handlers ─────────────────────────────────────────────────────────────
  async function handleCreateContacto(e) {
    e.preventDefault();
    if (!cForm.nombre.trim()) { setCError('El nombre es obligatorio.'); return; }
    setCCreating(true); setCError('');
    try {
      const nuevo = await contactosApi.create({
        nombre: cForm.nombre.trim(),
        apellido: cForm.apellido.trim() || null,
        tipo: cForm.tipo,
      });
      // Optimistically add to contacts list and deuda list
      setAllContacts(prev => [...prev, nuevo]);
      setDeudaMovs(prev => [...prev, {
        contacto_id: nuevo.id, nombre: nuevo.nombre, apellido: nuevo.apellido,
        contacto_tipo: nuevo.tipo, mov_tipo: 'debe', monto_ars: 0, monto_usd: 0, fecha: null,
        id: -nuevo.id, concepto: null, created_at: null,
      }]);
      setSelectedContactoId(nuevo.id);
      setShowContacto(false);
      if (tab !== 'deudas') setTab('deudas');
      toast.success('Contacto creado.');
    } catch (err) { setCError(err.message); }
    finally { setCCreating(false); }
  }

  async function handleCreateDeuda(e) {
    e.preventDefault();
    if (!deudaForm.contacto_id) { setDeudaError('Seleccioná un contacto.'); return; }
    const monto_ars = parseFloat(deudaForm.monto_ars) || 0;
    const monto_usd = parseFloat(deudaForm.monto_usd) || 0;
    if (!monto_ars && !monto_usd) { setDeudaError('Ingresá al menos un monto.'); return; }

    setDeudaCreating(true); setDeudaError('');
    try {
      await cajas.createDeuda({
        fecha:       deudaForm.fecha,
        contacto_id: Number(deudaForm.contacto_id),
        tipo:        deudaForm.tipo,
        monto_ars,
        monto_usd,
        concepto:    deudaForm.concepto.trim() || null,
      });
      setShowDeuda(false);
      toast.success('Movimiento registrado.');

      // Refresh global deuda list
      setLoadingDeudas(true);
      cajas.deudas({ limit: 500 })
        .then(res => setDeudaMovs(res.data || []))
        .catch(console.error)
        .finally(() => setLoadingDeudas(false));

      // Auto-select the contacto and refresh its detail
      const cid = Number(deudaForm.contacto_id);
      setSelectedContactoId(cid);
      setLoadingContactoMovs(true);
      cajas.deudas({ contacto_id: cid, limit: 200 })
        .then(res => setContactoMovs(res.data || []))
        .catch(console.error)
        .finally(() => setLoadingContactoMovs(false));
    } catch (err) { setDeudaError(err.message); }
    finally { setDeudaCreating(false); }
  }

  async function handleCreateInversion(e) {
    e.preventDefault();
    if (!invForm.contacto_id) { setInvError('Seleccioná un contacto.'); return; }
    const monto = parseFloat(invForm.monto);
    if (!monto || monto <= 0) { setInvError('El monto debe ser mayor a 0.'); return; }

    setInvCreating(true); setInvError('');
    try {
      await cajas.createInversion({
        fecha:       invForm.fecha,
        contacto_id: Number(invForm.contacto_id),
        monto,
        tasa:        invForm.tasa.trim() || null,
      });
      setShowInv(false);
      toast.success('Inversión registrada.');

      // Refresh inversiones list
      setLoadingInv(true);
      cajas.inversiones({ limit: 200 })
        .then(res => setInversiones(res.data || []))
        .catch(console.error)
        .finally(() => setLoadingInv(false));
    } catch (err) { setInvError(err.message); }
    finally { setInvCreating(false); }
  }

  // Load deudas
  useEffect(() => {
    if (tab !== 'deudas') return;
    setLoadingDeudas(true);
    cajas.deudas({ limit: 500 })
      .then(res => setDeudaMovs(res.data || []))
      .catch(console.error)
      .finally(() => setLoadingDeudas(false));
  }, [tab]);

  // Load contacto movements when selected
  useEffect(() => {
    if (!selectedContactoId) { setContactoMovs([]); return; }
    setLoadingContactoMovs(true);
    cajas.deudas({ contacto_id: selectedContactoId, limit: 200 })
      .then(res => setContactoMovs(res.data || []))
      .catch(console.error)
      .finally(() => setLoadingContactoMovs(false));
  }, [selectedContactoId]);

  // Load inversiones
  useEffect(() => {
    if (tab !== 'inversiones') return;
    setLoadingInv(true);
    cajas.inversiones({ limit: 200 })
      .then(res => setInversiones(res.data || []))
      .catch(console.error)
      .finally(() => setLoadingInv(false));
  }, [tab]);

  // Group deudas by contacto
  const contactosDeuda = useMemo(() => groupDeudas(deudaMovs), [deudaMovs]);
  const selectedContacto = useMemo(
    () => contactosDeuda.find(c => c.contacto_id === selectedContactoId),
    [contactosDeuda, selectedContactoId]
  );

  // KPIs for deudas
  const totalDeudaARS     = useMemo(() => contactosDeuda.filter(c => c.saldo_ars > 0).reduce((s, c) => s + c.saldo_ars, 0), [contactosDeuda]);
  const totalDeudaUSD     = useMemo(() => contactosDeuda.filter(c => c.saldo_usd > 0).reduce((s, c) => s + c.saldo_usd, 0), [contactosDeuda]);
  const conDeuda          = useMemo(() => contactosDeuda.filter(c => c.saldo_ars > 0 || c.saldo_usd > 0).length, [contactosDeuda]);
  const mayorSaldo        = useMemo(() => contactosDeuda.length ? Math.max(...contactosDeuda.map(c => c.saldo_ars)) : 0, [contactosDeuda]);

  // KPIs for inversiones
  const totalInvARS       = useMemo(() => inversiones.reduce((s, m) => s + (parseFloat(m.monto) || 0), 0), [inversiones]);
  const inversoresActivos = useMemo(() => new Set(inversiones.map(m => m.contacto_id)).size, [inversiones]);

  // Delete handlers
  async function handleDeleteDeuda(id) {
    const ok = await confirm({ title: 'Eliminar movimiento', message: 'Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await cajas.deleteDeuda(id);
      setContactoMovs(prev => prev.filter(m => m.id !== id));
      cajas.deudas({ limit: 500 }).then(res => setDeudaMovs(res.data || []));
      toast.success('Movimiento eliminado.');
    } catch (e) { toast.error(e.message); }
  }

  async function handleDeleteInversion(id) {
    const ok = await confirm({ title: 'Eliminar inversión', message: 'Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await cajas.deleteInversion(id);
      setInversiones(prev => prev.filter(m => m.id !== id));
      toast.success('Inversión eliminada.');
    } catch (e) { toast.error(e.message); }
  }

  // ── Config Cajas handlers ──────────────────────────────────────────────────
  async function handleCreateCaja(e) {
    e.preventDefault();
    if (!cajaForm.nombre.trim()) { setCajaError('El nombre es obligatorio.'); return; }
    setCajaSaving(true); setCajaError('');
    try {
      await cajas.createCaja({
        nombre: cajaForm.nombre.trim(), moneda: cajaForm.moneda,
        saldo_inicial: cajaForm.saldo_inicial ? Number(cajaForm.saldo_inicial) : 0,
        es_tarjeta: !!cajaForm.es_tarjeta,
        comision_pct: cajaForm.es_tarjeta && cajaForm.comision_pct !== '' ? Number(cajaForm.comision_pct) : null,
      });
      setCajaForm({ nombre: '', moneda: 'ARS', saldo_inicial: '', es_tarjeta: false, comision_pct: '' });
      toast.success('Caja creada.');
      loadCajas();
    } catch (e) { setCajaError(e.message || 'No se pudo crear la caja.'); }
    finally { setCajaSaving(false); }
  }

  async function handleToggleCaja(c) {
    try { await cajas.updateCaja(c.id, { activo: !c.activo }); loadCajas(); }
    catch (e) { toast.error(e.message); }
  }

  async function handleToggleFinanciera(c) {
    try { await cajas.updateCaja(c.id, { es_financiera: !c.es_financiera }); loadCajas(); }
    catch (e) { toast.error(e.message); }
  }

  async function handleDeleteCaja(c) {
    const ok = await confirm({ title: 'Eliminar caja', message: `¿Eliminar "${c.nombre}"? No afecta movimientos ya registrados.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await cajas.deleteCaja(c.id); toast.success('Caja eliminada.'); loadCajas(); }
    catch (e) { toast.error(e.message); }
  }

  // ── Ledger de caja ──
  async function openCajaLedger(c) {
    setCajaSel(c);
    setAjusteForm({ fecha: todayISO(), tipo: 'ingreso', monto: '', tc: '', concepto: '' });
    try { const r = await cajas.cajaMovimientos(c.id); setCajaMovs(r.data || []); }
    catch (e) { toast.error(e.message); setCajaMovs([]); }
  }
  async function handleSaldoInicial(c, valor) {
    const v = valor === '' ? 0 : Number(valor);
    if (Number(c.saldo_inicial) === v) return;
    try { await cajas.updateCaja(c.id, { saldo_inicial: v }); loadCajas(); }
    catch (e) { toast.error(e.message); }
  }
  async function handleCreateAjuste(e) {
    e.preventDefault();
    if (!ajusteForm.monto || Number(ajusteForm.monto) <= 0) { toast.error('El monto debe ser mayor a 0.'); return; }
    if (cajaSel.moneda === 'ARS' && (!ajusteForm.tc || Number(ajusteForm.tc) <= 0)) { toast.error('Para una caja en ARS ingresá el TC.'); return; }
    setAjusteSaving(true);
    try {
      await cajas.createCajaAjuste(cajaSel.id, {
        fecha: ajusteForm.fecha, tipo: ajusteForm.tipo, monto: Number(ajusteForm.monto),
        tc: cajaSel.moneda === 'ARS' ? Number(ajusteForm.tc) : null,
        concepto: ajusteForm.concepto || null,
      });
      toast.success('Ajuste registrado.');
      setAjusteForm({ fecha: todayISO(), tipo: 'ingreso', monto: '', tc: '', concepto: '' });
      { const r = await cajas.cajaMovimientos(cajaSel.id); setCajaMovs(r.data || []); }
      loadCajas();
    } catch (e) { toast.error(e.message || 'No se pudo registrar.'); }
    finally { setAjusteSaving(false); }
  }
  async function handleDeleteCajaMov(m) {
    try { await cajas.deleteCajaMov(m.id); setCajaMovs(prev => prev.filter(x => x.id !== m.id)); loadCajas(); }
    catch (e) { toast.error(e.message); }
  }

  return (
    <div>
      {/* Page head */}
      <div className="page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Cajas</h1>
          <div className="page-sub">Deudas e inversiones por contacto</div>
        </div>
        <div className="page-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="tabs">
            {[{ value: 'config', label: 'Config Cajas' }, { value: 'deudas', label: 'Deudas a cobrar' }, { value: 'inversiones', label: 'Inversiones' }, { value: 'movimientos', label: 'Historial Movimientos' }].map(t => (
              <button key={t.value} className={'tab' + (tab === t.value ? ' active' : '')}
                      onClick={() => { setTab(t.value); setSelectedContactoId(null); }}>
                {t.label}
              </button>
            ))}
          </div>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => { setCForm({ nombre: '', apellido: '', tipo: 'amigo' }); setCError(''); setShowContacto(true); }}
          >
            + Contacto
          </button>
        </div>
      </div>

      {/* ── DEUDAS TAB ─────────────────────────────────────────────────── */}
      {tab === 'deudas' && (
        <>
          {/* KPIs */}
          <div className="row" style={{ marginBottom: 20, gap: 12 }}>
            {[
              { label: 'Total deuda · ARS', value: <><span className="ccy">ARS</span><span className="mono neg">{fmt(totalDeudaARS)}</span></>, sub: `${conDeuda} contactos` },
              { label: 'Total deuda · USD', value: <><span className="ccy">USD</span><span className="mono neg">{fmt(totalDeudaUSD)}</span></>, sub: 'en divisas' },
              { label: 'Contactos con deuda', value: <span className="mono">{conDeuda}</span>, sub: `de ${contactosDeuda.length} total` },
              { label: 'Mayor saldo', value: <><span className="ccy">ARS</span><span className="mono">{fmt(mayorSaldo)}</span></>, sub: 'deuda individual más alta' },
            ].map(k => (
              <div key={k.label} className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value">{k.value}</div>
                <div className="muted tiny" style={{ marginTop: 6 }}>{k.sub}</div>
              </div>
            ))}
          </div>

          {/* Split: lista de contactos + detalle de movimientos */}
          <div style={{ display: 'grid', gridTemplateColumns: selectedContactoId ? '300px 1fr' : '1fr', gap: 16 }}>
            {/* Lista */}
            <div className="card card-flush">
              <div className="card-hd"><h3>Por contacto</h3></div>
              {loadingDeudas ? (
                <div className="empty">Cargando…</div>
              ) : contactosDeuda.length === 0 ? (
                <div className="empty">Sin movimientos</div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Contacto</th>
                      <th>Tipo</th>
                      <th className="num">Saldo ARS</th>
                      <th className="num">Saldo USD</th>
                      <th>Último</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contactosDeuda.map(c => (
                      <tr key={c.contacto_id}
                          className="tbl-row-click"
                          onClick={() => setSelectedContactoId(c.contacto_id === selectedContactoId ? null : c.contacto_id)}
                          style={{ background: c.contacto_id === selectedContactoId ? 'var(--surface-2)' : undefined }}>
                        <td style={{ fontWeight: 600 }}>{c.nombre} {c.apellido || ''}</td>
                        <td><Badge tone={TIPO_TONE[c.contacto_tipo] || 'default'}>{TIPO_LABEL[c.contacto_tipo] || c.contacto_tipo}</Badge></td>
                        <td className="num mono" style={{ color: c.saldo_ars > 0 ? 'var(--neg)' : c.saldo_ars < 0 ? 'var(--pos)' : 'var(--text-muted)', fontWeight: 600 }}>
                          {c.saldo_ars !== 0 ? fmt(c.saldo_ars) : <span className="dim">—</span>}
                        </td>
                        <td className="num mono" style={{ color: c.saldo_usd > 0 ? 'var(--neg)' : c.saldo_usd < 0 ? 'var(--pos)' : 'var(--text-muted)' }}>
                          {c.saldo_usd !== 0 ? fmt(c.saldo_usd) : <span className="dim">—</span>}
                        </td>
                        <td className="muted tiny">{fmtFecha(c.ultima)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Detalle de movimientos del contacto seleccionado */}
            {selectedContactoId && selectedContacto && (
              <div className="card card-flush">
                <div className="card-hd">
                  <div>
                    <h3>{selectedContacto.nombre} {selectedContacto.apellido || ''}</h3>
                    <div className="muted tiny" style={{ marginTop: 2 }}>
                      <Badge tone={TIPO_TONE[selectedContacto.contacto_tipo] || 'default'}>
                        {TIPO_LABEL[selectedContacto.contacto_tipo] || selectedContacto.contacto_tipo}
                      </Badge>
                      <span style={{ marginLeft: 8 }}>
                        Saldo ARS: <strong className={selectedContacto.saldo_ars > 0 ? 'neg' : 'pos'}>{fmt(selectedContacto.saldo_ars)}</strong>
                        {selectedContacto.saldo_usd !== 0 && <> · USD: <strong>{fmt(selectedContacto.saldo_usd)}</strong></>}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => {
                        setDeudaForm({ ...EMPTY_DEUDA(), contacto_id: String(selectedContactoId) });
                        setDeudaError('');
                        setShowDeuda(true);
                      }}
                    >
                      + Movimiento
                    </button>
                    <button className="icon-btn" onClick={() => setSelectedContactoId(null)}>
                      <Icons.X size={15} />
                    </button>
                  </div>
                </div>
                {loadingContactoMovs ? (
                  <div className="empty">Cargando…</div>
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Tipo</th>
                        <th className="num">Monto ARS</th>
                        <th className="num">Monto USD</th>
                        <th>Concepto</th>
                        <th style={{ width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {contactoMovs.map(m => (
                        <tr key={m.id}>
                          <td className="muted mono tiny">{fmtFecha(m.fecha)}</td>
                          <td>
                            <Status tone={m.mov_tipo === 'debe' ? 'neg' : 'pos'}>
                              {m.mov_tipo === 'debe' ? 'Debe' : 'Pago'}
                            </Status>
                          </td>
                          <td className="num mono" style={{ fontWeight: 600, color: m.mov_tipo === 'debe' ? 'var(--neg)' : 'var(--pos)' }}>
                            {parseFloat(m.monto_ars) ? fmt(m.monto_ars) : <span className="dim">—</span>}
                          </td>
                          <td className="num mono">
                            {parseFloat(m.monto_usd) ? fmt(m.monto_usd) : <span className="dim">—</span>}
                          </td>
                          <td className="muted">{m.concepto || <span className="dim">—</span>}</td>
                          <td>
                            <button className="icon-btn" onClick={() => handleDeleteDeuda(m.id)}>
                              <Icons.Trash size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {contactoMovs.length === 0 && (
                        <tr><td colSpan={6} className="empty">Sin movimientos</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── INVERSIONES TAB ────────────────────────────────────────────── */}
      {tab === 'inversiones' && (
        <>
          {/* KPIs */}
          <div className="row" style={{ marginBottom: 20, gap: 12 }}>
            {[
              { label: 'Total invertido · ARS', value: <><span className="ccy">ARS</span><span className="mono">{fmt(totalInvARS)}</span></>, sub: `${inversiones.length} movimientos` },
              { label: 'Inversores activos', value: <span className="mono">{inversoresActivos}</span>, sub: 'contactos únicos' },
              { label: 'Último ingreso', value: <span className="mono" style={{ fontSize: 16 }}>{inversiones[0] ? fmtFecha(inversiones[0].fecha) : '—'}</span>, sub: inversiones[0]?.nombre || '' },
            ].map(k => (
              <div key={k.label} className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value">{k.value}</div>
                <div className="muted tiny" style={{ marginTop: 6 }}>{k.sub}</div>
              </div>
            ))}
          </div>

          <div className="card card-flush">
            <div className="card-hd"><h3>Inversiones — {inversiones.length}</h3></div>
            {loadingInv ? (
              <div className="empty">Cargando…</div>
            ) : inversiones.length === 0 ? (
              <div className="empty">Sin inversiones registradas</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Inversor</th>
                    <th>Tipo</th>
                    <th>Tasa</th>
                    <th className="num">Monto ARS</th>
                    <th style={{ width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {inversiones.map(m => (
                    <tr key={m.id}>
                      <td className="muted mono tiny">{fmtFecha(m.fecha)}</td>
                      <td style={{ fontWeight: 600 }}>{m.nombre} {m.apellido || ''}</td>
                      <td><Badge tone={TIPO_TONE[m.contacto_tipo] || 'default'}>{TIPO_LABEL[m.contacto_tipo] || m.contacto_tipo}</Badge></td>
                      <td>
                        {m.tasa
                          ? <span className="badge badge-info" style={{ fontSize: 11 }}>{m.tasa}</span>
                          : <span className="dim">—</span>}
                      </td>
                      <td className="num mono" style={{ fontWeight: 600 }}>{fmt(m.monto)}</td>
                      <td>
                        <button className="icon-btn" onClick={() => handleDeleteInversion(m.id)}>
                          <Icons.Trash size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ── CONFIG CAJAS TAB ───────────────────────────────────────────── */}
      {tab === 'config' && (
        <>
          <div className="card card-tight" style={{ marginBottom: 16 }}>
            <div className="card-hd"><h3>Nueva caja</h3></div>
            <form onSubmit={handleCreateCaja} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', padding: '4px 2px' }}>
              <div className="field" style={{ flex: 2, minWidth: 220 }}>
                <label className="field-label">Nombre</label>
                <input className="input" placeholder="ej. USD Efectivo, Banco Galicia, Mercado Pago"
                       value={cajaForm.nombre} onChange={e => setCajaForm(f => ({ ...f, nombre: e.target.value }))} />
              </div>
              <div className="field" style={{ width: 110 }}>
                <label className="field-label">Moneda</label>
                <select className="input" value={cajaForm.moneda} onChange={e => setCajaForm(f => ({ ...f, moneda: e.target.value }))}>
                  <option value="ARS">ARS</option>
                  <option value="USD">USD</option>
                  <option value="USDT">USDT</option>
                </select>
              </div>
              <div className="field" style={{ width: 140 }}>
                <label className="field-label">Saldo inicial</label>
                <input type="number" step="0.01" className="input" placeholder="0"
                       value={cajaForm.saldo_inicial} onChange={e => setCajaForm(f => ({ ...f, saldo_inicial: e.target.value }))} />
              </div>
              <label className="field" style={{ width: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={cajaForm.es_tarjeta} onChange={e => setCajaForm(f => ({ ...f, es_tarjeta: e.target.checked, comision_pct: '' }))} style={{ accentColor: 'var(--accent)' }} />
                <span style={{ fontSize: 12 }}>Es tarjeta</span>
              </label>
              {cajaForm.es_tarjeta && (
                <div className="field" style={{ width: 120 }}>
                  <label className="field-label">% comisión</label>
                  <input type="number" min="0" max="100" step="0.1" className="input mono" placeholder="23.5"
                         value={cajaForm.comision_pct} onChange={e => setCajaForm(f => ({ ...f, comision_pct: e.target.value }))} />
                </div>
              )}
              <button className="btn btn-primary" type="submit" disabled={cajaSaving}>
                {cajaSaving ? 'Guardando…' : '+ Agregar caja'}
              </button>
            </form>
            {cajaError && <div style={{ color: 'var(--neg)', fontSize: 13, marginTop: 8 }}>{cajaError}</div>}
          </div>

          <div className="card card-flush">
            <div className="card-hd"><h3>Cajas — {cajasList.length}</h3></div>
            {loadingCajas ? (
              <div className="empty">Cargando…</div>
            ) : cajasList.length === 0 ? (
              <div className="empty">Sin cajas. Creá la primera arriba.</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Moneda</th>
                    <th className="num">Saldo inicial</th>
                    <th className="num">Saldo actual</th>
                    <th>Estado</th>
                    <th>Financiera</th>
                    <th>Tarjeta</th>
                    <th style={{ width: 80 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {cajasList.map(c => (
                    <tr key={c.id} style={{ opacity: c.activo ? 1 : 0.55 }}>
                      <td style={{ fontWeight: 600 }}>{c.nombre}</td>
                      <td><span className="ccy">{c.moneda}</span></td>
                      <td className="num">
                        <input type="number" step="0.01" defaultValue={Number(c.saldo_inicial) || 0}
                               key={`si-${c.id}-${c.saldo_inicial}`}
                               className="input num" style={{ maxWidth: 110, textAlign: 'right' }}
                               onBlur={e => handleSaldoInicial(c, e.target.value)}
                               title="Saldo de apertura — editá y salí del campo para guardar" />
                      </td>
                      <td className="num mono" style={{ fontWeight: 700 }}>
                        {Number(c.saldo_actual || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 })}
                      </td>
                      <td>
                        <button className={'badge ' + (c.activo ? 'badge-pos' : 'badge-warn')}
                                style={{ cursor: 'pointer', border: 'none' }}
                                onClick={() => handleToggleCaja(c)}
                                title="Click para activar / desactivar">
                          {c.activo ? 'Activa' : 'Inactiva'}
                        </button>
                      </td>
                      <td>
                        <button className={'badge ' + (c.es_financiera ? 'badge-accent' : '')}
                                style={{ cursor: 'pointer', border: 'none', background: c.es_financiera ? undefined : 'transparent' }}
                                onClick={() => handleToggleFinanciera(c)}
                                title="Marcar como la caja de la financiera (genera auto-comprobante al vender con ella)">
                          {c.es_financiera ? '★ Financiera' : <span className="dim">marcar</span>}
                        </button>
                      </td>
                      <td>
                        {c.es_tarjeta
                          ? <span className="badge badge-info" title="Método tarjeta — comisión de la financiera">Tarjeta · {fmt(c.comision_pct || 0)}%</span>
                          : <span className="dim">—</span>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="icon-btn" title="Movimientos / ajuste" onClick={() => openCajaLedger(c)}>
                          <Icons.Eye size={14} />
                        </button>
                        <button className="icon-btn" title="Eliminar caja" onClick={() => handleDeleteCaja(c)}>
                          <Icons.Trash size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="muted tiny" style={{ padding: '10px 14px' }}>
              Las cajas son las cuentas donde caen los pagos (Ventas, B2B, Financiera, Envíos). Las inactivas no aparecen al cargar nuevos pagos.
            </div>
          </div>
        </>
      )}

      {/* ── Modal: Ledger de caja (movimientos + ajuste) ─────────────── */}
      {cajaSel && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setCajaSel(null)}>
          <div className="modal" style={{ maxWidth: 640 }}>
            <div className="modal-hd">
              <h3>{cajaSel.nombre} <span className="ccy">{cajaSel.moneda}</span></h3>
              <button className="icon-btn" onClick={() => setCajaSel(null)}><Icons.X size={16} /></button>
            </div>
            <div className="modal-body">
              {/* Ajuste manual */}
              <form onSubmit={handleCreateAjuste} className="card card-tight" style={{ marginBottom: 14 }}>
                <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div className="field" style={{ width: 120 }}><label className="field-label">Tipo</label>
                    <select className="input" value={ajusteForm.tipo} onChange={e => setAjusteForm(f => ({ ...f, tipo: e.target.value }))}>
                      <option value="ingreso">Ingreso (+)</option>
                      <option value="egreso">Egreso (−)</option>
                    </select></div>
                  <div className="field" style={{ width: 130 }}><label className="field-label">Fecha</label>
                    <input type="date" className="input" value={ajusteForm.fecha} onChange={e => setAjusteForm(f => ({ ...f, fecha: e.target.value }))} /></div>
                  <div className="field" style={{ width: 110 }}><label className="field-label">Monto</label>
                    <input type="number" step="0.01" className="input" value={ajusteForm.monto} onChange={e => setAjusteForm(f => ({ ...f, monto: e.target.value }))} /></div>
                  {cajaSel.moneda === 'ARS' && (
                    <div className="field" style={{ width: 90 }}><label className="field-label">TC</label>
                      <input type="number" step="0.01" className="input" value={ajusteForm.tc} onChange={e => setAjusteForm(f => ({ ...f, tc: e.target.value }))} /></div>
                  )}
                  <div className="field" style={{ flex: 1, minWidth: 120 }}><label className="field-label">Concepto</label>
                    <input className="input" placeholder="ej. arqueo, retiro" value={ajusteForm.concepto} onChange={e => setAjusteForm(f => ({ ...f, concepto: e.target.value }))} /></div>
                  <button className="btn btn-primary btn-sm" type="submit" disabled={ajusteSaving}>{ajusteSaving ? '…' : 'Agregar'}</button>
                </div>
                <div className="muted tiny" style={{ marginTop: 6 }}>Ajuste manual de caja (arqueo, corrección, retiro). Los movimientos de otros módulos se reflejan automáticamente (Fase 2b).</div>
              </form>

              {/* Historial */}
              {cajaMovs.length === 0 ? (
                <div className="empty">Sin movimientos todavía.</div>
              ) : (
                <table className="tbl">
                  <thead><tr><th>Fecha</th><th>Tipo</th><th>Origen</th><th>Concepto</th><th className="num">Monto</th><th style={{ width: 32 }}></th></tr></thead>
                  <tbody>
                    {cajaMovs.map(m => (
                      <tr key={m.id}>
                        <td className="muted mono tiny">{fmtFecha(m.fecha)}</td>
                        <td><span className={'badge ' + (m.tipo === 'ingreso' ? 'badge-pos' : 'badge-warn')}>{m.tipo === 'ingreso' ? 'Ingreso' : 'Egreso'}</span></td>
                        <td className="tiny muted">{m.origen}</td>
                        <td className="tiny">{m.concepto || '—'}</td>
                        <td className="num mono" style={{ fontWeight: 600 }}>
                          <span className={m.tipo === 'ingreso' ? 'pos' : 'neg'}>{m.tipo === 'ingreso' ? '+' : '−'}{Number(m.monto).toLocaleString('es-AR', { maximumFractionDigits: 2 })}</span>
                        </td>
                        <td>{m.origen === 'ajuste' && <button className="icon-btn" onClick={() => handleDeleteCajaMov(m)}><Icons.Trash size={12} /></button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── MOVIMIENTOS TAB (ledger global) ──────────────────────────── */}
      {tab === 'movimientos' && (
        <>
          {/* Totales (USD) */}
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Ingresos · USD</div>
              <div className="kpi-value mono pos">u$s {fmt(ledgerData.totales.ingresos_usd)}</div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Egresos · USD</div>
              <div className="kpi-value mono neg">u$s {fmt(ledgerData.totales.egresos_usd)}</div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Neto · USD</div>
              <div className={'kpi-value mono ' + (Number(ledgerData.totales.neto_usd) >= 0 ? 'pos' : 'neg')}>u$s {fmt(ledgerData.totales.neto_usd)}</div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Movimientos</div>
              <div className="kpi-value mono">{ledgerData.totales.count}</div>
            </div>
          </div>

          {/* Filtros */}
          <div className="card card-tight" style={{ marginBottom: 12 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="field" style={{ marginBottom: 0, minWidth: 160 }}>
                <label className="field-label">Caja</label>
                <select className="input" value={ledgerFiltros.caja_id} onChange={e => setLF('caja_id', e.target.value)}>
                  <option value="">Todas</option>
                  {cajasList.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label">Desde</label>
                <input type="date" className="input" value={ledgerFiltros.desde} onChange={e => setLF('desde', e.target.value)} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label">Hasta</label>
                <input type="date" className="input" value={ledgerFiltros.hasta} onChange={e => setLF('hasta', e.target.value)} />
              </div>
              <div className="field" style={{ marginBottom: 0, minWidth: 140 }}>
                <label className="field-label">Origen</label>
                <select className="input" value={ledgerFiltros.origen} onChange={e => setLF('origen', e.target.value)}>
                  <option value="">Todos</option>
                  {Object.entries(ORIGEN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0, minWidth: 120 }}>
                <label className="field-label">Tipo</label>
                <select className="input" value={ledgerFiltros.tipo} onChange={e => setLF('tipo', e.target.value)}>
                  <option value="">Todos</option>
                  <option value="ingreso">Ingreso</option>
                  <option value="egreso">Egreso</option>
                </select>
              </div>
              <button className="btn btn-ghost" style={{ marginBottom: 0 }} onClick={() => setLedgerFiltros(EMPTY_LEDGER_FILTROS)}>
                Limpiar
              </button>
            </div>
          </div>

          {/* Tabla */}
          <div className="card card-flush">
            <div className="card-hd">
              <div style={{ fontWeight: 600, fontSize: 14 }}>Movimientos — {ledgerData.totales.count}</div>
              <div className="muted tiny">Totales en USD (los montos en ARS sin tipo de cambio aportan 0 al total USD)</div>
            </div>
            {loadingLedger ? (
              <div className="empty">Cargando movimientos…</div>
            ) : ledgerData.data.length === 0 ? (
              <div className="empty">Sin movimientos para los filtros elegidos.</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Fecha</th><th>Caja</th><th>Origen</th><th>Concepto</th>
                    <th style={{ textAlign: 'right' }}>Monto</th>
                    <th style={{ textAlign: 'right' }}>USD</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerData.data.map(m => {
                    const signo = m.tipo === 'ingreso' ? '+' : '−';
                    const tone = m.tipo === 'ingreso' ? 'pos' : 'neg';
                    return (
                      <tr key={m.id}>
                        <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                        <td>{m.caja_nombre} <span className="muted tiny">{m.moneda}</span></td>
                        <td><Badge tone={ORIGEN_TONE[m.origen] || 'default'}>{ORIGEN_LABEL[m.origen] || m.origen}</Badge></td>
                        <td className="muted tiny">{m.concepto || '—'}</td>
                        <td className={'mono ' + tone} style={{ textAlign: 'right', fontWeight: 700 }}>{signo}{fmt(m.monto)}</td>
                        <td className="mono tiny" style={{ textAlign: 'right' }}>{Number(m.monto_usd) > 0 ? 'u$s ' + fmt(m.monto_usd) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {/* Paginación */}
            {ledgerData.pagination.pages > 1 && (
              <div className="flex-row" style={{ justifyContent: 'center', gap: 12, padding: 12, alignItems: 'center' }}>
                <button className="btn btn-ghost btn-sm" disabled={ledgerFiltros.page <= 1}
                  onClick={() => setLF('page', ledgerFiltros.page - 1)}>Anterior</button>
                <span className="muted tiny">Página {ledgerData.pagination.page} de {ledgerData.pagination.pages}</span>
                <button className="btn btn-ghost btn-sm" disabled={ledgerFiltros.page >= ledgerData.pagination.pages}
                  onClick={() => setLF('page', ledgerFiltros.page + 1)}>Siguiente</button>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Modal: Nuevo contacto ────────────────────────────────────── */}
      {showContacto && (
        <div className="modal-overlay" onClick={() => setShowContacto(false)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Nuevo contacto</h3>
              <button className="icon-btn" onClick={() => setShowContacto(false)}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreateContacto}>
              <div className="modal-body">
                <div className="stack" style={{ gap: 14 }}>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input className="input" placeholder="ej. Martín"
                        value={cForm.nombre} onChange={e => setCForm(f => ({ ...f, nombre: e.target.value }))} autoFocus />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Apellido</label>
                      <input className="input" placeholder="ej. García"
                        value={cForm.apellido} onChange={e => setCForm(f => ({ ...f, apellido: e.target.value }))} />
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">Tipo de contacto</label>
                    <select className="input" value={cForm.tipo} onChange={e => setCForm(f => ({ ...f, tipo: e.target.value }))}>
                      <option value="amigo">Amigo</option>
                      <option value="familiar">Familiar</option>
                      <option value="cliente">Cliente</option>
                      <option value="inversor">Inversor</option>
                      <option value="ipro team">iPro Team</option>
                    </select>
                  </div>
                  {cError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{cError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowContacto(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={cCreating}>
                  {cCreating ? 'Guardando…' : 'Crear contacto'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Nuevo movimiento de deuda ────────────────────────── */}
      {showDeuda && (
        <div className="modal-overlay" onClick={() => setShowDeuda(false)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Nuevo movimiento de deuda</h3>
              <button className="icon-btn" onClick={() => setShowDeuda(false)}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreateDeuda}>
              <div className="modal-body">
                <div className="stack" style={{ gap: 14 }}>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Fecha <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input type="date" className="input"
                        value={deudaForm.fecha}
                        onChange={e => setDeudaForm(f => ({ ...f, fecha: e.target.value }))} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Tipo <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <select className="input"
                        value={deudaForm.tipo}
                        onChange={e => setDeudaForm(f => ({ ...f, tipo: e.target.value }))}>
                        <option value="debe">Debe (deuda nueva)</option>
                        <option value="pago">Pago (cancela deuda)</option>
                      </select>
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">Contacto <span style={{ color: 'var(--neg)' }}>*</span></label>
                    <select className="input"
                      value={deudaForm.contacto_id}
                      onChange={e => setDeudaForm(f => ({ ...f, contacto_id: e.target.value }))}
                      autoFocus={!deudaForm.contacto_id}>
                      <option value="">— Seleccionar —</option>
                      {allContacts.map(c => (
                        <option key={c.id} value={c.id}>
                          {c.nombre}{c.apellido ? ` ${c.apellido}` : ''} ({TIPO_LABEL[c.tipo] || c.tipo})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Monto ARS</label>
                      <input type="number" min="0" step="0.01" className="input" placeholder="0"
                        value={deudaForm.monto_ars}
                        onChange={e => setDeudaForm(f => ({ ...f, monto_ars: e.target.value }))} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Monto USD</label>
                      <input type="number" min="0" step="0.01" className="input" placeholder="0"
                        value={deudaForm.monto_usd}
                        onChange={e => setDeudaForm(f => ({ ...f, monto_usd: e.target.value }))} />
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">Concepto</label>
                    <input className="input" placeholder="ej. Préstamo viaje, Compra materiales…"
                      value={deudaForm.concepto}
                      onChange={e => setDeudaForm(f => ({ ...f, concepto: e.target.value }))} />
                  </div>
                  {deudaError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{deudaError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowDeuda(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={deudaCreating}>
                  {deudaCreating ? 'Guardando…' : 'Registrar movimiento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Nueva inversión ───────────────────────────────────── */}
      {showInv && (
        <div className="modal-overlay" onClick={() => setShowInv(false)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Nueva inversión</h3>
              <button className="icon-btn" onClick={() => setShowInv(false)}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreateInversion}>
              <div className="modal-body">
                <div className="stack" style={{ gap: 14 }}>
                  <div className="field">
                    <label className="field-label">Fecha <span style={{ color: 'var(--neg)' }}>*</span></label>
                    <input type="date" className="input"
                      value={invForm.fecha}
                      onChange={e => setInvForm(f => ({ ...f, fecha: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="field-label">Inversor <span style={{ color: 'var(--neg)' }}>*</span></label>
                    <select className="input"
                      value={invForm.contacto_id}
                      onChange={e => setInvForm(f => ({ ...f, contacto_id: e.target.value }))}
                      autoFocus>
                      <option value="">— Seleccionar —</option>
                      {allContacts.map(c => (
                        <option key={c.id} value={c.id}>
                          {c.nombre}{c.apellido ? ` ${c.apellido}` : ''} ({TIPO_LABEL[c.tipo] || c.tipo})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="field-label">Monto ARS <span style={{ color: 'var(--neg)' }}>*</span></label>
                    <input type="number" min="1" step="0.01" className="input" placeholder="ej. 500000"
                      value={invForm.monto}
                      onChange={e => setInvForm(f => ({ ...f, monto: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="field-label">Tasa / condición</label>
                    <input className="input" placeholder="ej. 5% mensual, TNA 60%…"
                      value={invForm.tasa}
                      onChange={e => setInvForm(f => ({ ...f, tasa: e.target.value }))} />
                  </div>
                  {invError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{invError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowInv(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={invCreating}>
                  {invCreating ? 'Guardando…' : 'Registrar inversión'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

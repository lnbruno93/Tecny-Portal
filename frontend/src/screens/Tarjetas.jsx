import { useState, useEffect, useMemo, useRef } from 'react';
import { Icons } from '../components/Icons';
import { tarjetas as tarjetasApi, cajas as cajasApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import CajaSelectHint from '../components/CajaSelectHint';
import useModal from '../lib/useModal';
import { rangeToParams, rangeLabel, RANGE_PRESETS } from '../lib/dateRange';



const todayISO = () => new Date().toLocaleDateString('sv');
const sym = (m) => (m === 'ARS' ? '$' : 'u$s');

export default function Tarjetas() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  const [vista, setVista] = useState('general'); // 'general' (las 3) | 'detalle' (una)
  const [list, setList] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [allMovs, setAllMovs] = useState([]);     // estado de cuenta unificado
  const [selectedId, setSelectedId] = useState(null);
  const [detalle, setDetalle] = useState(null);   // { ...metodo, resumen }
  const [movs, setMovs] = useState([]);
  const [cajas, setCajas] = useState([]);

  // Filtro de período compartido entre vista General y Detalle (afecta el
  // estado de cuenta unificado y la tabla de movs de la tarjeta seleccionada).
  // Persistido en localStorage. Default 'todo' — los KPIs por tarjeta + el
  // saldo "Te deben" se calculan SIEMPRE sobre el histórico completo (en
  // tarjetas.list y tarjetas.get), así que el operador suele querer ver el
  // ledger entero al entrar. Si quiere acotar, cambia con un click.
  const TARJ_RANGE_KEY = 'tarj_range';
  const [tarjRange, setTarjRange] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(TARJ_RANGE_KEY) || 'null');
      if (saved && saved.preset) return saved;
    } catch { /* ignore */ }
    return { preset: 'todo', desde: '', hasta: '' };
  });
  useEffect(() => {
    try { localStorage.setItem(TARJ_RANGE_KEY, JSON.stringify(tarjRange)); } catch { /* ignore */ }
  }, [tarjRange]);

  // Liquidación (cuando nos pagan)
  const [liq, setLiq] = useState({ fecha: todayISO(), monto: '', caja_id: '' });
  const [savingLiq, setSavingLiq] = useState(false);

  // Cobro previo (saldos de ventas anteriores al sistema — junio 2026)
  const EMPTY_COBRO_PREV = {
    metodo_pago_id: '', fecha: todayISO(), monto_bruto: '', pct: '', comentarios: '',
  };
  const [showCobroPrev, setShowCobroPrev] = useState(false);
  const [cobroPrev, setCobroPrev] = useState(EMPTY_COBRO_PREV);
  const [savingCobroPrev, setSavingCobroPrev] = useState(false);
  const [cobroPrevError, setCobroPrevError] = useState('');

  // Editar un movimiento existente. `editMov` guarda el row original; `editForm`
  // tiene los campos editables según el tipo. Cobros de venta NO entran acá
  // (botón oculto): se ajustan editando la venta.
  const [editMov, setEditMov] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState('');

  // Refs para useModal (a11y: Esc cierra, body scroll lock, focus inicial).
  // Antes los modales se hacían a mano sin Esc handler — auditoría TANDA 1.
  const cobroPrevModalRef = useRef(null);
  const editModalRef      = useRef(null);
  useModal({
    open: showCobroPrev,
    onClose: () => !savingCobroPrev && setShowCobroPrev(false),
    overlayRef: cobroPrevModalRef,
  });
  useModal({
    open: !!editMov,
    onClose: () => !savingEdit && setEditMov(null),
    overlayRef: editModalRef,
  });

  // KPIs por tarjeta (list) y por-tarjeta (detalle.resumen) siempre sin filtro:
  // representan el saldo real y los totales históricos. Solo el LEDGER (allMovs
  // en General, movs en Detalle) responde al filtro de período.
  function loadList() {
    setLoadingList(true);
    tarjetasApi.list().then(r => setList(r || [])).catch(e => toast.error(e.message)).finally(() => setLoadingList(false));
    tarjetasApi.movimientosAll({ ...rangeToParams(tarjRange), limit: 500 })
      .then(r => setAllMovs(r.data || [])).catch(() => {});
  }
  useEffect(() => { loadList(); }, [tarjRange]); // eslint-disable-line
  useEffect(() => { cajasApi.listCajas().then(r => setCajas(Array.isArray(r) ? r : [])).catch(() => {}); }, []);
  useEffect(() => {
    setPrimaryAction(null);
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);
  useEffect(() => { if (list.length > 0 && !selectedId) setSelectedId(list[0].id); }, [list]); // eslint-disable-line

  function loadDetalle() {
    if (!selectedId) { setDetalle(null); setMovs([]); return; }
    Promise.all([
      tarjetasApi.get(selectedId),
      tarjetasApi.movimientos(selectedId, { ...rangeToParams(tarjRange), limit: 500 }),
    ])
      .then(([det, m]) => { setDetalle(det); setMovs(m.data || []); })
      .catch(e => toast.error(e.message));
  }
  useEffect(() => { loadDetalle(); setLiq({ fecha: todayISO(), monto: '', caja_id: '' }); }, [selectedId, tarjRange]); // eslint-disable-line

  // Totales globales (de las 3 tarjetas)
  const global = useMemo(() => list.reduce((a, t) => {
    const bruto = Number(t.bruto_total || 0), com = Number(t.comision_total || 0), saldo = Number(t.saldo || 0);
    a.bruto += bruto; a.comision += com; a.saldo += saldo;
    a.liquidado += (bruto - com - saldo); // neto cobrado − pendiente = lo ya recibido
    return a;
  }, { bruto: 0, comision: 0, saldo: 0, liquidado: 0 }), [list]);

  // El estado de cuenta viene del server ya ordenado (más reciente arriba) y con el
  // saldo acumulado calculado (window sobre todo el historial), así que se usa tal cual.
  const estadoCuenta = allMovs;

  async function handleLiquidar(e) {
    e.preventDefault();
    if (!liq.caja_id) { toast.error('Elegí la caja donde entra el dinero.'); return; }
    if (!(parseFloat(liq.monto) > 0)) { toast.error('Ingresá el monto recibido.'); return; }
    setSavingLiq(true);
    try {
      await tarjetasApi.createLiquidacion({ metodo_pago_id: selectedId, fecha: liq.fecha, monto: Number(liq.monto), caja_id: Number(liq.caja_id) });
      setLiq({ fecha: liq.fecha, monto: '', caja_id: '' });
      loadList(); loadDetalle();
      toast.success('Liquidación registrada.');
    } catch (err) { toast.error(err.message); } finally { setSavingLiq(false); }
  }

  // Borrar con contexto del movimiento (fecha + tipo + monto) en el confirm.
  // Sin contexto, el usuario veía un texto genérico fuera del row y podía
  // equivocarse de operación. Acepta el row entero (no solo id).
  async function handleDeleteMov(m) {
    const tipoLabel = m.tipo === 'cobro' ? 'cobro previo' : 'liquidación';
    const monto = `${sym(m.moneda)} ${fmt(m.monto_neto)}`;
    const ok = await confirm({
      title: `Eliminar ${tipoLabel}`,
      message: `Fecha ${fmtFecha(m.fecha)} · Neto ${monto}.\n${m.tipo === 'liquidacion' ? 'Se revierte el ingreso a la caja.' : 'Se quita del saldo pendiente de la tarjeta.'}`,
      confirmLabel: 'Eliminar', danger: true,
    });
    if (!ok) return;
    try { await tarjetasApi.deleteMovimiento(m.id); loadList(); loadDetalle(); } catch (err) { toast.error(err.message); }
  }

  // Cobro previo: carga un saldo pendiente de venta anterior al sistema.
  // Al elegir la tarjeta, el % comisión se pre-carga del método (editable).
  function openCobroPrevio() {
    setCobroPrev(EMPTY_COBRO_PREV);
    setCobroPrevError('');
    setShowCobroPrev(true);
  }

  // Cuando cambia la tarjeta seleccionada, pre-cargar el % comisión del método.
  function setCobroPrevTarjeta(id) {
    const t = list.find(x => String(x.id) === String(id));
    setCobroPrev(f => ({ ...f, metodo_pago_id: id, pct: t ? String(t.comision_pct ?? '') : '' }));
  }

  // Cálculo client-side del neto para preview en el modal (el server recalcula
  // al guardar — esto es solo informativo).
  const cobroPrevCalc = useMemo(() => {
    const bruto = Number(cobroPrev.monto_bruto) || 0;
    const pct = Number(cobroPrev.pct) || 0;
    const comision = Math.round(bruto * pct) / 100;
    const neto = Math.round((bruto - comision) * 100) / 100;
    return { bruto, comision, neto };
  }, [cobroPrev.monto_bruto, cobroPrev.pct]);

  async function handleCobroPrevSave(e) {
    e?.preventDefault?.();
    setCobroPrevError('');
    if (!cobroPrev.metodo_pago_id) { setCobroPrevError('Elegí la tarjeta.'); return; }
    if (!(Number(cobroPrev.monto_bruto) > 0)) { setCobroPrevError('El bruto debe ser mayor a 0.'); return; }
    setSavingCobroPrev(true);
    try {
      await tarjetasApi.createCobroInicial({
        metodo_pago_id: Number(cobroPrev.metodo_pago_id),
        fecha:          cobroPrev.fecha,
        monto_bruto:    Number(cobroPrev.monto_bruto),
        pct:            cobroPrev.pct === '' ? undefined : Number(cobroPrev.pct),
        comentarios:    cobroPrev.comentarios.trim() || null,
      });
      setShowCobroPrev(false);
      loadList();
      if (selectedId === Number(cobroPrev.metodo_pago_id)) loadDetalle();
      toast.success('Cobro previo registrado.');
    } catch (err) {
      setCobroPrevError(err.message || 'No se pudo registrar el cobro previo.');
    } finally {
      setSavingCobroPrev(false);
    }
  }

  // ── Edición de movimientos ──
  // Cobros de venta (venta_id != null) NO se editan acá. El botón se oculta.
  const canEdit = (m) => !(m.tipo === 'cobro' && m.venta_id != null);

  function openEdit(m) {
    setEditError('');
    // metodo_nombre solo viene en la vista General (all-movs). Para la vista
    // Detalle, fallback al nombre de la tarjeta seleccionada.
    setEditMov({ ...m, metodo_nombre: m.metodo_nombre || detalle?.nombre || '' });
    if (m.tipo === 'cobro') {
      // Cobro previo (venta_id IS NULL): editar bruto + pct + fecha + comentarios.
      setEditForm({
        fecha:       (m.fecha || '').slice(0, 10),
        monto_bruto: String(m.monto_bruto ?? ''),
        pct:         String(m.pct ?? ''),
        comentarios: m.comentarios || '',
      });
    } else {
      // Liquidación: editar monto (neto recibido) + caja + fecha + comentarios.
      setEditForm({
        fecha:       (m.fecha || '').slice(0, 10),
        monto:       String(m.monto_neto ?? ''),
        caja_id:     String(m.caja_id ?? ''),
        comentarios: m.comentarios || '',
      });
    }
  }

  // Preview client-side del recálculo en cobros previos (igual que en alta).
  const editCobroCalc = useMemo(() => {
    if (!editMov || editMov.tipo !== 'cobro') return { bruto: 0, comision: 0, neto: 0 };
    const bruto = Number(editForm.monto_bruto) || 0;
    const pct = Number(editForm.pct) || 0;
    const comision = Math.round(bruto * pct) / 100;
    const neto = Math.round((bruto - comision) * 100) / 100;
    return { bruto, comision, neto };
  }, [editMov, editForm.monto_bruto, editForm.pct]);

  async function handleEditSave(e) {
    e?.preventDefault?.();
    if (!editMov) return;
    setEditError('');
    let payload;
    if (editMov.tipo === 'cobro') {
      if (!(Number(editForm.monto_bruto) > 0)) { setEditError('El bruto debe ser mayor a 0.'); return; }
      payload = {
        fecha:       editForm.fecha,
        monto_bruto: Number(editForm.monto_bruto),
        pct:         editForm.pct === '' ? null : Number(editForm.pct),
        comentarios: (editForm.comentarios || '').trim() || null,
      };
    } else {
      if (!(Number(editForm.monto) > 0)) { setEditError('El monto debe ser mayor a 0.'); return; }
      if (!editForm.caja_id) { setEditError('Elegí la caja donde entra.'); return; }
      payload = {
        fecha:       editForm.fecha,
        monto:       Number(editForm.monto),
        caja_id:     Number(editForm.caja_id),
        comentarios: (editForm.comentarios || '').trim() || null,
      };
    }
    setSavingEdit(true);
    try {
      await tarjetasApi.updateMovimiento(editMov.id, payload);
      setEditMov(null);
      loadList(); loadDetalle();
      toast.success('Movimiento actualizado.');
    } catch (err) {
      setEditError(err.message || 'No se pudo actualizar.');
    } finally {
      setSavingEdit(false);
    }
  }

  const r = detalle?.resumen || {};
  const mon = detalle?.moneda || 'ARS';
  const sinTarjetas = !loadingList && list.length === 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Tarjetas de Crédito</h1>
          <div className="page-sub">Se carga solo desde Ventas · comisión de la financiera, neto que te deben y liquidaciones</div>
        </div>
        {!sinTarjetas && (
          <div className="page-actions">
            {/* Cobro previo: carga saldos pendientes de ventas anteriores al
                sistema. Útil al arrancar — sin obligar a re-cargar ventas
                históricas para tener el saldo correcto en cada tarjeta. */}
            <button className="btn btn-sm" onClick={openCobroPrevio}>
              <Icons.Plus size={13} /> Cobro previo
            </button>
            <div className="tabs">
              <button className={'tab' + (vista === 'general' ? ' active' : '')} onClick={() => setVista('general')}>General</button>
              <button className={'tab' + (vista === 'detalle' ? ' active' : '')} onClick={() => setVista('detalle')}>Detalle</button>
            </div>
          </div>
        )}
      </div>

      {/* Filtro de período compartido por las vistas General y Detalle.
          Solo afecta el ledger (Estado de cuenta / Movimientos) — los KPIs
          de saldo, comisión y "Te deben" siempre reflejan el histórico
          completo (se calculan en GET /tarjetas y /tarjetas/:id sin filtro). */}
      {!sinTarjetas && (
        <div className="card card-tight" style={{ marginBottom: 14 }}>
          <div className="flex-row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="muted tiny" style={{ marginRight: 4 }}>Período (ledger):</span>
            {RANGE_PRESETS.map(p => (
              <button key={p.v}
                      className={'btn btn-sm ' + (tarjRange.preset === p.v ? 'btn-primary' : 'btn-ghost')}
                      onClick={() => setTarjRange(r => ({ ...r, preset: p.v }))}>
                {p.l}
              </button>
            ))}
            {tarjRange.preset === 'custom' && (
              <>
                <input type="date" className="input" style={{ width: 140, marginLeft: 6 }}
                       value={tarjRange.desde}
                       onChange={e => setTarjRange(r => ({ ...r, desde: e.target.value }))} />
                <span className="muted tiny">a</span>
                <input type="date" className="input" style={{ width: 140 }}
                       value={tarjRange.hasta}
                       onChange={e => setTarjRange(r => ({ ...r, hasta: e.target.value }))} />
              </>
            )}
          </div>
        </div>
      )}

      {sinTarjetas ? (
        <div className="card" style={{ padding: 24 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Todavía no hay tarjetas configuradas</div>
          <div className="muted" style={{ fontSize: 13 }}>
            Creá los métodos de pago tarjeta en <b>Cajas → Config Cajas</b> (tildá "Es tarjeta" y poné su % de comisión).
            Después, cada venta cobrada con ellos impacta acá automáticamente.
          </div>
        </div>
      ) : vista === 'general' ? (
        <>
          {/* KPIs globales */}
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Saldo a tu favor</div>
              <div className="kpi-value mono" style={{ color: 'var(--accent)' }}>$ {fmt(global.saldo)}</div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Comisión financiera</div>
              <div className="kpi-value mono" style={{ color: 'var(--neg)' }}>$ {fmt(global.comision)}</div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Ya recibido (liquidado)</div>
              <div className="kpi-value mono">$ {fmt(global.liquidado)}</div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Cobrado bruto</div>
              <div className="kpi-value mono">$ {fmt(global.bruto)}</div>
            </div>
          </div>

          {/* Resumen por tarjeta */}
          <div className="card card-flush" style={{ marginBottom: 14 }}>
            <div className="card-hd"><div style={{ fontWeight: 600, fontSize: 14 }}>Por tarjeta</div></div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Tarjeta</th><th style={{ textAlign: 'right' }}>Comisión</th>
                  <th style={{ textAlign: 'right' }}>Cobrado bruto</th><th style={{ textAlign: 'right' }}>Comisión $</th><th style={{ textAlign: 'right' }}>Te deben</th>
                </tr>
              </thead>
              <tbody>
                {list.map(t => (
                  <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => { setSelectedId(t.id); setVista('detalle'); }}>
                    <td style={{ fontWeight: 600 }}>{t.nombre}</td>
                    <td className="mono tiny" style={{ textAlign: 'right' }}>{Number(t.comision_pct || 0)}%</td>
                    <td className="mono" style={{ textAlign: 'right' }}>$ {fmt(t.bruto_total)}</td>
                    <td className="mono" style={{ textAlign: 'right', color: 'var(--neg)' }}>$ {fmt(t.comision_total)}</td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--accent)' }}>$ {fmt(t.saldo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Estado de cuenta unificado */}
          <div className="card card-flush">
            <div className="card-hd">
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                Estado de cuenta
                <span className="muted tiny" style={{ marginLeft: 8, fontWeight: 400 }}>· {rangeLabel(tarjRange)} ({estadoCuenta.length})</span>
              </div>
            </div>
            <div style={{ overflow: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Fecha</th><th>Tarjeta</th><th>Tipo</th>
                    {/* Bruto: para que el operador pueda chequear cupón por cupón
                        contra el resumen físico de la financiera. El neto solo no
                        alcanza porque la financiera factura sobre el bruto. */}
                    <th style={{ textAlign: 'right' }}>Bruto</th>
                    <th style={{ textAlign: 'right' }}>Neto</th>
                    <th style={{ textAlign: 'right' }}>Saldo acum.</th>
                    <th>Origen</th>
                    {/* Acciones: editar + eliminar. Solo para cobros previos y liquidaciones —
                        los cobros de venta (venta_id != null) NO se tocan acá. */}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {estadoCuenta.length === 0 && <tr><td colSpan={8} className="empty">Sin movimientos todavía.</td></tr>}
                  {estadoCuenta.map(m => (
                    <tr key={m.id}>
                      <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                      <td className="tiny">{m.metodo_nombre}</td>
                      <td><span className={'badge ' + (m.tipo === 'cobro' ? '' : 'badge-info')}>{m.tipo === 'cobro' ? 'Cobro' : 'Liquidación'}</span></td>
                      {/* Bruto: solo tiene sentido en cobros (en liquidaciones bruto=neto y se entiende como neto recibido). */}
                      <td className="mono tiny" style={{ textAlign: 'right' }}>
                        {m.tipo === 'cobro' ? `${sym(m.moneda)} ${fmt(m.monto_bruto)}` : '—'}
                      </td>
                      <td className="mono" style={{ textAlign: 'right', color: m.tipo === 'cobro' ? 'var(--accent)' : 'var(--neg)' }}>
                        {m.tipo === 'cobro' ? '+' : '−'} {sym(m.moneda)} {fmt(m.monto_neto)}
                      </td>
                      <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>$ {fmt(m.saldo_acum)}</td>
                      <td className="tiny">{m.venta_order_id ? `Venta ${m.venta_order_id}` : (m.caja_nombre || '—')}</td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        {canEdit(m) ? (
                          <>
                            <button className="icon-btn" title="Editar" aria-label="Editar movimiento" onClick={() => openEdit(m)}>
                              <Icons.Edit size={13} />
                            </button>
                            <button className="icon-btn" title="Eliminar" aria-label="Eliminar movimiento" style={{ color: 'var(--neg)' }} onClick={() => handleDeleteMov(m)}>
                              <Icons.Trash size={13} />
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>
          {/* Lista de tarjetas (métodos de pago) */}
          <div className="card card-flush" style={{ maxHeight: '78vh', overflow: 'auto' }}>
            {list.map((t, i) => (
              <div key={t.id} onClick={() => setSelectedId(t.id)} style={{
                padding: '10px 13px', cursor: 'pointer',
                borderBottom: i < list.length - 1 ? '1px solid var(--hairline)' : 0,
                background: selectedId === t.id ? 'var(--surface-2)' : 'transparent',
                borderLeft: selectedId === t.id ? '3px solid var(--accent)' : '3px solid transparent',
              }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{t.nombre}</div>
                <div className="muted tiny" style={{ marginTop: 2 }}>Comisión {Number(t.comision_pct || 0)}%</div>
                <div className="mono tiny" style={{ marginTop: 2, color: Number(t.saldo) > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                  Te deben: {sym(t.moneda)} {fmt(t.saldo)}
                </div>
              </div>
            ))}
          </div>

          {/* Detalle */}
          {!detalle ? (
            <div className="card" style={{ minHeight: 200, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Elegí una tarjeta</div>
          ) : (
            <div className="stack" style={{ gap: 14 }}>
              <div className="card">
                <div style={{ fontWeight: 700, fontSize: 18 }}>{detalle.nombre}</div>
                <div className="muted tiny" style={{ marginTop: 4 }}>Comisión de la financiera: {Number(detalle.comision_pct || 0)}%</div>
              </div>

              <div className="row">
                <div className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">Te deben (falta cobrar)</div>
                  <div className="kpi-value mono" style={{ color: 'var(--accent)' }}>{sym(mon)} {fmt(r.saldo)}</div>
                </div>
                <div className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">Comisión financiera</div>
                  <div className="kpi-value mono" style={{ color: 'var(--neg)' }}>{sym(mon)} {fmt(r.comision_total)}</div>
                </div>
                <div className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">Cobrado (bruto)</div>
                  <div className="kpi-value mono">{sym(mon)} {fmt(r.bruto_total)}</div>
                </div>
                <div className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">Movimientos</div>
                  <div className="kpi-value mono">{r.movimientos || 0}</div>
                </div>
              </div>

              {/* Registrar liquidación (cuando nos pagan) */}
              <div className="card">
                <div className="card-hd"><div style={{ fontWeight: 600, fontSize: 14 }}>Registrar liquidación (te pagaron)</div></div>
                <form onSubmit={handleLiquidar} className="flex-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div className="field" style={{ width: 150 }}><label className="field-label tiny">Fecha</label><input type="date" className="input" value={liq.fecha} onChange={e => setLiq(f => ({ ...f, fecha: e.target.value }))} /></div>
                  <div className="field" style={{ width: 150 }}><label className="field-label tiny">Monto recibido</label><input type="number" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" placeholder="0" value={liq.monto} onChange={e => setLiq(f => ({ ...f, monto: e.target.value }))} /></div>
                  <div className="field" style={{ flex: 1, minWidth: 160 }}><label className="field-label tiny">Entra a la caja</label>
                    <select className="input" value={liq.caja_id} onChange={e => setLiq(f => ({ ...f, caja_id: e.target.value }))}>
                      <option value="">Elegí la caja…</option>
                      {cajas.filter(c => !c.es_tarjeta).map(c => <option key={c.id} value={c.id}>{c.nombre}{c.moneda ? ' · ' + c.moneda : ''}</option>)}
                      <CajaSelectHint />
                    </select>
                  </div>
                  <button className="btn btn-primary btn-sm" disabled={savingLiq} type="submit">{savingLiq ? '…' : 'Registrar'}</button>
                </form>
              </div>

              {/* Movimientos */}
              <div className="card card-flush">
                <div style={{ overflow: 'auto' }}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Fecha</th><th>Tipo</th><th style={{ textAlign: 'right' }}>Bruto</th><th style={{ textAlign: 'right' }}>Comisión</th>
                        <th style={{ textAlign: 'right' }}>Neto</th><th>Origen</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {movs.length === 0 && <tr><td colSpan={7} className="empty">Sin movimientos. Cobrá una venta con esta tarjeta.</td></tr>}
                      {movs.map(m => (
                        <tr key={m.id}>
                          <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                          <td><span className={'badge ' + (m.tipo === 'cobro' ? '' : 'badge-info')}>{m.tipo === 'cobro' ? 'Cobro' : 'Liquidación'}</span></td>
                          {/* Bruto: solo tiene sentido en cobros (en liquidaciones bruto=neto y es ruido).
                              Mismo criterio que la vista General de Estado de cuenta — antes esta
                              tabla mostraba el monto para liquidaciones también, inconsistente. */}
                          <td className="mono" style={{ textAlign: 'right' }}>
                            {m.tipo === 'cobro' ? `${sym(m.moneda)} ${fmt(m.monto_bruto)}` : '—'}
                          </td>
                          <td className="mono tiny" style={{ textAlign: 'right', color: 'var(--neg)' }}>{Number(m.monto_comision) > 0 ? sym(m.moneda) + ' ' + fmt(m.monto_comision) : '—'}</td>
                          <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{sym(m.moneda)} {fmt(m.monto_neto)}</td>
                          <td className="tiny">{m.venta_order_id ? `Venta ${m.venta_order_id}` : (m.caja_nombre || '—')}</td>
                          <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                            {canEdit(m) ? (
                              <>
                                <button className="icon-btn" title="Editar" aria-label="Editar movimiento" onClick={() => openEdit(m)}>
                                  <Icons.Edit size={13} />
                                </button>
                                <button className="icon-btn" title="Eliminar" aria-label="Eliminar movimiento" style={{ color: 'var(--neg)' }} onClick={() => handleDeleteMov(m)}>
                                  <Icons.Trash size={13} />
                                </button>
                              </>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Modal: Cobro previo (saldos de ventas anteriores al sistema) ── */}
      {showCobroPrev && (
        <div ref={cobroPrevModalRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cobro-prev-title"
             onClick={(e) => { if (e.target === e.currentTarget && !savingCobroPrev) setShowCobroPrev(false); }}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3 id="cobro-prev-title">Registrar cobro previo</h3>
              <button className="icon-btn" aria-label="Cerrar modal" onClick={() => setShowCobroPrev(false)} disabled={savingCobroPrev}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleCobroPrevSave}>
              <div className="modal-body">
                <fieldset disabled={savingCobroPrev} style={{ border: 0, padding: 0, margin: 0 }}>
                <div className="muted tiny" style={{ marginBottom: 14, lineHeight: 1.5 }}>
                  Para saldos pendientes de ventas anteriores al sistema. NO genera
                  una venta — solo agrega saldo a cobrar de la financiera. Una
                  liquidación futura lo cancela igual que cualquier otro cobro.
                </div>
                <div className="stack" style={{ gap: 12 }}>
                  <div className="field">
                    <label className="field-label">Tarjeta <span style={{ color: 'var(--neg)' }}>*</span></label>
                    <select className="input" value={cobroPrev.metodo_pago_id}
                            onChange={e => setCobroPrevTarjeta(e.target.value)} autoFocus>
                      <option value="">— Seleccionar —</option>
                      {list.map(t => (
                        <option key={t.id} value={t.id}>
                          {t.nombre} ({t.moneda} · {Number(t.comision_pct).toFixed(1)}% comisión)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Fecha del cobro</label>
                      <input type="date" className="input" value={cobroPrev.fecha}
                             onChange={e => setCobroPrev(f => ({ ...f, fecha: e.target.value }))} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Monto bruto <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                             className="input mono" placeholder="0"
                             value={cobroPrev.monto_bruto}
                             onChange={e => setCobroPrev(f => ({ ...f, monto_bruto: e.target.value }))} />
                    </div>
                    <div className="field" style={{ width: 100 }}>
                      <label className="field-label">% comisión</label>
                      <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" max="100" step="0.01"
                             className="input mono" placeholder="0"
                             value={cobroPrev.pct}
                             onChange={e => setCobroPrev(f => ({ ...f, pct: e.target.value }))} />
                    </div>
                  </div>
                  {/* Preview client-side del cálculo (el server recalcula al guardar). */}
                  {Number(cobroPrev.monto_bruto) > 0 && (
                    <div style={{
                      padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 6,
                      fontSize: 13, lineHeight: 1.6,
                    }}>
                      <div className="flex-between"><span className="muted">Bruto:</span><span className="mono">{fmt(cobroPrevCalc.bruto)}</span></div>
                      <div className="flex-between"><span className="muted">Comisión ({cobroPrev.pct || 0}%):</span><span className="mono" style={{ color: 'var(--neg)' }}>− {fmt(cobroPrevCalc.comision)}</span></div>
                      <div className="flex-between" style={{ paddingTop: 4, borderTop: '1px solid var(--hairline)', marginTop: 4 }}>
                        <strong>Neto a cobrar:</strong>
                        <span className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>{fmt(cobroPrevCalc.neto)}</span>
                      </div>
                    </div>
                  )}
                  <div className="field">
                    <label className="field-label">Comentarios</label>
                    <input className="input" placeholder="ej. Ventas de mayo 2026, previas al sistema"
                           value={cobroPrev.comentarios}
                           onChange={e => setCobroPrev(f => ({ ...f, comentarios: e.target.value }))} />
                  </div>
                  {cobroPrevError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{cobroPrevError}</div>}
                </div>
                </fieldset>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowCobroPrev(false)} disabled={savingCobroPrev}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingCobroPrev}>
                  {savingCobroPrev ? 'Guardando…' : 'Registrar cobro'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Editar movimiento (cobro previo o liquidación) ── */}
      {editMov && (
        <div ref={editModalRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="edit-mov-title"
             onClick={(e) => { if (e.target === e.currentTarget && !savingEdit) setEditMov(null); }}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3 id="edit-mov-title">Editar {editMov.tipo === 'cobro' ? 'cobro previo' : 'liquidación'}</h3>
              <button className="icon-btn" aria-label="Cerrar modal" onClick={() => setEditMov(null)} disabled={savingEdit}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleEditSave}>
              <div className="modal-body">
                {/* fieldset[disabled] propaga a todos los inputs/selects internos:
                    durante el save no se puede seguir tipeando (evita race con
                    el toast de éxito + cierre que pisaba cambios). */}
                <fieldset disabled={savingEdit} style={{ border: 0, padding: 0, margin: 0 }}>
                <div className="muted tiny" style={{ marginBottom: 14, lineHeight: 1.5 }}>
                  Tarjeta: <b>{editMov.metodo_nombre}</b>
                  {editMov.tipo === 'liquidacion' && (
                    <> · Si cambiás caja o monto, se revierte el ingreso anterior y se postea el nuevo.</>
                  )}
                </div>
                <div className="stack" style={{ gap: 12 }}>
                  {editMov.tipo === 'cobro' ? (
                    <>
                      <div className="row" style={{ gap: 8 }}>
                        <div className="field" style={{ flex: 1 }}>
                          <label className="field-label">Fecha</label>
                          <input type="date" className="input" value={editForm.fecha || ''}
                                 onChange={e => setEditForm(f => ({ ...f, fecha: e.target.value }))} />
                        </div>
                        <div className="field" style={{ flex: 1 }}>
                          <label className="field-label">Monto bruto <span style={{ color: 'var(--neg)' }}>*</span></label>
                          <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                                 className="input mono" value={editForm.monto_bruto || ''}
                                 onChange={e => setEditForm(f => ({ ...f, monto_bruto: e.target.value }))} />
                        </div>
                        <div className="field" style={{ width: 100 }}>
                          <label className="field-label">% comisión</label>
                          <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" max="100" step="0.01"
                                 className="input mono" value={editForm.pct || ''}
                                 onChange={e => setEditForm(f => ({ ...f, pct: e.target.value }))} />
                        </div>
                      </div>
                      {Number(editForm.monto_bruto) > 0 && (
                        <div style={{
                          padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 6,
                          fontSize: 13, lineHeight: 1.6,
                        }}>
                          <div className="flex-between"><span className="muted">Bruto:</span><span className="mono">{fmt(editCobroCalc.bruto)}</span></div>
                          <div className="flex-between"><span className="muted">Comisión ({editForm.pct || 0}%):</span><span className="mono" style={{ color: 'var(--neg)' }}>− {fmt(editCobroCalc.comision)}</span></div>
                          <div className="flex-between" style={{ paddingTop: 4, borderTop: '1px solid var(--hairline)', marginTop: 4 }}>
                            <strong>Neto a cobrar:</strong>
                            <span className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>{fmt(editCobroCalc.neto)}</span>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="row" style={{ gap: 8 }}>
                      <div className="field" style={{ width: 150 }}>
                        <label className="field-label">Fecha</label>
                        <input type="date" className="input" value={editForm.fecha || ''}
                               onChange={e => setEditForm(f => ({ ...f, fecha: e.target.value }))} />
                      </div>
                      <div className="field" style={{ width: 150 }}>
                        <label className="field-label">Monto recibido <span style={{ color: 'var(--neg)' }}>*</span></label>
                        <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                               className="input mono" value={editForm.monto || ''}
                               onChange={e => setEditForm(f => ({ ...f, monto: e.target.value }))} />
                      </div>
                      <div className="field" style={{ flex: 1, minWidth: 160 }}>
                        <label className="field-label">Entra a la caja</label>
                        <select className="input" value={editForm.caja_id || ''}
                                onChange={e => setEditForm(f => ({ ...f, caja_id: e.target.value }))}>
                          <option value="">Elegí la caja…</option>
                          {cajas.filter(c => !c.es_tarjeta).map(c => (
                            <option key={c.id} value={c.id}>{c.nombre}{c.moneda ? ' · ' + c.moneda : ''}</option>
                          ))}
                          <CajaSelectHint />
                        </select>
                      </div>
                    </div>
                  )}
                  <div className="field">
                    <label className="field-label">Comentarios</label>
                    <input className="input" value={editForm.comentarios || ''}
                           onChange={e => setEditForm(f => ({ ...f, comentarios: e.target.value }))} />
                  </div>
                  {editError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{editError}</div>}
                </div>
                </fieldset>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setEditMov(null)} disabled={savingEdit}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingEdit}>
                  {savingEdit ? 'Guardando…' : 'Guardar cambios'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

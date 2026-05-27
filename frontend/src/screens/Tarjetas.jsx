import { useState, useEffect, useMemo } from 'react';
import { Icons } from '../components/Icons';
import { tarjetas as tarjetasApi, cajas as cajasApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';

const todayISO = () => new Date().toLocaleDateString('sv');
const EMPTY_MOV = { tipo: 'cobro', fecha: todayISO(), plan_id: '', moneda: 'ARS', monto_bruto: '', monto: '', caja_id: '', comentarios: '' };

export default function Tarjetas() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  const [list, setList] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [detalle, setDetalle] = useState(null);   // { ...entidad, planes, resumen }
  const [movs, setMovs] = useState([]);
  const [cajas, setCajas] = useState([]);

  const [showCreate, setShowCreate] = useState(false);
  const [nombre, setNombre] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const [plan, setPlan] = useState({ nombre: '', pct: '' });
  const [mov, setMov] = useState(EMPTY_MOV);
  const [savingMov, setSavingMov] = useState(false);

  function loadList() {
    setLoadingList(true);
    tarjetasApi.entidades().then(r => setList(r || [])).catch(e => toast.error(e.message)).finally(() => setLoadingList(false));
  }
  useEffect(() => { loadList(); }, []); // eslint-disable-line
  useEffect(() => { cajasApi.listCajas().then(r => setCajas(Array.isArray(r) ? r : [])).catch(() => {}); }, []);

  useEffect(() => {
    setPrimaryAction({ label: 'Nueva tarjeta', onClick: () => { setNombre(''); setCreateError(''); setShowCreate(true); } });
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);

  useEffect(() => { if (list.length > 0 && !selectedId) setSelectedId(list[0].id); }, [list]); // eslint-disable-line

  function loadDetalle() {
    if (!selectedId) { setDetalle(null); setMovs([]); return; }
    Promise.all([tarjetasApi.entidad(selectedId), tarjetasApi.movimientos(selectedId)])
      .then(([det, m]) => { setDetalle(det); setMovs(m || []); })
      .catch(e => toast.error(e.message));
  }
  useEffect(() => { loadDetalle(); setMov(EMPTY_MOV); }, [selectedId]); // eslint-disable-line

  const planSel = useMemo(() => (detalle?.planes || []).find(p => String(p.id) === String(mov.plan_id)), [detalle, mov.plan_id]);
  const cobroPreview = useMemo(() => {
    const bruto = parseFloat(mov.monto_bruto) || 0;
    const pct = planSel ? Number(planSel.pct) : 0;
    const comision = Math.round(bruto * pct / 100 * 100) / 100;
    return { comision, neto: Math.round((bruto - comision) * 100) / 100, pct };
  }, [mov.monto_bruto, planSel]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!nombre.trim()) { setCreateError('El nombre es obligatorio.'); return; }
    setCreating(true); setCreateError('');
    try {
      const nueva = await tarjetasApi.createEntidad({ nombre: nombre.trim() });
      setList(prev => [...prev, nueva]); setSelectedId(nueva.id); setShowCreate(false);
      toast.success('Tarjeta creada.');
    } catch (err) { setCreateError(err.message); } finally { setCreating(false); }
  }

  async function handleAddPlan() {
    if (!plan.nombre.trim()) return;
    try {
      await tarjetasApi.createPlan({ entidad_id: selectedId, nombre: plan.nombre.trim(), pct: Number(plan.pct) || 0 });
      setPlan({ nombre: '', pct: '' }); loadDetalle();
    } catch (err) { toast.error(err.message); }
  }
  async function handleDeletePlan(id) {
    try { await tarjetasApi.deletePlan(id); loadDetalle(); } catch (err) { toast.error(err.message); }
  }

  async function handleAddMov(e) {
    e.preventDefault();
    setSavingMov(true);
    try {
      if (mov.tipo === 'cobro') {
        if (!(parseFloat(mov.monto_bruto) > 0)) { toast.error('Ingresá el monto bruto.'); setSavingMov(false); return; }
        await tarjetasApi.createCobro({
          entidad_id: selectedId, fecha: mov.fecha, plan_id: mov.plan_id ? Number(mov.plan_id) : null,
          moneda: mov.moneda, monto_bruto: Number(mov.monto_bruto), comentarios: mov.comentarios.trim() || null,
        });
      } else {
        if (!mov.caja_id) { toast.error('Elegí la caja.'); setSavingMov(false); return; }
        if (!(parseFloat(mov.monto) > 0)) { toast.error('Ingresá el monto.'); setSavingMov(false); return; }
        await tarjetasApi.createLiquidacion({
          entidad_id: selectedId, fecha: mov.fecha, monto: Number(mov.monto),
          caja_id: Number(mov.caja_id), comentarios: mov.comentarios.trim() || null,
        });
      }
      setMov({ ...EMPTY_MOV, tipo: mov.tipo, fecha: mov.fecha });
      loadList(); loadDetalle();
      toast.success('Movimiento registrado.');
    } catch (err) { toast.error(err.message); } finally { setSavingMov(false); }
  }

  async function handleDeleteMov(id) {
    const ok = await confirm({ title: 'Eliminar movimiento', message: 'Si era una liquidación, se revierte la caja.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await tarjetasApi.deleteMovimiento(id); loadList(); loadDetalle(); } catch (err) { toast.error(err.message); }
  }

  async function handleDeleteEntidad() {
    if (!detalle) return;
    const ok = await confirm({ title: 'Eliminar tarjeta', message: `Se eliminará "${detalle.nombre}", sus planes y movimientos.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await tarjetasApi.deleteEntidad(detalle.id);
      setList(prev => prev.filter(e => e.id !== detalle.id)); setSelectedId(null); setDetalle(null);
      toast.success('Tarjeta eliminada.');
    } catch (err) { toast.error(err.message); }
  }

  const r = detalle?.resumen || {};

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">Tarjetas de Crédito</div>
          <div className="page-sub">Cobros con tarjeta, comisiones por plan y liquidaciones · lo que te falta cobrar</div>
        </div>
      </div>

      <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>
        {/* Lista de tarjetas */}
        <div className="card card-flush" style={{ maxHeight: '78vh', overflow: 'auto' }}>
          {loadingList ? <div className="empty">Cargando…</div>
            : list.length === 0 ? <div className="empty">Sin tarjetas. Creá la primera con "Nueva tarjeta".</div>
            : list.map((e, i) => (
              <div key={e.id} onClick={() => setSelectedId(e.id)} style={{
                padding: '10px 13px', cursor: 'pointer',
                borderBottom: i < list.length - 1 ? '1px solid var(--hairline)' : 0,
                background: selectedId === e.id ? 'var(--surface-2)' : 'transparent',
                borderLeft: selectedId === e.id ? '3px solid var(--accent)' : '3px solid transparent',
              }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{e.nombre}{!e.activo && <span className="muted tiny"> (inactiva)</span>}</div>
                <div className="mono tiny" style={{ marginTop: 2, color: 'var(--accent)' }}>
                  Falta cobrar: {Number(e.saldo_ars) > 0 && <span>$ {fmt(e.saldo_ars)} </span>}{Number(e.saldo_usd) > 0 && <span>u$s {fmt(e.saldo_usd)}</span>}
                  {Number(e.saldo_ars) <= 0 && Number(e.saldo_usd) <= 0 && '—'}
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
              <div className="flex-between" style={{ alignItems: 'flex-start' }}>
                <div style={{ fontWeight: 700, fontSize: 18 }}>{detalle.nombre}</div>
                <button className="icon-btn" title="Eliminar tarjeta" style={{ color: 'var(--neg)' }} onClick={handleDeleteEntidad}><Icons.Trash size={15} /></button>
              </div>
            </div>

            <div className="row">
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Falta cobrar · $</div>
                <div className="kpi-value mono" style={{ color: 'var(--accent)' }}>$ {fmt(r.saldo_ars)}</div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Falta cobrar · USD</div>
                <div className="kpi-value mono" style={{ color: 'var(--accent)' }}>u$s {fmt(r.saldo_usd)}</div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Comisión acumulada</div>
                <div className="kpi-value mono" style={{ color: 'var(--neg)' }}>{fmt(r.comision_total)}</div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Movimientos</div>
                <div className="kpi-value mono">{r.movimientos || 0}</div>
              </div>
            </div>

            {/* Planes / comisiones */}
            <div className="card">
              <div className="card-hd"><div style={{ fontWeight: 600, fontSize: 14 }}>Planes y comisiones</div></div>
              <div className="flex-row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {(detalle.planes || []).map(p => (
                  <span key={p.id} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {p.nombre} · {fmt(p.pct)}%
                    <button className="icon-btn" style={{ color: 'var(--neg)', padding: 0 }} onClick={() => handleDeletePlan(p.id)}><Icons.X size={11} /></button>
                  </span>
                ))}
                {(detalle.planes || []).length === 0 && <span className="muted tiny">Sin planes. Agregá uno (ej. "3 cuotas", 8%).</span>}
              </div>
              <div className="flex-row" style={{ gap: 6 }}>
                <input className="input" style={{ flex: 1, maxWidth: 200 }} placeholder="Plan (ej. 3 cuotas)" value={plan.nombre} onChange={e => setPlan(p => ({ ...p, nombre: e.target.value }))} />
                <input type="number" min="0" max="100" className="input mono" style={{ width: 90 }} placeholder="% com." value={plan.pct} onChange={e => setPlan(p => ({ ...p, pct: e.target.value }))} />
                <button className="btn btn-ghost btn-sm" onClick={handleAddPlan} disabled={!plan.nombre.trim()}>+ Agregar plan</button>
              </div>
            </div>

            {/* Movimientos */}
            <div className="card card-flush">
              <div style={{ overflow: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Fecha</th><th>Tipo</th><th>Plan</th><th style={{ textAlign: 'right' }}>Bruto</th><th style={{ textAlign: 'right' }}>Com.</th>
                      <th style={{ textAlign: 'right' }}>Neto</th><th>Caja / Venta</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {movs.map(m => (
                      <tr key={m.id}>
                        <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                        <td><span className={'badge ' + (m.tipo === 'cobro' ? '' : 'badge-info')}>{m.tipo === 'cobro' ? 'Cobro' : 'Liquidación'}</span></td>
                        <td className="tiny">{m.plan_nombre || (m.venta_order_id ? 'venta' : '—')}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{m.moneda === 'ARS' ? '$' : 'u$s'} {fmt(m.monto_bruto)}</td>
                        <td className="mono tiny" style={{ textAlign: 'right', color: 'var(--neg)' }}>{Number(m.monto_comision) > 0 ? fmt(m.monto_comision) : '—'}</td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{m.moneda === 'ARS' ? '$' : 'u$s'} {fmt(m.monto_neto)}</td>
                        <td className="tiny">{m.caja_nombre || (m.venta_order_id ? `Venta ${m.venta_order_id}` : '—')}</td>
                        <td><button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => handleDeleteMov(m.id)}><Icons.Trash size={13} /></button></td>
                      </tr>
                    ))}

                    {/* Fila de carga */}
                    <tr style={{ background: 'rgba(99,102,241,0.05)' }}>
                      <td><input type="date" className="input" style={{ height: 30, fontSize: 12 }} value={mov.fecha} onChange={e => setMov(m => ({ ...m, fecha: e.target.value }))} /></td>
                      <td>
                        <select className="input" style={{ height: 30, fontSize: 12 }} value={mov.tipo} onChange={e => setMov(m => ({ ...m, tipo: e.target.value }))}>
                          <option value="cobro">Cobro</option><option value="liquidacion">Liquidación</option>
                        </select>
                      </td>
                      <td>
                        {mov.tipo === 'cobro' ? (
                          <select className="input" style={{ height: 30, fontSize: 12 }} value={mov.plan_id} onChange={e => setMov(m => ({ ...m, plan_id: e.target.value }))}>
                            <option value="">Sin plan (0%)</option>
                            {(detalle.planes || []).map(p => <option key={p.id} value={p.id}>{p.nombre} ({fmt(p.pct)}%)</option>)}
                          </select>
                        ) : <span className="muted tiny">—</span>}
                      </td>
                      <td>
                        {mov.tipo === 'cobro'
                          ? <div className="flex-row" style={{ gap: 4 }}>
                              <input type="number" min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right', flex: 1 }} placeholder="Bruto" value={mov.monto_bruto} onChange={e => setMov(m => ({ ...m, monto_bruto: e.target.value }))} />
                              <select className="input" style={{ height: 30, fontSize: 12, width: 64 }} value={mov.moneda} onChange={e => setMov(m => ({ ...m, moneda: e.target.value }))}><option>ARS</option><option>USD</option></select>
                            </div>
                          : <input type="number" min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right' }} placeholder="Neto recibido" value={mov.monto} onChange={e => setMov(m => ({ ...m, monto: e.target.value }))} />}
                      </td>
                      <td className="mono tiny" style={{ textAlign: 'right', color: 'var(--neg)' }}>{mov.tipo === 'cobro' && cobroPreview.comision > 0 ? fmt(cobroPreview.comision) : '—'}</td>
                      <td className="mono tiny" style={{ textAlign: 'right', fontWeight: 700 }}>{mov.tipo === 'cobro' && parseFloat(mov.monto_bruto) > 0 ? fmt(cobroPreview.neto) : '—'}</td>
                      <td>
                        {mov.tipo === 'liquidacion'
                          ? <select className="input" style={{ height: 30, fontSize: 12 }} value={mov.caja_id} onChange={e => setMov(m => ({ ...m, caja_id: e.target.value }))}>
                              <option value="">Caja…</option>
                              {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre}{c.moneda ? ' · ' + c.moneda : ''}</option>)}
                            </select>
                          : <input className="input" style={{ height: 30, fontSize: 12 }} placeholder="Comentarios" value={mov.comentarios} onChange={e => setMov(m => ({ ...m, comentarios: e.target.value }))} />}
                      </td>
                      <td><button className="btn btn-primary btn-sm" disabled={savingMov} onClick={handleAddMov}>{savingMov ? '…' : 'Agregar'}</button></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modal nueva tarjeta */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Nueva tarjeta / procesador</h3><button className="icon-btn" onClick={() => setShowCreate(false)}><Icons.X size={16} /></button></div>
            <form onSubmit={handleCreate}>
              <div className="modal-body">
                <div className="field">
                  <label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label>
                  <input className="input" placeholder="Ej: Visa" value={nombre} onChange={e => setNombre(e.target.value)} autoFocus />
                </div>
                {createError && <div style={{ color: 'var(--neg)', fontSize: 13, marginTop: 8 }}>{createError}</div>}
              </div>
              <div className="modal-ft"><button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancelar</button><button type="submit" className="btn btn-primary" disabled={creating}>{creating ? 'Creando…' : 'Crear'}</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

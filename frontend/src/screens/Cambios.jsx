import { useState, useEffect, useMemo } from 'react';
import { Icons } from '../components/Icons';
import { cambios as cambiosApi, cajas as cajasApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';

const todayISO = () => new Date().toLocaleDateString('sv');
const esArs = (c) => c.moneda === 'ARS';
const EMPTY_MOV = { tipo: 'entrega_ars', fecha: todayISO(), monto_ars: '', tc: '', monto_usd: '', caja_id: '', comentarios: '' };

export default function Cambios() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  const [list, setList] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [detalle, setDetalle] = useState(null);
  const [movs, setMovs] = useState([]);
  const [cajas, setCajas] = useState([]);

  const [showCreate, setShowCreate] = useState(false);
  const [nombre, setNombre] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const [mov, setMov] = useState(EMPTY_MOV);
  const [savingMov, setSavingMov] = useState(false);

  function loadList() {
    setLoadingList(true);
    cambiosApi.entidades().then(r => setList(r || [])).catch(e => toast.error(e.message)).finally(() => setLoadingList(false));
  }
  useEffect(() => { loadList(); }, []); // eslint-disable-line
  useEffect(() => { cajasApi.listCajas().then(r => setCajas(Array.isArray(r) ? r : [])).catch(() => {}); }, []);

  useEffect(() => {
    setPrimaryAction({ label: 'Nueva financiera', onClick: () => { setNombre(''); setCreateError(''); setShowCreate(true); } });
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);

  useEffect(() => { if (list.length > 0 && !selectedId) setSelectedId(list[0].id); }, [list]); // eslint-disable-line

  function loadDetalle() {
    if (!selectedId) { setDetalle(null); setMovs([]); return; }
    Promise.all([cambiosApi.entidad(selectedId), cambiosApi.movimientos(selectedId)])
      .then(([det, m]) => { setDetalle(det); setMovs(m.data || []); })
      .catch(e => toast.error(e.message));
  }
  useEffect(() => { loadDetalle(); setMov(EMPTY_MOV); }, [selectedId]); // eslint-disable-line

  const cajasFiltradas = useMemo(() => cajas.filter(c => mov.tipo === 'entrega_ars' ? esArs(c) : !esArs(c)), [cajas, mov.tipo]);
  const usdPreview = useMemo(() => {
    if (mov.tipo === 'entrega_ars') {
      const a = parseFloat(mov.monto_ars), t = parseFloat(mov.tc);
      return (a > 0 && t > 0) ? Math.round((a / t) * 100) / 100 : 0;
    }
    return parseFloat(mov.monto_usd) || 0;
  }, [mov]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!nombre.trim()) { setCreateError('El nombre es obligatorio.'); return; }
    setCreating(true); setCreateError('');
    try {
      const nueva = await cambiosApi.createEntidad({ nombre: nombre.trim() });
      setList(prev => [...prev, nueva]);
      setSelectedId(nueva.id); setShowCreate(false);
      toast.success('Financiera creada.');
    } catch (err) { setCreateError(err.message); } finally { setCreating(false); }
  }

  async function handleAddMov(e) {
    e.preventDefault();
    if (!mov.caja_id) { toast.error('Elegí la caja.'); return; }
    setSavingMov(true);
    try {
      await cambiosApi.createMovimiento({
        entidad_id: selectedId, fecha: mov.fecha, tipo: mov.tipo,
        monto_ars: mov.tipo === 'entrega_ars' ? Number(mov.monto_ars) || 0 : 0,
        tc: mov.tipo === 'entrega_ars' ? Number(mov.tc) || null : null,
        monto_usd: mov.tipo === 'recibo_usd' ? Number(mov.monto_usd) || 0 : 0,
        caja_id: Number(mov.caja_id), comentarios: mov.comentarios.trim() || null,
      });
      setMov({ ...EMPTY_MOV, tipo: mov.tipo, fecha: mov.fecha });
      loadList(); loadDetalle();
      toast.success('Movimiento registrado.');
    } catch (err) { toast.error(err.message); } finally { setSavingMov(false); }
  }

  async function handleDeleteMov(id) {
    const ok = await confirm({ title: 'Eliminar movimiento', message: 'Se revertirá el movimiento en la caja.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await cambiosApi.deleteMovimiento(id); loadList(); loadDetalle(); } catch (err) { toast.error(err.message); }
  }

  async function handleDeleteEntidad() {
    if (!detalle) return;
    const ok = await confirm({ title: 'Eliminar financiera', message: `Se eliminará "${detalle.nombre}" y sus movimientos.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await cambiosApi.deleteEntidad(detalle.id);
      setList(prev => prev.filter(e => e.id !== detalle.id));
      setSelectedId(null); setDetalle(null);
      toast.success('Financiera eliminada.');
    } catch (err) { toast.error(err.message); }
  }

  const r = detalle?.resumen || {};

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">Cambios de Divisa</div>
          <div className="page-sub">Cuenta corriente con financieras de cambio · entregás $ y te devuelven USD</div>
        </div>
      </div>

      <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>
        {/* Lista de financieras */}
        <div className="card card-flush" style={{ maxHeight: '78vh', overflow: 'auto' }}>
          {loadingList ? <div className="empty">Cargando…</div>
            : list.length === 0 ? <div className="empty">Sin financieras. Creá la primera con "Nueva financiera".</div>
            : list.map((e, i) => (
              <div key={e.id} onClick={() => setSelectedId(e.id)} style={{
                padding: '10px 13px', cursor: 'pointer',
                borderBottom: i < list.length - 1 ? '1px solid var(--hairline)' : 0,
                background: selectedId === e.id ? 'var(--surface-2)' : 'transparent',
                borderLeft: selectedId === e.id ? '3px solid var(--accent)' : '3px solid transparent',
              }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{e.nombre}{!e.activo && <span className="muted tiny"> (inactiva)</span>}</div>
                <div className="mono tiny" style={{ marginTop: 2, color: Number(e.saldo_usd) > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                  Te deben: u$s {fmt(e.saldo_usd)}
                </div>
              </div>
            ))}
        </div>

        {/* Detalle */}
        {!detalle ? (
          <div className="card" style={{ minHeight: 200, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Elegí una financiera</div>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            <div className="card">
              <div className="flex-between" style={{ alignItems: 'flex-start' }}>
                <div style={{ fontWeight: 700, fontSize: 18 }}>{detalle.nombre}</div>
                <button className="icon-btn" title="Eliminar financiera" style={{ color: 'var(--neg)' }} onClick={handleDeleteEntidad}><Icons.Trash size={15} /></button>
              </div>
            </div>

            <div className="row">
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Te deben · USD</div>
                <div className="kpi-value mono" style={{ color: 'var(--accent)' }}>u$s {fmt(r.saldo_usd)}</div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Entregado · USD equiv.</div>
                <div className="kpi-value mono">u$s {fmt(r.entregado_usd)}</div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Recibido · USD</div>
                <div className="kpi-value mono">u$s {fmt(r.recibido_usd)}</div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Movimientos</div>
                <div className="kpi-value mono">{r.movimientos || 0}</div>
              </div>
            </div>

            <div className="card card-flush">
              <div style={{ overflow: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Fecha</th><th>Tipo</th><th style={{ textAlign: 'right' }}>$ ARS</th><th style={{ textAlign: 'right' }}>TC</th>
                      <th style={{ textAlign: 'right' }}>USD</th><th>Caja</th><th>Comentarios</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {movs.map(m => (
                      <tr key={m.id}>
                        <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                        <td><span className={'badge ' + (m.tipo === 'entrega_ars' ? '' : 'badge-info')}>{m.tipo === 'entrega_ars' ? 'Entrega $' : 'Recibo USD'}</span></td>
                        <td className="mono" style={{ textAlign: 'right' }}>{Number(m.monto_ars) > 0 ? '$ ' + fmt(m.monto_ars) : '—'}</td>
                        <td className="mono tiny" style={{ textAlign: 'right' }}>{m.tc ? fmt(m.tc) : '—'}</td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--accent)' }}>u$s {fmt(m.monto_usd)}</td>
                        <td className="tiny">{m.caja_nombre || '—'}</td>
                        <td className="muted tiny">{m.comentarios || '—'}</td>
                        <td><button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => handleDeleteMov(m.id)}><Icons.Trash size={13} /></button></td>
                      </tr>
                    ))}

                    {/* Fila de carga */}
                    <tr style={{ background: 'rgba(99,102,241,0.05)' }}>
                      <td><input type="date" className="input" style={{ height: 30, fontSize: 12 }} value={mov.fecha} onChange={e => setMov(m => ({ ...m, fecha: e.target.value }))} /></td>
                      <td>
                        <select className="input" style={{ height: 30, fontSize: 12 }} value={mov.tipo} onChange={e => setMov(m => ({ ...m, tipo: e.target.value, caja_id: '' }))}>
                          <option value="entrega_ars">Entrega $</option><option value="recibo_usd">Recibo USD</option>
                        </select>
                      </td>
                      <td><input type="number" min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right' }} placeholder="0" disabled={mov.tipo !== 'entrega_ars'} value={mov.monto_ars} onChange={e => setMov(m => ({ ...m, monto_ars: e.target.value }))} /></td>
                      <td><input type="number" min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right' }} placeholder="TC" disabled={mov.tipo !== 'entrega_ars'} value={mov.tc} onChange={e => setMov(m => ({ ...m, tc: e.target.value }))} /></td>
                      <td>
                        <input type="number" min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right', background: mov.tipo === 'entrega_ars' ? 'rgba(99,102,241,0.08)' : 'var(--surface)' }}
                          placeholder="USD" readOnly={mov.tipo === 'entrega_ars'}
                          value={mov.tipo === 'entrega_ars' ? (usdPreview || '') : mov.monto_usd}
                          onChange={e => setMov(m => ({ ...m, monto_usd: e.target.value }))} />
                      </td>
                      <td>
                        <select className="input" style={{ height: 30, fontSize: 12 }} value={mov.caja_id} onChange={e => setMov(m => ({ ...m, caja_id: e.target.value }))}>
                          <option value="">{mov.tipo === 'entrega_ars' ? 'Caja $…' : 'Caja USD…'}</option>
                          {cajasFiltradas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                        </select>
                      </td>
                      <td><input className="input" style={{ height: 30, fontSize: 12 }} placeholder="Comentarios" value={mov.comentarios} onChange={e => setMov(m => ({ ...m, comentarios: e.target.value }))} /></td>
                      <td><button className="btn btn-primary btn-sm" disabled={savingMov} onClick={handleAddMov}>{savingMov ? '…' : 'Agregar'}</button></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modal nueva financiera */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Nueva financiera de cambio</h3><button className="icon-btn" onClick={() => setShowCreate(false)}><Icons.X size={16} /></button></div>
            <form onSubmit={handleCreate}>
              <div className="modal-body">
                <div className="field">
                  <label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label>
                  <input className="input" placeholder="Ej: El Dorado" value={nombre} onChange={e => setNombre(e.target.value)} autoFocus />
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

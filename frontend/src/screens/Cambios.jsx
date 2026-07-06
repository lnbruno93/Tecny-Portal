import { useState, useEffect, useMemo, useRef } from 'react';
import { Icons } from '../components/Icons';
import { cambios as cambiosApi, cajas as cajasApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import { Skeleton } from '../components/Skeleton';
import useLoadingAction from '../lib/useLoadingAction';
import TcWarning from '../components/TcWarning';
import CajaSelectHint from '../components/CajaSelectHint';
import useModal from '../lib/useModal';
import { useAuth } from '../contexts/AuthContext';



const todayISO = () => new Date().toLocaleDateString('sv');

// UYU follow-up audit 2026-07-06: helpers derivados del país del tenant.
// El módulo Cambios de Divisa nació 100% para ARS/USD, pero desde F1-F5
// multi-país los tenants UY operan en UYU. Backend PR #514 ya soporta el
// par UYU/USD via CHECK constraint extendido + tipos 'entrega_uyu' /
// 'recibo_usd_uy'. Este componente ahora usa el país del tenant para:
//   - Elegir el tipo correcto al crear un movimiento.
//   - Rotular labels/badges/columnas con la moneda local correcta.
//   - Filtrar las cajas por la moneda local (no siempre ARS).
// AR sigue viendo exactamente lo mismo que antes; UY empieza a ver labels
// "Entrega UYU" / cajas UYU / columna "$ UYU".
function tiposPorPais(pais) {
  return pais === 'UY'
    ? { entregaLocal: 'entrega_uyu', reciboUsd: 'recibo_usd_uy' }
    : { entregaLocal: 'entrega_ars', reciboUsd: 'recibo_usd' };
}

// Etiqueta corta del tipo — para el badge en la grilla histórica. Soporta
// tanto los tipos AR como UY (una financiera en AR nunca tendrá filas UY
// y viceversa, pero el switch es defensivo por si alguna migración cambia
// el país del tenant a mitad de camino).
function labelTipo(tipo) {
  if (tipo === 'entrega_ars') return 'Entrega ARS';
  if (tipo === 'entrega_uyu') return 'Entrega UYU';
  if (tipo === 'recibo_usd' || tipo === 'recibo_usd_uy') return 'Recibo USD';
  return tipo;
}

export default function Cambios() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  // UYU follow-up: derivamos país + moneda local del user auth. Guard igual
  // al pattern de otras screens (Ventas.jsx, Envios.jsx, EgresosPanel.jsx):
  // user puede ser null en mount inicial o si /me falló. Default AR para
  // no romper el flow en ese edge.
  const { user } = useAuth() || {};
  const pais        = user?.tenant?.pais || 'AR';
  const monedaLocal = user?.tenant?.moneda_local || 'ARS';
  const TIPOS       = useMemo(() => tiposPorPais(pais), [pais]);

  const EMPTY_MOV = useMemo(
    () => ({
      tipo: TIPOS.entregaLocal, fecha: todayISO(),
      monto_ars: '', tc: '', monto_usd: '',
      caja_id: '', comentarios: '',
    }),
    [TIPOS.entregaLocal]
  );

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
  const createModalRef = useRef(null);
  useModal({ open: showCreate, onClose: () => setShowCreate(false), overlayRef: createModalRef });

  const [mov, setMov] = useState(EMPTY_MOV);
  // Post-audit: migración a useLoadingAction (DRY + anti-click-spam free).
  const { loading: savingMov, run: withSavingMov } = useLoadingAction();

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
  useEffect(() => { loadDetalle(); setMov(EMPTY_MOV); }, [selectedId, EMPTY_MOV]); // eslint-disable-line

  // Cajas filtradas según el tipo del movimiento en carga:
  //   - Entrega local (ARS o UYU): solo cajas de esa moneda local.
  //   - Recibo USD: solo cajas USD.
  const cajasFiltradas = useMemo(
    () => cajas.filter(c => mov.tipo === TIPOS.entregaLocal
      ? c.moneda === monedaLocal
      : c.moneda !== monedaLocal),
    [cajas, mov.tipo, monedaLocal, TIPOS.entregaLocal]
  );
  const usdPreview = useMemo(() => {
    if (mov.tipo === TIPOS.entregaLocal) {
      const a = parseFloat(mov.monto_ars), t = parseFloat(mov.tc);
      return (a > 0 && t > 0) ? Math.round((a / t) * 100) / 100 : 0;
    }
    return parseFloat(mov.monto_usd) || 0;
  }, [mov, TIPOS.entregaLocal]);

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
    await withSavingMov(async () => {
      try {
        await cambiosApi.createMovimiento({
          entidad_id: selectedId, fecha: mov.fecha, tipo: mov.tipo,
          // monto_ars es el nombre legacy de la columna DB — contiene el
          // monto en la moneda local del tenant (ARS o UYU).
          monto_ars: mov.tipo === TIPOS.entregaLocal ? Number(mov.monto_ars) || 0 : 0,
          tc:        mov.tipo === TIPOS.entregaLocal ? Number(mov.tc) || null : null,
          monto_usd: mov.tipo === TIPOS.reciboUsd    ? Number(mov.monto_usd) || 0 : 0,
          caja_id: Number(mov.caja_id), comentarios: mov.comentarios.trim() || null,
        });
        setMov({ ...EMPTY_MOV, tipo: mov.tipo, fecha: mov.fecha });
        loadList(); loadDetalle();
        toast.success('Movimiento registrado.');
      } catch (err) { toast.error(err.message); }
    });
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
  const esEntregaLocal = mov.tipo === TIPOS.entregaLocal;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Cambios de Divisa</h1>
          <div className="page-sub">Cuenta corriente con financieras de cambio · entregás {monedaLocal} y te devuelven USD</div>
        </div>
      </div>

      <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>
        {/* Lista de financieras */}
        <div className="card card-flush" style={{ maxHeight: '78vh', overflow: 'auto' }}>
          {/* 2026-06-25 UX-3 (audit pre-live): skeleton bars en lugar del
              "Cargando…" plano. Mantiene la altura del card estable mientras
              llega la lista, evita el "salto" visual al renderizar. */}
          {loadingList ? (
            <div style={{ padding: 8 }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} style={{ padding: '10px 13px', borderBottom: i < 4 ? '1px solid var(--hairline)' : 0 }}>
                  <Skeleton width="60%" height={14} />
                  <div style={{ marginTop: 6 }}><Skeleton width="40%" height={11} /></div>
                </div>
              ))}
            </div>
          )
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
                      <th>Fecha</th><th>Tipo</th><th style={{ textAlign: 'right' }}>$ {monedaLocal}</th><th style={{ textAlign: 'right' }}>TC</th>
                      <th style={{ textAlign: 'right' }}>USD</th><th>Caja</th><th>Comentarios</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {movs.map(m => {
                      const isEntregaLocal = m.tipo === 'entrega_ars' || m.tipo === 'entrega_uyu';
                      return (
                        <tr key={m.id}>
                          <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                          <td><span className={'badge ' + (isEntregaLocal ? '' : 'badge-info')}>{labelTipo(m.tipo)}</span></td>
                          <td className="mono" style={{ textAlign: 'right' }}>{Number(m.monto_ars) > 0 ? '$ ' + fmt(m.monto_ars) : '—'}</td>
                          <td className="mono tiny" style={{ textAlign: 'right' }}>{m.tc ? fmt(m.tc) : '—'}</td>
                          <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--accent)' }}>u$s {fmt(m.monto_usd)}</td>
                          <td className="tiny">{m.caja_nombre || '—'}</td>
                          <td className="muted tiny">{m.comentarios || '—'}</td>
                          <td><button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => handleDeleteMov(m.id)}><Icons.Trash size={13} /></button></td>
                        </tr>
                      );
                    })}

                    {/* Fila de carga */}
                    <tr style={{ background: 'rgba(99,102,241,0.05)' }}>
                      <td><input type="date" className="input" style={{ height: 30, fontSize: 12 }} value={mov.fecha} onChange={e => setMov(m => ({ ...m, fecha: e.target.value }))} /></td>
                      <td>
                        <select className="input" style={{ height: 30, fontSize: 12 }} value={mov.tipo} onChange={e => setMov(m => ({ ...m, tipo: e.target.value, caja_id: '' }))}>
                          <option value={TIPOS.entregaLocal}>Entrega {monedaLocal}</option>
                          <option value={TIPOS.reciboUsd}>Recibo USD</option>
                        </select>
                      </td>
                      <td><input type="number" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right' }} placeholder="0" disabled={!esEntregaLocal} value={mov.monto_ars} onChange={e => setMov(m => ({ ...m, monto_ars: e.target.value }))} /></td>
                      <td>
                        <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right' }} placeholder="TC" disabled={!esEntregaLocal} value={mov.tc} onChange={e => setMov(m => ({ ...m, tc: e.target.value }))} />
                        {esEntregaLocal && <TcWarning tc={mov.tc} />}
                      </td>
                      <td>
                        <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right', background: esEntregaLocal ? 'rgba(99,102,241,0.08)' : 'var(--surface)' }}
                          placeholder="USD" readOnly={esEntregaLocal}
                          value={esEntregaLocal ? (usdPreview || '') : mov.monto_usd}
                          onChange={e => setMov(m => ({ ...m, monto_usd: e.target.value }))} />
                      </td>
                      <td>
                        <select className="input" style={{ height: 30, fontSize: 12 }} value={mov.caja_id} onChange={e => setMov(m => ({ ...m, caja_id: e.target.value }))}>
                          <option value="">{esEntregaLocal ? `Caja ${monedaLocal}…` : 'Caja USD…'}</option>
                          {cajasFiltradas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                          <CajaSelectHint />
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
        <div ref={createModalRef} className="modal-overlay" onClick={() => setShowCreate(false)}>
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

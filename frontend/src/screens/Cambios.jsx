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
// 'recibo_usd_uy'.
//
// 2026-07-14 (feature dirección inversa): agregamos los 4 tipos "les damos
// USD, nos devuelven pesos". Ahora hay 4 tipos por país (2 direcciones ×
// 2 operaciones — entrega/recibo):
//   Dirección A (les damos pesos, nos deben USD):
//     · entregaLocal    → entrega_ars / entrega_uyu
//     · reciboUsd       → recibo_usd / recibo_usd_uy
//   Dirección B (les damos USD, nos deben pesos):
//     · entregaUsd      → entrega_usd_por_ars / entrega_usd_por_uyu
//     · reciboLocal     → recibo_ars / recibo_uyu
function tiposPorPais(pais) {
  return pais === 'UY'
    ? {
        entregaLocal: 'entrega_uyu',
        reciboUsd:    'recibo_usd_uy',
        entregaUsd:   'entrega_usd_por_uyu',
        reciboLocal:  'recibo_uyu',
      }
    : {
        entregaLocal: 'entrega_ars',
        reciboUsd:    'recibo_usd',
        entregaUsd:   'entrega_usd_por_ars',
        reciboLocal:  'recibo_ars',
      };
}

// Etiqueta corta del tipo — para el badge en la grilla histórica. Soporta
// tanto los tipos AR como UY (una financiera en AR nunca tendrá filas UY
// y viceversa, pero el switch es defensivo por si alguna migración cambia
// el país del tenant a mitad de camino).
function labelTipo(tipo) {
  if (tipo === 'entrega_ars') return 'Entrega ARS → USD';
  if (tipo === 'entrega_uyu') return 'Entrega UYU → USD';
  if (tipo === 'recibo_usd' || tipo === 'recibo_usd_uy') return 'Recibo USD';
  if (tipo === 'entrega_usd_por_ars') return 'Entrega USD → ARS';
  if (tipo === 'entrega_usd_por_uyu') return 'Entrega USD → UYU';
  if (tipo === 'recibo_ars') return 'Recibo ARS';
  if (tipo === 'recibo_uyu') return 'Recibo UYU';
  return tipo;
}

// Categorías: usan monto local? USD? tc? — helpers reutilizados por la UI.
const isEntregaLocalTipo = (t) => t === 'entrega_ars' || t === 'entrega_uyu';
const isEntregaUsdTipo   = (t) => t === 'entrega_usd_por_ars' || t === 'entrega_usd_por_uyu';
const isReciboUsdTipo    = (t) => t === 'recibo_usd' || t === 'recibo_usd_uy';
const isReciboLocalTipo  = (t) => t === 'recibo_ars' || t === 'recibo_uyu';
// Qué moneda va la caja de este movimiento (USD o la local).
const monedaCajaDelTipo  = (t, monedaLocal) =>
  (isEntregaUsdTipo(t) || isReciboUsdTipo(t)) ? 'USD' : monedaLocal;

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
  // 2026-07-12 (auditoría TOTAL Financiero P1-1, Pattern G):
  // Idempotency-Key para POST /cambios/movimientos. Se regenera después de
  // cada submit exitoso para permitir múltiples movimientos consecutivos
  // desde el mismo form (cada uno con su propio key).
  const [movIdempotencyKey, setMovIdempotencyKey] = useState(() => crypto.randomUUID());
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

  // 2026-07-14 (dirección inversa): cajas filtradas por moneda según tipo.
  //   · Movimientos USD (entrega_usd_por_* / recibo_usd*): cajas USD.
  //   · Movimientos locales (entrega_local / recibo_local): cajas moneda local.
  const cajaMonedaEsperada = monedaCajaDelTipo(mov.tipo, monedaLocal);
  const cajasFiltradas = useMemo(
    () => cajas.filter(c => c.moneda === cajaMonedaEsperada),
    [cajas, cajaMonedaEsperada]
  );

  // Preview del USD equivalente / deuda local — depende del tipo:
  //   · entrega local: usd = monto_local / tc     (nos deben esa USD)
  //   · entrega USD:   local = monto_usd × tc     (nos deben esa cantidad local)
  //   · recibo USD/local: solo el monto tal cual, sin conversión
  const usdPreview = useMemo(() => {
    if (isEntregaLocalTipo(mov.tipo)) {
      const a = parseFloat(mov.monto_ars), t = parseFloat(mov.tc);
      return (a > 0 && t > 0) ? Math.round((a / t) * 100) / 100 : 0;
    }
    if (isEntregaUsdTipo(mov.tipo)) {
      // Para entrega USD el input es USD directo — no hay preview cross-moneda
      // en la columna USD (usamos la columna local para mostrar la deuda).
      return parseFloat(mov.monto_usd) || 0;
    }
    return parseFloat(mov.monto_usd) || 0;
  }, [mov]);
  // Preview local: solo aplica a entrega_usd_por_* (la deuda es en local).
  const localPreview = useMemo(() => {
    if (isEntregaUsdTipo(mov.tipo)) {
      const u = parseFloat(mov.monto_usd), t = parseFloat(mov.tc);
      return (u > 0 && t > 0) ? Math.round((u * t) * 100) / 100 : 0;
    }
    return null;
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
    await withSavingMov(async () => {
      try {
        // 2026-07-14 (dirección inversa): payload adaptado por tipo.
        //   · entrega local: monto_ars (monto local) + tc (para calcular USD deuda)
        //   · entrega USD:   monto_usd + tc (para calcular deuda local — server-side)
        //   · recibo USD:    monto_usd solo
        //   · recibo local:  monto_ars solo
        // `monto_ars` es alias legacy — contiene monto en la moneda local
        // (ARS o UYU según país + tipo específico).
        const t = mov.tipo;
        const needsLocalInput = isEntregaLocalTipo(t) || isReciboLocalTipo(t);
        const needsUsdInput   = isEntregaUsdTipo(t) || isReciboUsdTipo(t);
        const needsTc         = isEntregaLocalTipo(t) || isEntregaUsdTipo(t);
        await cambiosApi.createMovimiento({
          entidad_id: selectedId, fecha: mov.fecha, tipo: t,
          monto_ars: needsLocalInput ? Number(mov.monto_ars) || 0 : 0,
          tc:        needsTc         ? Number(mov.tc) || null   : null,
          monto_usd: needsUsdInput   ? Number(mov.monto_usd) || 0 : 0,
          caja_id: Number(mov.caja_id), comentarios: mov.comentarios.trim() || null,
        }, movIdempotencyKey);
        setMov({ ...EMPTY_MOV, tipo: mov.tipo, fecha: mov.fecha });
        // Pattern G: regenerar UUID después del éxito para el próximo submit.
        setMovIdempotencyKey(crypto.randomUUID());
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
  // 2026-07-14 (dirección inversa): 4 categorías de tipo. Cada una habilita
  // distintos inputs (local vs USD, con o sin TC).
  const isEntregaLocal = isEntregaLocalTipo(mov.tipo);
  const isEntregaUsd   = isEntregaUsdTipo(mov.tipo);
  const isReciboUsd    = isReciboUsdTipo(mov.tipo);
  const isReciboLocal  = isReciboLocalTipo(mov.tipo);
  const inputLocalActivo = isEntregaLocal || isReciboLocal; // input "$ Local"
  const inputUsdActivo   = isEntregaUsd || isReciboUsd;     // input "USD"
  const inputTcActivo    = isEntregaLocal || isEntregaUsd;  // input "TC"

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Cambios de Divisa</h1>
          <div className="page-sub">
            Cuenta corriente con financieras de cambio · entregás {monedaLocal} y te devuelven USD, o entregás USD y te devuelven {monedaLocal}
          </div>
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
                {/* 2026-07-14 (dirección inversa): puede haber saldos en 3 monedas
                   simultáneamente. Mostramos los que son != 0 (o solo USD si
                   no hay deuda local, para no romper la altura de la card). */}
                <div className="mono tiny" style={{ marginTop: 2, color: Number(e.saldo_usd) > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                  Te deben: u$s {fmt(e.saldo_usd)}
                </div>
                {Number(e.saldo_ars) > 0 && (
                  <div className="mono tiny" style={{ marginTop: 2, color: 'var(--accent)' }}>
                    + $ {fmt(e.saldo_ars)} ARS
                  </div>
                )}
                {Number(e.saldo_uyu) > 0 && (
                  <div className="mono tiny" style={{ marginTop: 2, color: 'var(--accent)' }}>
                    + $U {fmt(e.saldo_uyu)} UYU
                  </div>
                )}
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
                <div className="kpi-value mono" style={{ color: Number(r.saldo_usd) > 0 ? 'var(--accent)' : 'inherit' }}>u$s {fmt(r.saldo_usd)}</div>
              </div>
              {/* 2026-07-14 (dirección inversa): saldos en moneda local, solo
                 si != 0 para no llenar de "0" a users que no usan la inversa. */}
              {Number(r.saldo_ars) !== 0 && (
                <div className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">Te deben · ARS</div>
                  <div className="kpi-value mono" style={{ color: Number(r.saldo_ars) > 0 ? 'var(--accent)' : 'inherit' }}>$ {fmt(r.saldo_ars)}</div>
                </div>
              )}
              {Number(r.saldo_uyu) !== 0 && (
                <div className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">Te deben · UYU</div>
                  <div className="kpi-value mono" style={{ color: Number(r.saldo_uyu) > 0 ? 'var(--accent)' : 'inherit' }}>$U {fmt(r.saldo_uyu)}</div>
                </div>
              )}
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
                      // 2026-07-14 (dirección inversa): 4 categorías. El color
                      // del badge diferencia: entrega/recibo × local/USD.
                      const cat = isEntregaLocalTipo(m.tipo) ? 'ent-loc'
                                : isEntregaUsdTipo(m.tipo)   ? 'ent-usd'
                                : isReciboUsdTipo(m.tipo)    ? 'rec-usd'
                                : 'rec-loc';
                      const badgeCls = cat === 'ent-loc' ? '' : 'badge-info';
                      return (
                        <tr key={m.id}>
                          <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                          <td><span className={'badge ' + badgeCls}>{labelTipo(m.tipo)}</span></td>
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
                        {/* 2026-07-14 (dirección inversa): 4 opciones. Agrupadas
                           visualmente por dirección con separadores textuales. */}
                        <select className="input" style={{ height: 30, fontSize: 12 }} value={mov.tipo} onChange={e => setMov(m => ({ ...m, tipo: e.target.value, caja_id: '', monto_ars: '', monto_usd: '', tc: '' }))}>
                          <optgroup label={`Entregás ${monedaLocal} → te deben USD`}>
                            <option value={TIPOS.entregaLocal}>Entrega {monedaLocal}</option>
                            <option value={TIPOS.reciboUsd}>Recibo USD</option>
                          </optgroup>
                          <optgroup label={`Entregás USD → te deben ${monedaLocal}`}>
                            <option value={TIPOS.entregaUsd}>Entrega USD</option>
                            <option value={TIPOS.reciboLocal}>Recibo {monedaLocal}</option>
                          </optgroup>
                        </select>
                      </td>
                      <td>
                        {/* Input local ($ monedaLocal): activo cuando el mov usa
                           input local (entrega_local o recibo_local). Cuando
                           es entrega_usd, muestra el localPreview (readonly)
                           que es la deuda calculada usd × tc. */}
                        <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono"
                          style={{ height: 30, fontSize: 12, textAlign: 'right', background: isEntregaUsd ? 'rgba(99,102,241,0.08)' : 'var(--surface)' }}
                          placeholder="0"
                          disabled={!inputLocalActivo && !isEntregaUsd}
                          readOnly={isEntregaUsd}
                          value={isEntregaUsd ? (localPreview || '') : mov.monto_ars}
                          onChange={e => setMov(m => ({ ...m, monto_ars: e.target.value }))} />
                      </td>
                      <td>
                        <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right' }} placeholder="TC" disabled={!inputTcActivo} value={mov.tc} onChange={e => setMov(m => ({ ...m, tc: e.target.value }))} />
                        {inputTcActivo && <TcWarning tc={mov.tc} />}
                      </td>
                      <td>
                        {/* Input USD: activo cuando el mov usa input USD (entrega_usd
                           o recibo_usd). Cuando es entrega_local, muestra
                           usdPreview readonly (usd = local / tc). */}
                        <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right', background: isEntregaLocal ? 'rgba(99,102,241,0.08)' : 'var(--surface)' }}
                          placeholder="USD" readOnly={isEntregaLocal}
                          disabled={!inputUsdActivo && !isEntregaLocal}
                          value={isEntregaLocal ? (usdPreview || '') : mov.monto_usd}
                          onChange={e => setMov(m => ({ ...m, monto_usd: e.target.value }))} />
                      </td>
                      <td>
                        <select className="input" style={{ height: 30, fontSize: 12 }} value={mov.caja_id} onChange={e => setMov(m => ({ ...m, caja_id: e.target.value }))}>
                          <option value="">Caja {cajaMonedaEsperada}…</option>
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

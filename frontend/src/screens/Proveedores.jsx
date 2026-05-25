import { useState, useEffect } from 'react';
import { Icons } from '../components/Icons';
import { proveedores as provApi, cajas as cajasApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';

const todayISO = () => new Date().toISOString().split('T')[0];
const fmtUsd = (n) => 'US$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtFecha = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('es-AR') : '—';

const EMPTY_PROV = () => ({ nombre: '', contacto_nombre: '', contacto_apellido: '', whatsapp: '', ubicacion: '', notas: '' });
const EMPTY_MOV  = () => ({ fecha: todayISO(), tipo: 'compra', descripcion: '', monto: '', moneda: 'USD', tc: '', caja_id: '', notas: '' });

export default function Proveedores() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [buscar, setBuscar] = useState('');
  const [selected, setSelected] = useState(null);   // proveedor seleccionado
  const [movs, setMovs] = useState([]);
  const [loadingMovs, setLoadingMovs] = useState(false);
  const [cajas, setCajas] = useState([]);

  // Modales
  const [showProv, setShowProv] = useState(false);
  const [provForm, setProvForm] = useState(EMPTY_PROV);
  const [provSaving, setProvSaving] = useState(false);
  const [provError, setProvError] = useState('');

  const [showMov, setShowMov] = useState(false);
  const [movForm, setMovForm] = useState(EMPTY_MOV);
  const [movSaving, setMovSaving] = useState(false);
  const [movError, setMovError] = useState('');

  async function loadList() {
    setLoading(true);
    try { setList(await provApi.list(buscar ? { buscar } : {}) || []); }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [buscar]);

  // Cajas para el selector de pago (degradación elegante si no hay permiso)
  useEffect(() => { cajasApi.listCajas().then(r => setCajas((r || []).filter(c => c.activo))).catch(() => setCajas([])); }, []);

  useEffect(() => {
    setPrimaryAction({ label: 'Nuevo proveedor', onClick: () => { setProvForm(EMPTY_PROV()); setProvError(''); setShowProv(true); } });
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);

  async function selectProveedor(p) {
    setSelected(p);
    setLoadingMovs(true);
    try { setMovs(await provApi.movimientos(p.id) || []); }
    catch (e) { console.error(e); }
    finally { setLoadingMovs(false); }
  }

  async function handleCreateProv(e) {
    e.preventDefault();
    if (!provForm.nombre.trim()) { setProvError('El nombre del proveedor es obligatorio.'); return; }
    setProvSaving(true); setProvError('');
    try {
      await provApi.create({ ...provForm, nombre: provForm.nombre.trim() });
      setShowProv(false);
      toast.success('Proveedor creado.');
      loadList();
    } catch (e) { setProvError(e.message || 'No se pudo crear.'); }
    finally { setProvSaving(false); }
  }

  async function handleDeleteProv(p) {
    const ok = await confirm({ title: 'Eliminar proveedor', message: `¿Eliminar "${p.nombre}"? Se ocultará junto con sus movimientos.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await provApi.delete(p.id);
      toast.success('Proveedor eliminado.');
      if (selected?.id === p.id) { setSelected(null); setMovs([]); }
      loadList();
    } catch (e) { toast.error(e.message); }
  }

  async function handleCreateMov(e) {
    e.preventDefault();
    if (!movForm.monto || Number(movForm.monto) <= 0) { setMovError('El monto debe ser mayor a 0.'); return; }
    if (movForm.moneda === 'ARS' && (!movForm.tc || Number(movForm.tc) <= 0)) { setMovError('Para ARS ingresá el tipo de cambio.'); return; }
    setMovSaving(true); setMovError('');
    try {
      await provApi.createMovimiento({
        proveedor_id: selected.id,
        fecha: movForm.fecha,
        tipo: movForm.tipo,
        descripcion: movForm.descripcion || null,
        monto: Number(movForm.monto),
        moneda: movForm.moneda,
        tc: movForm.moneda === 'ARS' ? Number(movForm.tc) : null,
        caja_id: movForm.caja_id ? Number(movForm.caja_id) : null,
        notas: movForm.notas || null,
      });
      setShowMov(false);
      toast.success(movForm.tipo === 'compra' ? 'Compra registrada.' : 'Pago registrado.');
      selectProveedor(selected);  // refresca movimientos
      loadList();                 // refresca saldos
    } catch (e) { setMovError(e.message || 'No se pudo registrar.'); }
    finally { setMovSaving(false); }
  }

  async function handleDeleteMov(m) {
    const ok = await confirm({ title: 'Eliminar movimiento', message: 'Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await provApi.deleteMovimiento(m.id); toast.success('Movimiento eliminado.'); selectProveedor(selected); loadList(); }
    catch (e) { toast.error(e.message); }
  }

  const totalDeuda = list.reduce((s, p) => s + Number(p.saldo_usd || 0), 0);

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Proveedores</h1>
          <div className="page-sub">Compras y cuenta corriente con proveedores</div>
        </div>
      </div>

      {/* KPIs */}
      <div className="row" style={{ marginBottom: 20, gap: 12 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Proveedores</div>
          <div className="kpi-value mono">{list.length}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Deuda total (lo que debemos)</div>
          <div className="kpi-value"><span className="ccy">USD</span><span className="mono neg">{fmtUsd(totalDeuda).replace('US$ ', '')}</span></div>
        </div>
      </div>

      <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
        {/* Lista de proveedores */}
        <div className="card card-flush" style={{ flex: 1, minWidth: 360 }}>
          <div className="card-hd" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <h3>Proveedores — {list.length}</h3>
            <input className="input" style={{ maxWidth: 200 }} placeholder="Buscar…" value={buscar} onChange={e => setBuscar(e.target.value)} />
          </div>
          {loading ? <div className="empty">Cargando…</div>
            : list.length === 0 ? <div className="empty">Sin proveedores. Creá el primero.</div>
            : (
              <table className="tbl">
                <thead><tr><th>Proveedor</th><th>Contacto</th><th className="num">Saldo USD</th><th style={{ width: 40 }}></th></tr></thead>
                <tbody>
                  {list.map(p => (
                    <tr key={p.id} onClick={() => selectProveedor(p)}
                        style={{ cursor: 'pointer', background: selected?.id === p.id ? 'var(--bg-hover, rgba(255,255,255,0.04))' : undefined }}>
                      <td style={{ fontWeight: 600 }}>{p.nombre}</td>
                      <td className="muted tiny">{[p.contacto_nombre, p.contacto_apellido].filter(Boolean).join(' ') || '—'}{p.whatsapp ? ` · ${p.whatsapp}` : ''}</td>
                      <td className="num mono" style={{ fontWeight: 600 }}>
                        <span className={Number(p.saldo_usd) > 0 ? 'neg' : ''}>{fmtUsd(p.saldo_usd).replace('US$ ', '')}</span>
                      </td>
                      <td><button className="icon-btn" onClick={e => { e.stopPropagation(); handleDeleteProv(p); }}><Icons.Trash size={13} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

        {/* Detalle del proveedor seleccionado */}
        <div className="card card-flush" style={{ flex: 1.3, minWidth: 380 }}>
          {!selected ? (
            <div className="empty">Seleccioná un proveedor para ver su cuenta corriente.</div>
          ) : (
            <>
              <div className="card-hd" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h3>{selected.nombre}</h3>
                  <div className="muted tiny">{selected.ubicacion || ''}</div>
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => { setMovForm(EMPTY_MOV()); setMovError(''); setShowMov(true); }}>+ Compra / Pago</button>
              </div>
              {loadingMovs ? <div className="empty">Cargando…</div>
                : movs.length === 0 ? <div className="empty">Sin movimientos. Registrá una compra o un pago.</div>
                : (
                  <table className="tbl">
                    <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th className="num">Monto USD</th><th style={{ width: 40 }}></th></tr></thead>
                    <tbody>
                      {movs.map(m => (
                        <tr key={m.id}>
                          <td className="muted mono tiny">{fmtFecha(m.fecha)}</td>
                          <td><span className={'badge ' + (m.tipo === 'compra' ? 'badge-warn' : 'badge-pos')}>{m.tipo === 'compra' ? 'Compra' : 'Pago'}</span></td>
                          <td className="tiny">{m.descripcion || '—'}{m.caja_nombre ? ` · ${m.caja_nombre}` : ''}</td>
                          <td className="num mono">{fmtUsd(m.monto_usd).replace('US$ ', '')}</td>
                          <td><button className="icon-btn" onClick={() => handleDeleteMov(m)}><Icons.Trash size={13} /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </>
          )}
        </div>
      </div>

      {/* Modal: Nuevo proveedor */}
      {showProv && (
        <div className="modal-overlay" onClick={() => setShowProv(false)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Nuevo proveedor</h3><button className="icon-btn" onClick={() => setShowProv(false)}><Icons.X size={16} /></button></div>
            <form onSubmit={handleCreateProv}>
              <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
                <div className="field"><label className="field-label">Proveedor *</label>
                  <input className="input" value={provForm.nombre} onChange={e => setProvForm(f => ({ ...f, nombre: e.target.value }))} autoFocus /></div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}><label className="field-label">Contacto (nombre)</label>
                    <input className="input" value={provForm.contacto_nombre} onChange={e => setProvForm(f => ({ ...f, contacto_nombre: e.target.value }))} /></div>
                  <div className="field" style={{ flex: 1 }}><label className="field-label">Contacto (apellido)</label>
                    <input className="input" value={provForm.contacto_apellido} onChange={e => setProvForm(f => ({ ...f, contacto_apellido: e.target.value }))} /></div>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}><label className="field-label">WhatsApp</label>
                    <input className="input" value={provForm.whatsapp} onChange={e => setProvForm(f => ({ ...f, whatsapp: e.target.value }))} /></div>
                  <div className="field" style={{ flex: 1 }}><label className="field-label">Ubicación</label>
                    <input className="input" value={provForm.ubicacion} onChange={e => setProvForm(f => ({ ...f, ubicacion: e.target.value }))} /></div>
                </div>
                <div className="field"><label className="field-label">Notas</label>
                  <input className="input" value={provForm.notas} onChange={e => setProvForm(f => ({ ...f, notas: e.target.value }))} /></div>
                {provError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{provError}</div>}
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowProv(false)}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={provSaving}>{provSaving ? 'Guardando…' : 'Crear proveedor'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Nueva compra / pago */}
      {showMov && selected && (
        <div className="modal-overlay" onClick={() => setShowMov(false)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Compra / Pago — {selected.nombre}</h3><button className="icon-btn" onClick={() => setShowMov(false)}><Icons.X size={16} /></button></div>
            <form onSubmit={handleCreateMov}>
              <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}><label className="field-label">Tipo</label>
                    <select className="input" value={movForm.tipo} onChange={e => setMovForm(f => ({ ...f, tipo: e.target.value }))}>
                      <option value="compra">Compra (les debemos)</option>
                      <option value="pago">Pago (les pagamos)</option>
                    </select></div>
                  <div className="field" style={{ flex: 1 }}><label className="field-label">Fecha</label>
                    <input type="date" className="input" value={movForm.fecha} onChange={e => setMovForm(f => ({ ...f, fecha: e.target.value }))} /></div>
                </div>
                <div className="field"><label className="field-label">Detalle</label>
                  <input className="input" placeholder={movForm.tipo === 'compra' ? 'ej. 10 iPhone 15' : 'ej. transferencia'} value={movForm.descripcion} onChange={e => setMovForm(f => ({ ...f, descripcion: e.target.value }))} /></div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}><label className="field-label">Monto</label>
                    <input type="number" step="0.01" className="input" value={movForm.monto} onChange={e => setMovForm(f => ({ ...f, monto: e.target.value }))} /></div>
                  <div className="field" style={{ width: 110 }}><label className="field-label">Moneda</label>
                    <select className="input" value={movForm.moneda} onChange={e => setMovForm(f => ({ ...f, moneda: e.target.value }))}>
                      <option value="USD">USD</option><option value="ARS">ARS</option><option value="USDT">USDT</option>
                    </select></div>
                  {movForm.moneda === 'ARS' && (
                    <div className="field" style={{ width: 110 }}><label className="field-label">TC</label>
                      <input type="number" step="0.01" className="input" value={movForm.tc} onChange={e => setMovForm(f => ({ ...f, tc: e.target.value }))} /></div>
                  )}
                </div>
                {movForm.tipo === 'pago' && cajas.length > 0 && (
                  <div className="field"><label className="field-label">Caja (de dónde sale el pago)</label>
                    <select className="input" value={movForm.caja_id} onChange={e => setMovForm(f => ({ ...f, caja_id: e.target.value }))}>
                      <option value="">— Sin especificar —</option>
                      {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>)}
                    </select></div>
                )}
                {movError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{movError}</div>}
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowMov(false)}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={movSaving}>{movSaving ? 'Guardando…' : 'Registrar'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

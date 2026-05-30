import { useState, useEffect, useMemo, useRef } from 'react';
import { Icons } from '../components/Icons';
import { proveedores as provApi, cajas as cajasApi } from '../lib/api';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';
import CompraProveedorModal from '../components/CompraProveedorModal';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import CajaSelectHint from '../components/CajaSelectHint';



// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtUSD(n) { return 'USD ' + fmt(n); }
function todayISO() { return new Date().toLocaleDateString('sv'); }

const TIPO_DISPLAY = {
  compra:        { label: 'Compra',        tone: 'pos',     signo: +1 },
  pago:          { label: 'Pago',          tone: 'neg',     signo: -1 },
  saldo_inicial: { label: 'Saldo inicial', tone: 'default', signo: +1 },
};

function Status({ tone = 'default', children }) {
  return <span className={`status s-${tone}`}>{children}</span>;
}

// ─── Datalists para desplegables de producto ─────────────────────────────────


// ─── MAIN SCREEN ──────────────────────────────────────────────────────────────

const EMPTY_PROV = () => ({
  nombre: '', contacto_nombre: '', contacto_apellido: '', whatsapp: '', ubicacion: '', notas: '', saldo_inicial: '',
});

export default function Proveedores() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  const [search, setSearch]   = useState('');
  const dSearch = useDebouncedValue(search, 350);
  const [list, setList]       = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [movs, setMovs]       = useState([]);
  const [movsPag, setMovsPag] = useState({ page: 1, pages: 1, total: 0 });
  const [loadingMasMovs, setLoadingMasMovs] = useState(false);
  const [loadingList, setLoadingList]   = useState(true);
  const [loadingMovs, setLoadingMovs]   = useState(false);

  const [showProv, setShowProv]   = useState(false);
  const [editId, setEditId]       = useState(null);   // null = alta; id = edición
  const [provForm, setProvForm]   = useState(EMPTY_PROV);
  const [provSaving, setProvSaving] = useState(false);
  const [provError, setProvError] = useState('');

  // Cajas activas (metodos_pago) para alimentar el selector de cada fila del
  // bloque inline. La caja se elige por fila (no global): permite cargar de
  // varias cajas en una misma sesión y refleja correctamente la moneda.
  const [cajas, setCajas] = useState([]);

  // ── Cargar lista ──
  const listReq = useRef(0); // token "última request gana" (evita que una respuesta lenta pise a una nueva)
  function loadList() {
    setLoadingList(true);
    const reqId = ++listReq.current;
    provApi.list(dSearch ? { buscar: dSearch } : {})
      .then(r => { if (reqId === listReq.current) setList(r?.data || []); })
      .catch(console.error)
      .finally(() => { if (reqId === listReq.current) setLoadingList(false); });
  }
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [dSearch]);

  // Cargar cajas (metodos_pago) una vez para alimentar el selector inline.
  useEffect(() => {
    cajasApi.listCajas()
      .then(r => setCajas((r || []).filter(c => c.activo !== false)))
      .catch(() => setCajas([]));
  }, []);

  useEffect(() => {
    if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
  }, [list]); // eslint-disable-line

  // ── Cargar movimientos (paginado con "ver más") ──
  useEffect(() => {
    if (!selectedId) { setMovs([]); return; }
    setLoadingMovs(true);
    setMovs([]);
    provApi.movimientos(selectedId, { page: 1, limit: 100 })
      .then(r => { setMovs(r.data || []); setMovsPag(r.pagination || { page: 1, pages: 1, total: 0 }); })
      .catch(console.error)
      .finally(() => setLoadingMovs(false));
  }, [selectedId]);

  function loadMasMovs() {
    if (!selectedId || loadingMasMovs) return;
    setLoadingMasMovs(true);
    provApi.movimientos(selectedId, { page: movsPag.page + 1, limit: 100 })
      .then(r => { setMovs(prev => [...prev, ...(r.data || [])]); setMovsPag(r.pagination || movsPag); })
      .catch(console.error)
      .finally(() => setLoadingMasMovs(false));
  }

  useEffect(() => {
    setPrimaryAction({
      label: 'Nuevo proveedor',
      onClick: () => { setEditId(null); setProvForm(EMPTY_PROV()); setProvError(''); setShowProv(true); },
    });
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]); // eslint-disable-line

  const selected = useMemo(() => list.find(p => p.id === selectedId) || null, [list, selectedId]);

  // ── KPIs del proveedor seleccionado ──
  const kpis = useMemo(() => {
    const totalCompras = movs
      .filter(m => m.tipo === 'compra')
      .reduce((s, m) => s + Number(m.monto_usd || 0), 0);
    return {
      saldo: selected ? Number(selected.saldo_usd || 0) : 0,
      totalCompras,
      cantMovimientos: movs.length,
    };
  }, [movs, selected]);

  function openCreateProv() {
    setEditId(null); setProvForm(EMPTY_PROV()); setProvError(''); setShowProv(true);
  }
  function openEditProv(p) {
    setEditId(p.id);
    setProvForm({
      nombre: p.nombre || '', contacto_nombre: p.contacto_nombre || '',
      contacto_apellido: p.contacto_apellido || '', whatsapp: p.whatsapp || '',
      ubicacion: p.ubicacion || '', notas: p.notas || '',
      saldo_inicial: Number(p.saldo_inicial) > 0 ? String(Number(p.saldo_inicial)) : '',
    });
    setProvError(''); setShowProv(true);
  }

  async function handleSaveProv() {
    if (!provForm.nombre.trim()) { setProvError('El nombre del proveedor es obligatorio.'); return; }
    setProvSaving(true); setProvError('');
    const base = {
      nombre:            provForm.nombre.trim(),
      contacto_nombre:   provForm.contacto_nombre.trim()   || null,
      contacto_apellido: provForm.contacto_apellido.trim() || null,
      whatsapp:          provForm.whatsapp.trim()          || null,
      ubicacion:         provForm.ubicacion.trim()         || null,
      notas:             provForm.notas.trim()             || null,
    };
    try {
      if (editId) {
        await provApi.update(editId, {
          ...base,
          saldo_inicial: provForm.saldo_inicial === '' ? 0 : Number(provForm.saldo_inicial),
        });
        toast.success('Proveedor actualizado.');
        loadList();                  // refresca saldo (el saldo inicial pudo cambiar)
        reloadMovs();                // refresca la planilla del proveedor seleccionado
      } else {
        const nuevo = await provApi.create({ ...base, saldo_inicial: provForm.saldo_inicial ? Number(provForm.saldo_inicial) : null });
        setList(prev => [nuevo, ...prev]);
        setSelectedId(nuevo.id);
      }
      setShowProv(false);
    } catch (e) { setProvError(e.message || 'No se pudo guardar el proveedor.'); }
    finally { setProvSaving(false); }
  }

  async function handleDeleteProv(p) {
    const ok = await confirm({
      title: 'Eliminar proveedor',
      message: `¿Eliminar "${p.nombre}"? Se ocultará junto con sus movimientos.`,
      confirmLabel: 'Eliminar', danger: true,
    });
    if (!ok) return;
    try {
      await provApi.delete(p.id);
      toast.success('Proveedor eliminado.');
      if (selectedId === p.id) { setSelectedId(null); setMovs([]); }
      setList(prev => prev.filter(x => x.id !== p.id));
    } catch (e) { toast.error(e.message); }
  }

  function reloadMovs() {
    if (!selectedId) return;
    provApi.movimientos(selectedId, { page: 1, limit: 100 })
      .then(r => { setMovs(r.data || []); setMovsPag(r.pagination || { page: 1, pages: 1, total: 0 }); })
      .catch(console.error);
    provApi.list(search ? { buscar: search } : {}).then(r => setList(r?.data || [])).catch(console.error);
  }

  // ── Modal de compra (reemplaza la planilla inline) ─────────────────────
  const [showCompra, setShowCompra] = useState(false);
  // ── Modal de pago simple (caja + monto + tc opcional + notas) ──────────
  const [showPago, setShowPago] = useState(false);
  const [pagoForm, setPagoForm] = useState({ fecha: todayISO(), caja_id: '', monto: '', tc: '', notas: '' });
  const [pagoSaving, setPagoSaving] = useState(false);

  function openPago() {
    setPagoForm({ fecha: todayISO(), caja_id: '', monto: '', tc: '', notas: '' });
    setShowPago(true);
  }
  async function savePago() {
    if (!pagoForm.caja_id) { toast.error('Elegí una caja para registrar el pago'); return; }
    if (!Number(pagoForm.monto) || Number(pagoForm.monto) <= 0) { toast.error('Cargá el monto'); return; }
    const caja = cajas.find(c => String(c.id) === String(pagoForm.caja_id));
    const moneda = caja?.moneda || 'USD';
    if (moneda !== 'USD' && (!Number(pagoForm.tc) || Number(pagoForm.tc) <= 0)) {
      toast.error(`Cargá el TC para convertir ${moneda} → USD`); return;
    }
    setPagoSaving(true);
    try {
      await provApi.createMovimiento({
        proveedor_id: selectedId,
        fecha: pagoForm.fecha,
        tipo: 'pago',
        monto: Number(pagoForm.monto),
        moneda,
        tc: moneda === 'USD' ? null : Number(pagoForm.tc),
        caja_id: Number(pagoForm.caja_id),
        notas: pagoForm.notas.trim() || null,
      });
      toast.success('Pago registrado');
      setShowPago(false);
      reloadMovs();
      // refrescar la lista para actualizar saldo
      provApi.list(dSearch ? { buscar: dSearch } : {}).then(r => setList(r?.data || []));
    } catch (e) {
      toast.error(e.message || 'No se pudo guardar el pago');
    } finally {
      setPagoSaving(false);
    }
  }

  // Callback del modal de compra: refresca movs y lista (saldo).
  function handleCompraSaved() {
    reloadMovs();
    provApi.list(dSearch ? { buscar: dSearch } : {}).then(r => setList(r?.data || []));
  }

  async function handleDeleteMov(m) {
    const ok = await confirm({
      title: 'Eliminar movimiento', message: 'Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar', danger: true,
    });
    if (!ok) return;
    try {
      await provApi.deleteMovimiento(m.id);
      reloadMovs();
      toast.success('Movimiento eliminado.');
    } catch (e) { toast.error(e.message); }
  }

  const filtered = list;

  // Orden ASC (cronológico, como un libro mayor) — fila nueva al pie
  const movimientos = [...movs].reverse();
  const cell = { padding: '7px 8px', fontSize: 13 };

  // Inyectamos el proveedor seleccionado en las filas inline vía clave (remount)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Page head */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Proveedores | Compras</h1>
          <div className="page-sub">Cuentas por pagar · registro tipo planilla</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openCreateProv}>
            <Icons.Plus size={14} /> Nuevo proveedor
          </button>
        </div>
      </div>

      {/* Split layout */}
      <div style={{
        display: 'grid', gridTemplateColumns: '240px 1fr',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, overflow: 'hidden', flex: 1, minHeight: 580,
      }}>

        {/* ── Sidebar ── */}
        <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
            <div className="input-group">
              <span className="addon addon-l"><Icons.Search size={13} /></span>
              <input className="input" placeholder="Buscar…" value={search}
                onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {loadingList ? (
              <div className="empty">Cargando…</div>
            ) : filtered.length === 0 ? (
              <div className="empty">Sin proveedores</div>
            ) : filtered.map((p, i) => (
              <div key={p.id} onClick={() => setSelectedId(p.id)} style={{
                padding: '10px 13px',
                borderBottom: i < filtered.length - 1 ? '1px solid var(--hairline)' : 0,
                cursor: 'pointer',
                background: selectedId === p.id ? 'var(--surface-2)' : 'transparent',
                borderLeft: selectedId === p.id ? '3px solid var(--accent)' : '3px solid transparent',
              }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 3 }}>{p.nombre}</div>
                {(p.ubicacion || p.contacto_nombre) && (
                  <div className="muted tiny" style={{ marginBottom: 3 }}>
                    {[
                      [p.contacto_nombre, p.contacto_apellido].filter(Boolean).join(' '),
                      p.ubicacion,
                    ].filter(Boolean).join(' · ')}
                  </div>
                )}
                <div className="mono" style={{
                  fontSize: 13, fontWeight: 700,
                  color: Number(p.saldo_usd) > 0 ? 'var(--neg)' : Number(p.saldo_usd) < 0 ? 'var(--pos)' : 'var(--text-muted)',
                }}>
                  {Number(p.saldo_usd) !== 0 ? fmtUSD(p.saldo_usd) : 'Sin saldo'}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Panel derecho ── */}
        {!selected ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Seleccioná un proveedor
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>

            {/* ── Header del proveedor con KPIs inline ── */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div className="flex-between" style={{ marginBottom: 4 }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>
                    {selected.nombre}
                  </div>
                  {([selected.contacto_nombre, selected.contacto_apellido].filter(Boolean).join(' ') || selected.whatsapp || selected.ubicacion) && (
                    <div className="muted tiny" style={{ marginTop: 2 }}>
                      {[
                        [selected.contacto_nombre, selected.contacto_apellido].filter(Boolean).join(' '),
                        selected.whatsapp,
                        selected.ubicacion,
                      ].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>

                <div className="flex-row" style={{ gap: 20, alignItems: 'flex-start' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div className="muted tiny">Saldo</div>
                    <div className={'mono ' + (kpis.saldo > 0 ? 'neg' : kpis.saldo < 0 ? 'pos' : 'muted')}
                      style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.1 }}>
                      USD {fmt(kpis.saldo)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="muted tiny">Total comprado</div>
                    <div className="mono" style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.1 }}>
                      USD {fmt(kpis.totalCompras)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="muted tiny">Movimientos</div>
                    <div className="mono" style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.1 }}>
                      {kpis.cantMovimientos}
                    </div>
                  </div>
                  <button className="icon-btn" title="Editar proveedor" onClick={() => openEditProv(selected)}>
                    <Icons.Edit size={15} />
                  </button>
                  <button className="icon-btn" title="Eliminar proveedor" onClick={() => handleDeleteProv(selected)}>
                    <Icons.Trash size={15} />
                  </button>
                </div>
              </div>
              <div className="flex-row" style={{ gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                <button className="btn btn-sm" onClick={openPago}>
                  <Icons.Dollar size={13} /> Registrar pago
                </button>
                <button className="btn btn-sm btn-primary" onClick={() => setShowCompra(true)}>
                  <Icons.Plus size={13} /> Cargar compra
                </button>
              </div>
            </div>

            {/* ── Tabla spreadsheet ── */}
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
              <table style={{
                width: '100%', borderCollapse: 'collapse',
                tableLayout: 'fixed', minWidth: 860,
                fontSize: 13,
              }}>
                <colgroup>
                  <col style={{ width: 88  }} />{/* Fecha        */}
                  <col style={{ width: 108 }} />{/* Tipo         */}
                  <col style={{ width: 90  }} />{/* Producto     */}
                  <col style={{ width: 130 }} />{/* Modelo       */}
                  <col style={{ width: 66  }} />{/* Cap.         */}
                  <col style={{ width: 76  }} />{/* Color        */}
                  <col style={{ width: 130 }} />{/* IMEI/Serial  */}
                  <col style={{ width: 94  }} />{/* Monto USD    */}
                  <col style={{ width: 30  }} />{/* ✓            */}
                  <col style={{ width: 48  }} />{/* Acción       */}
                </colgroup>

                <thead>
                  <tr style={{ background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 1 }}>
                    {['Fecha', 'Tipo', 'Producto', 'Modelo', 'Cap.', 'Color', 'IMEI / Serial', 'Caja', 'Monto USD', '✓', ''].map((h, i) => (
                      <th key={i} style={{
                        padding: '7px 8px', fontSize: 11, fontWeight: 700,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        color: 'var(--text-muted)', textAlign: i === 8 ? 'right' : 'left',
                        borderBottom: '1px solid var(--border)',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {movimientos.length === 0 && !loadingMovs && (
                    <tr>
                      <td colSpan={11} style={{ padding: '24px 16px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
                        Sin movimientos — completá la fila azul para agregar el primero
                      </td>
                    </tr>
                  )}

                  {movimientos.map(m => {
                    const t    = TIPO_DISPLAY[m.tipo] || { label: m.tipo, tone: 'default', signo: 1 };
                    const item = m.items?.[0];
                    const extra = m.items?.length > 1 ? ` +${m.items.length - 1}` : '';
                    return (
                      <tr key={m.id} style={{ borderBottom: '1px solid var(--hairline)', opacity: m._pending ? 0.55 : 1 }}>
                        <td style={cell} className="muted mono">{fmtFecha(m.fecha)}</td>
                        <td style={cell}><Status tone={t.tone}>{t.label}</Status></td>
                        <td style={cell}>
                          {item?.producto
                            ? <>{item.producto}<span className="muted tiny">{extra}</span></>
                            : (m.descripcion || <span className="dim">—</span>)
                          }
                        </td>
                        <td style={{ ...cell, color: 'var(--text-2)' }}>
                          {item?.modelo || <span className="dim">—</span>}
                        </td>
                        <td style={{ ...cell, color: 'var(--text-2)' }}>
                          {item?.tamano || <span className="dim">—</span>}
                        </td>
                        <td style={{ ...cell, color: 'var(--text-2)' }}>
                          {item?.color || <span className="dim">—</span>}
                        </td>
                        <td style={{ ...cell, fontFamily: 'monospace', fontSize: 12 }}>
                          {item?.imei_serial || <span className="dim">—</span>}
                        </td>
                        <td style={{ ...cell, fontSize: 12 }}>
                          {m.caja_nombre
                            ? <span title="Movimiento de contado: descontó esta caja">{m.caja_nombre}</span>
                            : <span className="dim" title="A crédito (suma deuda)">CC</span>}
                        </td>
                        <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>
                          <span className={t.tone === 'neg' ? 'neg' : 'pos'}>
                            {t.signo > 0 ? '+' : '−'}USD {fmt(m.monto_usd)}
                          </span>
                        </td>
                        <td style={{ ...cell, textAlign: 'center' }}>
                          {item?.verificado
                            ? <span style={{ color: 'var(--pos)', fontSize: 14 }}>✓</span>
                            : <span className="dim" style={{ fontSize: 11 }}>—</span>}
                        </td>
                        <td style={{ padding: '7px 6px' }}>
                          {!m._pending && (
                            <button className="icon-btn" title="Eliminar" onClick={() => handleDeleteMov(m)}>
                              <Icons.Trash size={13} />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {movsPag.page < movsPag.pages && (
                    <tr>
                      <td colSpan={11} style={{ textAlign: 'center', padding: '8px' }}>
                        <button className="btn btn-ghost btn-sm" onClick={loadMasMovs} disabled={loadingMasMovs}>
                          {loadingMasMovs ? 'Cargando…' : `Ver movimientos más antiguos (${movs.length} de ${movsPag.total})`}
                        </button>
                      </td>
                    </tr>
                  )}

                  {/* La planilla inline fue reemplazada por los modales
                       "Cargar compra" y "Pagar". Mantenemos un placeholder
                       discreto al pie para guiar al usuario.                */}
                  <tr>
                    <td colSpan={11} style={{ padding: '12px 16px', textAlign: 'center', borderTop: '1px dashed var(--border)' }}>
                      <span className="muted tiny">
                        Para sumar una compra (con stock) o registrar un pago, usá los botones de arriba.
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Nuevo proveedor */}
      {showProv && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowProv(false)}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-hd">
              <h3>{editId ? 'Editar proveedor' : 'Nuevo proveedor'}</h3>
              <button className="icon-btn" onClick={() => setShowProv(false)}><Icons.X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="stack" style={{ gap: 12 }}>
                <div className="field">
                  <label className="field-label">Proveedor <span style={{ color: 'var(--neg)' }}>*</span></label>
                  <input type="text" className="input" placeholder="Ej: Mayorista Apple SRL" autoFocus
                    value={provForm.nombre} onChange={e => setProvForm(f => ({ ...f, nombre: e.target.value }))} />
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Contacto (nombre)</label>
                    <input type="text" className="input" placeholder="Ej: Juan"
                      value={provForm.contacto_nombre} onChange={e => setProvForm(f => ({ ...f, contacto_nombre: e.target.value }))} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Contacto (apellido)</label>
                    <input type="text" className="input" placeholder="Ej: García"
                      value={provForm.contacto_apellido} onChange={e => setProvForm(f => ({ ...f, contacto_apellido: e.target.value }))} />
                  </div>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">WhatsApp</label>
                    <input type="text" className="input" placeholder="+54 9 11 …"
                      value={provForm.whatsapp} onChange={e => setProvForm(f => ({ ...f, whatsapp: e.target.value }))} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Ubicación</label>
                    <input type="text" className="input" placeholder="Ej: Miami / CABA"
                      value={provForm.ubicacion} onChange={e => setProvForm(f => ({ ...f, ubicacion: e.target.value }))} />
                  </div>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Notas internas</label>
                    <input type="text" className="input" placeholder="Ej: paga a 30 días"
                      value={provForm.notas} onChange={e => setProvForm(f => ({ ...f, notas: e.target.value }))} />
                  </div>
                  <div className="field" style={{ width: 160 }}>
                    <label className="field-label">Saldo inicial (USD)</label>
                    <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01" className="input" placeholder="0"
                      value={provForm.saldo_inicial} onChange={e => setProvForm(f => ({ ...f, saldo_inicial: e.target.value }))} />
                    <div className="muted tiny" style={{ marginTop: 4 }}>{editId ? 'Ajusta la apertura (0 = sin saldo inicial).' : 'Lo que ya le debés (opcional).'}</div>
                  </div>
                </div>
                {provError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{provError}</div>}
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-ghost" onClick={() => setShowProv(false)} disabled={provSaving}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleSaveProv} disabled={provSaving}>
                {provSaving ? 'Guardando…' : (editId ? 'Guardar cambios' : 'Crear proveedor')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Cargar Compra ── */}
      {showCompra && selected && (
        <CompraProveedorModal
          proveedor={selected}
          onClose={() => setShowCompra(false)}
          onSaved={handleCompraSaved}
        />
      )}

      {/* ── Modal Pago (simple) ── */}
      {showPago && selected && (
        <div className="modal-overlay" onClick={() => setShowPago(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Registrar pago · {selected.nombre}</h3>
              <button className="icon-btn" onClick={() => setShowPago(false)}><Icons.X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="row">
                <div className="field" style={{ flex: '0 0 150px' }}>
                  <label className="field-label">Fecha</label>
                  <input type="date" className="input" value={pagoForm.fecha}
                    onChange={e => setPagoForm(f => ({ ...f, fecha: e.target.value }))} />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">Pagar con <span style={{ color: 'var(--neg)' }}>*</span></label>
                  <select className="input" value={pagoForm.caja_id}
                    onChange={e => setPagoForm(f => ({ ...f, caja_id: e.target.value }))}>
                    <option value="">— Elegí caja —</option>
                    {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>)}
                    <CajaSelectHint />
                  </select>
                </div>
              </div>
              {(() => {
                const cajaSel = cajas.find(c => String(c.id) === String(pagoForm.caja_id));
                const monedaSel = cajaSel?.moneda || 'USD';
                return (
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Monto ({monedaSel}) <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono"
                        value={pagoForm.monto} placeholder="0"
                        onChange={e => setPagoForm(f => ({ ...f, monto: e.target.value }))} />
                    </div>
                    {monedaSel !== 'USD' && (
                      <div className="field" style={{ flex: '0 0 140px' }}>
                        <label className="field-label">TC {monedaSel}→USD <span style={{ color: 'var(--neg)' }}>*</span></label>
                        <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01" className="input mono"
                          value={pagoForm.tc}
                          onChange={e => setPagoForm(f => ({ ...f, tc: e.target.value }))} />
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className="field">
                <label className="field-label">Notas (opcional)</label>
                <input className="input" value={pagoForm.notas}
                  onChange={e => setPagoForm(f => ({ ...f, notas: e.target.value }))}
                  placeholder="Ej. Transferencia BBVA #5612" />
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-ghost" onClick={() => setShowPago(false)} disabled={pagoSaving}>Cancelar</button>
              <button className="btn btn-primary" onClick={savePago} disabled={pagoSaving}>
                {pagoSaving ? 'Guardando…' : 'Registrar pago'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useMemo, useRef } from 'react';
import { Icons } from '../components/Icons';
import { proveedores as provApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmt(n) {
  return Math.round(Math.abs(Number(n))).toLocaleString('es-AR');
}
function fmtUSD(n) { return 'USD ' + fmt(n); }
function fmtFecha(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function todayISO() { return new Date().toLocaleDateString('sv'); }

const TIPO_DISPLAY = {
  compra:        { label: 'Compra',        tone: 'neg',     signo: +1 },
  pago:          { label: 'Pago',          tone: 'pos',     signo: -1 },
  saldo_inicial: { label: 'Saldo inicial', tone: 'default', signo: +1 },
};

function Status({ tone = 'default', children }) {
  return <span className={`status s-${tone}`}>{children}</span>;
}

// ─── Datalists para desplegables de producto ─────────────────────────────────

const PROV_DATALISTS = (
  <>
    <datalist id="prov-dl-producto">
      <option value="iPhone" />
      <option value="MacBook Air" />
      <option value="MacBook Pro" />
      <option value="Neo" />
      <option value="AirPods" />
      <option value="Apple Watch" />
      <option value="iPad" />
      <option value="AirTag" />
      <option value="RayBan Meta" />
      <option value="Cargador" />
      <option value="SuperHub" />
      <option value="Accesorios" />
      <option value="PS 5" />
      <option value="Nintendo" />
      <option value="XBox" />
      <option value="Pencil" />
      <option value="Samsung" />
    </datalist>
    <datalist id="prov-dl-modelo">
      <option value="16 Pro Max" /><option value="16 Pro" /><option value="16 Plus" /><option value="16" />
      <option value="15 Pro Max" /><option value="15 Pro" /><option value="15 Plus" /><option value="15" />
      <option value="14 Pro Max" /><option value="14 Pro" /><option value="14 Plus" /><option value="14" />
      <option value="13 Pro Max" /><option value="13 Pro" /><option value="13" />
      <option value="SE (3ra gen)" />
      <option value="S25 Ultra" /><option value="S25+" /><option value="S25" />
      <option value="S24 Ultra" /><option value="S24+" /><option value="S24" />
      <option value="A55" /><option value="A35" /><option value="A15" />
      <option value="Pro 11 M4" /><option value="Pro 13 M4" /><option value="Air M2" />
      <option value="Air 13 M3" /><option value="Mini 7" />
    </datalist>
    <datalist id="prov-dl-tamano">
      <option value="64GB" />
      <option value="128GB" />
      <option value="256GB" />
      <option value="512GB" />
      <option value="1TB" />
      <option value="2TB" />
      <option value="825GB" />
      <option value="S/D" />
    </datalist>
    <datalist id="prov-dl-color">
      <option value="Negro" /><option value="Blanco" /><option value="Azul" />
      <option value="Rosa" /><option value="Verde" /><option value="Rojo" />
      <option value="Dorado" /><option value="Plateado" /><option value="Violeta" />
      <option value="Natural Titanium" /><option value="Desert Titanium" />
      <option value="Black Titanium" /><option value="White Titanium" />
      <option value="Grafito" /><option value="Medianoche" /><option value="Blanco Estelar" />
    </datalist>
  </>
);

// ─── INLINE ADD ROWS (planilla — 5 filas siempre visibles) ───────────────────
// Compra → columnas de producto completas + monto USD.
// Pago   → solo monto USD.
// Tab en último campo → guarda y pasa a la siguiente fila.
// Enter en el campo de monto → guarda esa fila.

const ROW_COUNT  = 5;

const mkRow = (prev = null) => ({
  _id:         Math.random().toString(36).slice(2),
  fecha:       prev?.fecha || todayISO(),
  tipo:        prev?.tipo  || 'compra',
  producto: '', modelo: '', tamano: '', color: '', imei_serial: '',
  verificado: false,
  monto: '',
});

function InlineAddRows({ proveedorId, onSave, onSaveDone, onSaveError }) {
  const [rows, setRows] = useState(() => Array.from({ length: ROW_COUNT }, () => mkRow()));

  const cr = useRef({});
  const setRef    = (i, col) => el => { cr.current[`${i}_${col}`] = el; };
  const focusCell = (i, col) => cr.current[`${i}_${col}`]?.focus();

  function upd(i, field, val) {
    setRows(rs => rs.map((r, idx) => {
      if (idx !== i) return r;
      const next = { ...r, [field]: val };
      // Cambio de tipo → limpia campos de producto si pasa a pago
      if (field === 'tipo' && val === 'pago') {
        next.producto = ''; next.modelo = ''; next.tamano = '';
        next.color = ''; next.imei_serial = ''; next.verificado = false;
      }
      return next;
    }));
  }

  function saveRow(i) {
    const row = rows[i];
    if (!row.monto || Number(row.monto) <= 0) return;

    const tempId   = `_tmp_${Date.now()}_${i}`;
    const isCompra = row.tipo === 'compra';
    const itemData = {
      producto: row.producto || null, modelo: row.modelo || null,
      tamano: row.tamano || null,     color: row.color || null,
      imei_serial: row.imei_serial || null,
      valor: Number(row.monto),       verificado: row.verificado,
    };

    // 1. Reset inmediato → usuario puede seguir sin esperar
    setRows(rs => rs.map((r, idx) =>
      idx === i ? mkRow({ fecha: r.fecha, tipo: r.tipo }) : r
    ));
    setTimeout(() => focusCell((i + 1) % ROW_COUNT, 'first'), 20);

    // 2. Actualización optimista instantánea en la lista
    onSave({
      id: tempId, _pending: true,
      fecha: row.fecha, tipo: row.tipo,
      monto_usd: Number(row.monto), descripcion: null, notas: null,
      items: isCompra ? [{ id: `${tempId}_item`, ...itemData }] : [],
    });

    // 3. API en segundo plano — no bloquea la UI
    provApi.createMovimiento({
      proveedor_id: proveedorId,
      fecha: row.fecha, tipo: row.tipo, monto: Number(row.monto), moneda: 'USD',
      items: isCompra ? [itemData] : [],
    })
    .then(real => onSaveDone(tempId, real))
    .catch(err  => onSaveError(tempId, err.message || 'Error al guardar'));
  }

  function handleLastKey(e, i) {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const row = rows[i];
    if (row.monto && Number(row.monto) > 0) saveRow(i);
    else focusCell((i + 1) % ROW_COUNT, 'first');
  }

  const inp = {
    padding: '4px 7px', fontSize: 13, height: 30,
    border: '1px solid var(--border)', background: 'var(--surface)',
    color: 'var(--text)', borderRadius: 5, width: '100%',
    outline: 'none', boxSizing: 'border-box',
  };

  return (
    <>
      {rows.map((row, i) => {
        const isPago = row.tipo === 'pago';
        return (
          <tr key={row._id} style={{
            background: 'rgba(99,102,241,0.04)',
            borderTop: i === 0 ? '2px solid var(--accent)' : '1px solid var(--hairline)',
          }}>

            {/* Fecha */}
            <td style={{ padding: '4px 5px' }}>
              <input type="date" style={inp}
                value={row.fecha}
                onChange={e => upd(i, 'fecha', e.target.value)} />
            </td>

            {/* Tipo */}
            <td style={{ padding: '4px 5px' }}>
              <select style={{ ...inp, cursor: 'pointer' }}
                value={row.tipo}
                onChange={e => upd(i, 'tipo', e.target.value)}>
                <option value="compra">+ Compra</option>
                <option value="pago">− Pago</option>
              </select>
            </td>

            {isPago ? (
              /* ── Pago: solo monto USD ─────────────────────────────────── */
              <td colSpan={5} style={{ padding: '4px 12px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--pos)', whiteSpace: 'nowrap' }}>USD</span>
                  <input
                    ref={setRef(i, 'first')}
                    type="number" min="0"
                    style={{ ...inp, maxWidth: 200, textAlign: 'right', fontWeight: 700 }}
                    placeholder="0"
                    value={row.monto}
                    onChange={e => upd(i, 'monto', e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); saveRow(i); }
                      else handleLastKey(e, i);
                    }}
                  />
                  <span className="muted tiny" style={{ whiteSpace: 'nowrap' }}>pago al proveedor</span>
                </div>
              </td>
            ) : (
              /* ── Compra: columnas de producto ─────────────────────────── */
              <>
                <td style={{ padding: '4px 5px' }}>
                  <input ref={setRef(i, 'first')} list="prov-dl-producto" style={inp} placeholder="iPhone"
                    value={row.producto}
                    onChange={e => upd(i, 'producto', e.target.value)} />
                </td>
                <td style={{ padding: '4px 5px' }}>
                  <input list="prov-dl-modelo" style={inp} placeholder="16 Pro Max"
                    value={row.modelo}
                    onChange={e => upd(i, 'modelo', e.target.value)} />
                </td>
                <td style={{ padding: '4px 5px' }}>
                  <input list="prov-dl-tamano" style={inp} placeholder="256GB"
                    value={row.tamano}
                    onChange={e => upd(i, 'tamano', e.target.value)} />
                </td>
                <td style={{ padding: '4px 5px' }}>
                  <input list="prov-dl-color" style={inp} placeholder="Negro"
                    value={row.color}
                    onChange={e => upd(i, 'color', e.target.value)} />
                </td>
                <td style={{ padding: '4px 5px' }}>
                  <input style={{ ...inp, fontFamily: 'monospace', fontSize: 12 }}
                    placeholder="358123…"
                    value={row.imei_serial}
                    onChange={e => upd(i, 'imei_serial', e.target.value)} />
                </td>
              </>
            )}

            {/* Monto USD */}
            {!isPago && (
              <td style={{ padding: '4px 5px' }}>
                <input
                  ref={setRef(i, 'monto')}
                  type="number" min="0"
                  style={{ ...inp, textAlign: 'right', fontWeight: 700 }}
                  placeholder="0"
                  value={row.monto}
                  onChange={e => upd(i, 'monto', e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); saveRow(i); }
                    else handleLastKey(e, i);
                  }}
                />
              </td>
            )}

            {/* Verificado */}
            <td style={{ padding: '4px 8px', textAlign: 'center' }}>
              {!isPago && (
                <input type="checkbox"
                  checked={row.verificado}
                  onChange={e => upd(i, 'verificado', e.target.checked)}
                  onKeyDown={e => handleLastKey(e, i)}
                />
              )}
            </td>

            {/* Acción */}
            <td />
          </tr>
        );
      })}
    </>
  );
}

// ─── MAIN SCREEN ──────────────────────────────────────────────────────────────

const EMPTY_PROV = () => ({
  nombre: '', contacto_nombre: '', contacto_apellido: '', whatsapp: '', ubicacion: '', notas: '', saldo_inicial: '',
});

export default function Proveedores() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  const [search, setSearch]   = useState('');
  const [list, setList]       = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [movs, setMovs]       = useState([]);
  const [loadingList, setLoadingList]   = useState(true);
  const [loadingMovs, setLoadingMovs]   = useState(false);

  const [showProv, setShowProv]   = useState(false);
  const [provForm, setProvForm]   = useState(EMPTY_PROV);
  const [provSaving, setProvSaving] = useState(false);
  const [provError, setProvError] = useState('');

  // ── Cargar lista ──
  function loadList() {
    setLoadingList(true);
    provApi.list(search ? { buscar: search } : {})
      .then(r => setList(r || [])).catch(console.error)
      .finally(() => setLoadingList(false));
  }
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [search]);

  useEffect(() => {
    if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
  }, [list]); // eslint-disable-line

  // ── Cargar movimientos ──
  useEffect(() => {
    if (!selectedId) { setMovs([]); return; }
    setLoadingMovs(true);
    setMovs([]);
    provApi.movimientos(selectedId)
      .then(r => setMovs(r || [])).catch(console.error)
      .finally(() => setLoadingMovs(false));
  }, [selectedId]);

  useEffect(() => {
    setPrimaryAction({
      label: 'Nuevo proveedor',
      onClick: () => { setProvForm(EMPTY_PROV()); setProvError(''); setShowProv(true); },
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

  async function handleCreateProv() {
    if (!provForm.nombre.trim()) { setProvError('El nombre del proveedor es obligatorio.'); return; }
    setProvSaving(true); setProvError('');
    try {
      const nuevo = await provApi.create({
        nombre:            provForm.nombre.trim(),
        contacto_nombre:   provForm.contacto_nombre.trim()   || null,
        contacto_apellido: provForm.contacto_apellido.trim() || null,
        whatsapp:          provForm.whatsapp.trim()          || null,
        ubicacion:         provForm.ubicacion.trim()         || null,
        notas:             provForm.notas.trim()             || null,
        saldo_inicial:     provForm.saldo_inicial ? Number(provForm.saldo_inicial) : null,
      });
      setList(prev => [nuevo, ...prev]);
      setSelectedId(nuevo.id);
      setShowProv(false);
    } catch (e) { setProvError(e.message || 'No se pudo crear el proveedor.'); }
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
    provApi.movimientos(selectedId).then(r => setMovs(r || [])).catch(console.error);
    provApi.list(search ? { buscar: search } : {}).then(r => setList(r || [])).catch(console.error);
  }

  // ── Handlers optimistas para InlineAddRows ──────────────────────────────
  function handleOptimisticSave(optMov) {
    const signo = TIPO_DISPLAY[optMov.tipo]?.signo ?? 1;
    const delta = signo * Number(optMov.monto_usd);
    optMov._proveedorId = selectedId;
    setMovs(prev => [...prev, optMov]);
    setList(prev => prev.map(p =>
      p.id === selectedId ? { ...p, saldo_usd: Number(p.saldo_usd || 0) + delta } : p
    ));
  }

  function handleSaveDone(tempId, real) {
    setMovs(prev => prev.map(m => m.id === tempId ? real : m));
  }

  function handleSaveError(tempId, errorMsg) {
    toast.error(errorMsg || 'Error al guardar');
    setMovs(prev => {
      const failed = prev.find(m => m.id === tempId);
      if (failed) {
        const signo = TIPO_DISPLAY[failed.tipo]?.signo ?? 1;
        const delta = signo * Number(failed.monto_usd);
        setList(ls => ls.map(p =>
          p.id === selectedId ? { ...p, saldo_usd: Number(p.saldo_usd || 0) - delta } : p
        ));
      }
      return prev.filter(m => m.id !== tempId);
    });
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
          <h1 className="page-title">Proveedores</h1>
          <div className="page-sub">Cuentas por pagar · registro tipo planilla</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary"
            onClick={() => { setProvForm(EMPTY_PROV()); setProvError(''); setShowProv(true); }}>
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
                  <button className="icon-btn" title="Eliminar proveedor" onClick={() => handleDeleteProv(selected)}>
                    <Icons.Trash size={15} />
                  </button>
                </div>
              </div>
            </div>

            {/* ── Tabla spreadsheet ── */}
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
              {PROV_DATALISTS}
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
                    {['Fecha', 'Tipo', 'Producto', 'Modelo', 'Cap.', 'Color', 'IMEI / Serial', 'Monto USD', '✓', ''].map((h, i) => (
                      <th key={i} style={{
                        padding: '7px 8px', fontSize: 11, fontWeight: 700,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        color: 'var(--text-muted)', textAlign: i === 7 ? 'right' : 'left',
                        borderBottom: '1px solid var(--border)',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {movimientos.length === 0 && !loadingMovs && (
                    <tr>
                      <td colSpan={10} style={{ padding: '24px 16px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
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
                        <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>
                          <span className={t.signo > 0 ? 'neg' : 'pos'}>
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

                  {/* ── Fila de entrada inline ── */}
                  <InlineAddRows
                    key={selectedId}
                    onSave={handleOptimisticSave}
                    onSaveDone={handleSaveDone}
                    onSaveError={handleSaveError}
                  />
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
              <h3>Nuevo proveedor</h3>
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
                    <input type="number" min="0" step="0.01" className="input" placeholder="0"
                      value={provForm.saldo_inicial} onChange={e => setProvForm(f => ({ ...f, saldo_inicial: e.target.value }))} />
                    <div className="muted tiny" style={{ marginTop: 4 }}>Lo que ya le debés (opcional).</div>
                  </div>
                </div>
                {provError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{provError}</div>}
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-ghost" onClick={() => setShowProv(false)} disabled={provSaving}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleCreateProv} disabled={provSaving}>
                {provSaving ? 'Guardando…' : 'Crear proveedor'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useMemo, useRef } from 'react';
import { Icons } from '../components/Icons';
import { cuentas } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmt(n) {
  const v = Math.abs(Number(n));
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K';
  return Math.round(v).toLocaleString('es-AR');
}

function fmtARS(n) {
  return 'ARS ' + fmt(n);
}

function fmtFecha(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// ─── Movement type display helpers ───────────────────────────────────────────

const TIPO_DISPLAY = {
  compra:             { label: 'Compra',             tone: 'neg',  signo: +1 },
  pago:               { label: 'Pago',               tone: 'pos',  signo: -1 },
  devolucion:         { label: 'Devolución',          tone: 'pos',  signo: -1 },
  parte_de_pago:      { label: 'Parte de pago',       tone: 'pos',  signo: -1 },
  entrega_mercaderia: { label: 'Entrega mercad.',     tone: 'info', signo: -1 },
};

const CAT_TONE = { 'VIP': 'accent', 'A+': 'pos', 'A-': 'default' };

// ─── Helper components ───────────────────────────────────────────────────────

function Badge({ tone = 'default', dot = false, children }) {
  return (
    <span className={`badge badge-${tone}${dot ? ' dot' : ''}`}>
      {children}
    </span>
  );
}

function Status({ tone = 'default', children }) {
  return <span className={`status s-${tone}`}>{children}</span>;
}

function Seg({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button
          key={o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Movement Creation Modal ──────────────────────────────────────────────────

const TIPOS = [
  { value: 'compra',             label: 'Compra',             signo: '+' },
  { value: 'pago',               label: 'Pago',               signo: '-' },
  { value: 'devolucion',         label: 'Devolución',          signo: '-' },
  { value: 'parte_de_pago',      label: 'Parte de pago',       signo: '-' },
  { value: 'entrega_mercaderia', label: 'Entrega mercadería',  signo: '-' },
];

function MovimientoModal({ clienteId, onClose, onSuccess }) {
  const [tipo, setTipo] = useState('compra');
  const [fecha, setFecha] = useState(new Date().toLocaleDateString('sv'));
  const [monto, setMonto] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [notas, setNotas] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!monto || Number(monto) <= 0) {
      setError('El monto debe ser mayor a 0');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const mov = await cuentas.createMovimiento({
        cliente_cc_id: clienteId,
        fecha,
        tipo,
        descripcion: descripcion || null,
        monto_total: Number(monto),
        notas: notas || null,
        items: [],
      });
      onSuccess(mov);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-hd">
          <h3>Nuevo movimiento</h3>
          <button className="icon-btn" onClick={onClose}>
            <Icons.X size={16} />
          </button>
        </div>
        <div className="modal-body">
          {/* tipo */}
          <div className="field">
            <label className="field-label">Tipo</label>
            <select className="input" value={tipo} onChange={e => setTipo(e.target.value)}>
              {TIPOS.map(t => (
                <option key={t.value} value={t.value}>
                  {t.signo} {t.label}
                </option>
              ))}
            </select>
          </div>
          {/* fecha */}
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label">Fecha</label>
            <input
              type="date"
              className="input"
              value={fecha}
              onChange={e => setFecha(e.target.value)}
            />
          </div>
          {/* monto */}
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label">Monto total (ARS)</label>
            <div className="input-group">
              <span className="addon addon-l">$</span>
              <input
                type="number"
                className="input"
                placeholder="0"
                min="1"
                value={monto}
                onChange={e => setMonto(e.target.value)}
              />
            </div>
          </div>
          {/* descripcion */}
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label">
              Descripción <span className="muted">( opcional)</span>
            </label>
            <input
              type="text"
              className="input"
              placeholder="Ej: iPhone 16 Pro 256GB"
              value={descripcion}
              onChange={e => setDescripcion(e.target.value)}
            />
          </div>
          {/* notas */}
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field-label">
              Notas <span className="muted">(opcional)</span>
            </label>
            <textarea
              className="input"
              rows={2}
              placeholder="Notas internas…"
              value={notas}
              onChange={e => setNotas(e.target.value)}
              style={{ height: 'auto', padding: 8, resize: 'vertical', minHeight: 56 }}
            />
          </div>
          {error && (
            <div style={{ color: 'var(--neg)', fontSize: 13, marginTop: 8 }}>{error}</div>
          )}
        </div>
        <div className="modal-ft">
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar movimiento'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function CuentasCC() {
  const [tab, setTab] = useState('clientes');
  const [catFilter, setCatFilter] = useState('todas');
  const [search, setSearch] = useState('');
  const [clientes, setClientes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [clienteDetail, setClienteDetail] = useState(null); // { resumen, movimientos }
  const [rgData, setRgData] = useState(null);
  const [loadingClientes, setLoadingClientes] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showMovModal, setShowMovModal] = useState(false);

  // ── Nuevo cliente modal state ──
  const EMPTY_CLIENTE = {
    nombre: '', apellido: '', contacto: '', marca_redes: '',
    provincia: '', localidad: '', direccion: '', categoria: 'A-', notas: '',
  };
  const [showClienteModal, setShowClienteModal] = useState(false);
  const [clienteForm, setClienteForm] = useState(EMPTY_CLIENTE);
  const [clienteCreating, setClienteCreating] = useState(false);
  const [clienteError, setClienteError] = useState('');

  const { setPrimaryAction } = usePageActions();

  const notasTimerRef = useRef(null);

  // ── Load clientes list on mount + when catFilter changes ──
  useEffect(() => {
    setLoadingClientes(true);
    const params = {};
    if (catFilter !== 'todas') params.categoria = catFilter;
    cuentas
      .clientes(params)
      .then(setClientes)
      .catch(console.error)
      .finally(() => setLoadingClientes(false));
  }, [catFilter]);

  // ── Auto-select first client when list loads ──
  useEffect(() => {
    if (clientes.length > 0 && !selectedId) {
      setSelectedId(clientes[0].id);
    }
  }, [clientes]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load client detail when selectedId changes ──
  useEffect(() => {
    if (!selectedId) return;
    setLoadingDetail(true);
    setClienteDetail(null);
    Promise.all([
      cuentas.resumen(selectedId),
      cuentas.movimientos(selectedId),
    ])
      .then(([resumen, movimientos]) => {
        setClienteDetail({ resumen, movimientos });
      })
      .catch(console.error)
      .finally(() => setLoadingDetail(false));
  }, [selectedId]);

  // ── Load resumen general when tab switches ──
  useEffect(() => {
    if (tab !== 'resumen') return;
    cuentas.resumenGeneral().then(setRgData).catch(console.error);
  }, [tab]);

  // ── Client-side search filter (instant) ──
  const filtered = useMemo(() => {
    if (!search) return clientes;
    const q = search.toLowerCase();
    return clientes.filter(c =>
      (
        c.nombre +
        ' ' +
        (c.apellido || '') +
        ' ' +
        (c.contacto || '') +
        ' ' +
        (c.marca_redes || '')
      )
        .toLowerCase()
        .includes(q)
    );
  }, [clientes, search]);

  // ── Notes autosave ──
  function handleNotasChange(val) {
    setClienteDetail(prev =>
      prev
        ? {
            ...prev,
            resumen: {
              ...prev.resumen,
              cliente: { ...prev.resumen.cliente, notas: val },
            },
          }
        : prev
    );

    clearTimeout(notasTimerRef.current);
    const id = selectedId;
    notasTimerRef.current = setTimeout(async () => {
      try {
        await cuentas.updateCliente(id, { notas: val || null });
        setClientes(prev => prev.map(c => (c.id === id ? { ...c, notas: val } : c)));
      } catch (e) {
        console.warn('notas autosave:', e);
      }
    }, 700);
  }

  // ── Register global + button action ──
  useEffect(() => {
    setPrimaryAction({
      label: 'Nuevo cliente',
      onClick: () => {
        setClienteForm(EMPTY_CLIENTE);
        setClienteError('');
        setShowClienteModal(true);
      },
    });
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Create cliente handler ──
  async function handleCreateCliente() {
    if (!clienteForm.nombre.trim()) {
      setClienteError('El nombre es obligatorio.');
      return;
    }
    if (!clienteForm.categoria) {
      setClienteError('La categoría es obligatoria.');
      return;
    }
    setClienteCreating(true);
    setClienteError('');
    try {
      const nuevo = await cuentas.createCliente({
        nombre: clienteForm.nombre.trim(),
        apellido: clienteForm.apellido.trim() || null,
        contacto: clienteForm.contacto.trim() || null,
        marca_redes: clienteForm.marca_redes.trim() || null,
        provincia: clienteForm.provincia.trim() || null,
        localidad: clienteForm.localidad.trim() || null,
        direccion: clienteForm.direccion.trim() || null,
        categoria: clienteForm.categoria,
        notas: clienteForm.notas.trim() || null,
      });
      setClientes(prev => [nuevo, ...prev]);
      setSelectedId(nuevo.id);
      setShowClienteModal(false);
    } catch (e) {
      setClienteError(e.message || 'Error al crear el cliente.');
      setClienteCreating(false);
    }
  }

  // ── Reload detail helper ──
  function reloadDetail() {
    if (!selectedId) return;
    setLoadingDetail(true);
    Promise.all([
      cuentas.resumen(selectedId),
      cuentas.movimientos(selectedId),
    ])
      .then(([resumen, movimientos]) => {
        setClienteDetail({ resumen, movimientos });
        setClientes(prev =>
          prev.map(c => (c.id === selectedId ? { ...c, saldo: resumen.saldo } : c))
        );
      })
      .catch(console.error)
      .finally(() => setLoadingDetail(false));
  }

  // ── Delete movement ──
  async function handleDeleteMovimiento(movId) {
    if (!confirm('¿Eliminar este movimiento?')) return;
    try {
      await cuentas.deleteMovimiento(movId);
      reloadDetail();
    } catch (e) {
      alert(e.message);
    }
  }

  // ── Category badge helper ──
  function catBadge(cat) {
    const tone = CAT_TONE[cat] || 'default';
    return <Badge tone={tone}>{cat}</Badge>;
  }

  // ════════════════════════════════════════════════════════════
  // RESUMEN GENERAL TAB
  // ════════════════════════════════════════════════════════════
  if (tab === 'resumen') {
    return (
      <div>
        {/* Page head */}
        <div className="page-head">
          <div>
            <h1 className="page-title">Cuentas CC</h1>
            <div className="page-sub">Vista global de saldos B2B</div>
          </div>
          <div className="page-actions">
            <div className="tabs">
              {['clientes', 'resumen'].map(t => (
                <button
                  key={t}
                  className={tab === t ? 'on' : ''}
                  onClick={() => setTab(t)}
                >
                  {t === 'clientes' ? 'Clientes' : 'Resumen general'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* KPI row */}
        {!rgData ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>
            Cargando…
          </div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 20 }}>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Deuda total · ARS</div>
                <div className="kpi-value">
                  <span className="muted" style={{ fontSize: 12 }}>ARS </span>
                  <span className="mono neg">{fmt(rgData.total_deuda)}</span>
                </div>
                <div className="muted tiny" style={{ marginTop: 6 }}>
                  clientes que nos deben
                </div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Clientes activos</div>
                <div className="kpi-value mono">{rgData.cant_clientes}</div>
                <div className="muted tiny" style={{ marginTop: 6 }}>
                  en cuenta corriente
                </div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Crédito a favor · ARS</div>
                <div className="kpi-value">
                  <span className="muted" style={{ fontSize: 12 }}>ARS </span>
                  <span className="mono pos">{fmt(rgData.total_credito)}</span>
                </div>
                <div className="muted tiny" style={{ marginTop: 6 }}>
                  les debemos a clientes
                </div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Neto · ARS</div>
                <div className="kpi-value">
                  <span className="muted" style={{ fontSize: 12 }}>ARS </span>
                  <span
                    className={'mono ' + (Number(rgData.neto) >= 0 ? 'neg' : 'pos')}
                  >
                    {fmt(rgData.neto)}
                  </span>
                </div>
                <div className="muted tiny" style={{ marginTop: 6 }}>
                  {Number(rgData.neto) >= 0 ? 'a cobrar (neto)' : 'a pagar (neto)'}
                </div>
              </div>
            </div>

            {/* Top deudores */}
            <div className="card card-flush">
              <div className="card-hd">
                <h3>Top 10 deudores</h3>
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>#</th>
                    <th>Cliente</th>
                    <th>Categoría</th>
                    <th className="num">Saldo</th>
                    <th style={{ width: 120 }}>Proporción</th>
                  </tr>
                </thead>
                <tbody>
                  {(rgData.top_deudores || []).map((c, i) => {
                    const totalDeuda = Number(rgData.total_deuda) || 1;
                    const pct = Math.min(100, Math.round((Number(c.saldo) / totalDeuda) * 100));
                    return (
                      <tr
                        key={c.id}
                        className="tbl-row-click"
                        onClick={() => {
                          setSelectedId(c.id);
                          setTab('clientes');
                        }}
                      >
                        <td className="muted mono">{String(i + 1).padStart(2, '0')}</td>
                        <td>
                          <div style={{ fontWeight: 600 }}>
                            {c.nombre} {c.apellido}
                          </div>
                        </td>
                        <td>{catBadge(c.categoria)}</td>
                        <td className="num mono neg" style={{ fontWeight: 700 }}>
                          ARS {fmt(c.saldo)}
                        </td>
                        <td style={{ width: 120 }}>
                          <div className="bar-track" style={{ height: 6 }}>
                            <div className="bar-fill" style={{ width: pct + '%' }} />
                          </div>
                          <div
                            className="muted tiny mono"
                            style={{ marginTop: 3, textAlign: 'right' }}
                          >
                            {pct}%
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {(!rgData.top_deudores || rgData.top_deudores.length === 0) && (
                    <tr>
                      <td colSpan={5} className="empty">
                        Sin deudores
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════
  // CLIENTES TAB (lista + detail)
  // ════════════════════════════════════════════════════════════

  const detail = clienteDetail;
  const cliente = detail?.resumen?.cliente || null;
  const resumen = detail?.resumen || null;
  const movimientos = detail?.movimientos || [];

  return (
    <div>
      {/* Page head */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Cuentas CC</h1>
          <div className="page-sub">Clientes B2B · compras, pagos, devoluciones</div>
        </div>
        <div className="page-actions">
          <div className="tabs">
            {['clientes', 'resumen'].map(t => (
              <button
                key={t}
                className={tab === t ? 'on' : ''}
                onClick={() => setTab(t)}
              >
                {t === 'clientes' ? 'Clientes' : 'Resumen general'}
              </button>
            ))}
          </div>
          <button
            className="btn btn-primary"
            onClick={() => {
              setClienteForm(EMPTY_CLIENTE);
              setClienteError('');
              setShowClienteModal(true);
            }}
          >
            <Icons.Plus size={14} /> Nuevo cliente
          </button>
        </div>
      </div>

      {/* Split layout */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '280px 1fr',
          gap: 0,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          overflow: 'hidden',
          minHeight: 560,
        }}
      >
        {/* ── Sidebar ── */}
        <div
          style={{
            borderRight: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
          }}
        >
          {/* Search + filter header */}
          <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
            <div className="input-group" style={{ marginBottom: 8 }}>
              <span className="addon addon-l">
                <Icons.Search size={14} />
              </span>
              <input
                className="input"
                placeholder="Buscar…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <Seg
              value={catFilter}
              options={[
                { value: 'todas', label: 'Todas' },
                { value: 'VIP', label: 'VIP' },
                { value: 'A+', label: 'A+' },
                { value: 'A-', label: 'A-' },
              ]}
              onChange={val => {
                setCatFilter(val);
                setSelectedId(null); // reset so first of new filter is auto-selected
              }}
            />
          </div>

          {/* Clients list */}
          <div style={{ flex: 1, overflow: 'auto', maxHeight: 540 }}>
            {loadingClientes ? (
              <div
                style={{
                  padding: 20,
                  color: 'var(--text-muted)',
                  fontSize: 13,
                  textAlign: 'center',
                }}
              >
                Cargando…
              </div>
            ) : filtered.length === 0 ? (
              <div className="empty">Sin resultados</div>
            ) : (
              filtered.map((c, i) => (
                <div
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  style={{
                    padding: '12px 14px',
                    borderBottom:
                      i < filtered.length - 1 ? '1px solid var(--hairline)' : 0,
                    cursor: 'pointer',
                    background:
                      selectedId === c.id ? 'var(--surface-2)' : 'transparent',
                    borderLeft:
                      selectedId === c.id
                        ? '3px solid var(--accent)'
                        : '3px solid transparent',
                  }}
                >
                  <div className="flex-between" style={{ marginBottom: 4 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                      {c.nombre} {c.apellido || ''}
                    </div>
                    {catBadge(c.categoria)}
                  </div>
                  {(c.localidad || c.provincia) && (
                    <div className="muted tiny" style={{ marginBottom: 4 }}>
                      {c.localidad}
                      {c.provincia ? ', ' + c.provincia : ''}
                    </div>
                  )}
                  <div
                    className="mono"
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color:
                        Number(c.saldo) > 0
                          ? 'var(--neg)'
                          : Number(c.saldo) < 0
                          ? 'var(--pos)'
                          : 'var(--text-muted)',
                    }}
                  >
                    {Number(c.saldo) !== 0 ? fmtARS(c.saldo) : 'Sin saldo'}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Detail panel ── */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {loadingDetail ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                fontSize: 13,
              }}
            >
              Cargando…
            </div>
          ) : !cliente ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                fontSize: 13,
              }}
            >
              Seleccioná un cliente
            </div>
          ) : (
            <>
              {/* Client header */}
              <div style={{ padding: 18, borderBottom: '1px solid var(--border)' }}>
                <div className="flex-between" style={{ marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>
                      {cliente.nombre} {cliente.apellido || ''}
                    </div>
                    {(cliente.marca_redes || cliente.contacto) && (
                      <div className="muted tiny" style={{ marginTop: 2 }}>
                        {[cliente.marca_redes, cliente.contacto]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                  <div className="flex-row" style={{ gap: 6 }}>
                    {catBadge(cliente.categoria)}
                    <button className="icon-btn" title="Editar cliente" disabled>
                      <Icons.Edit size={15} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Nuevo movimiento"
                      onClick={() => setShowMovModal(true)}
                    >
                      <Icons.Plus size={15} />
                    </button>
                  </div>
                </div>
                {(cliente.direccion || cliente.localidad) && (
                  <div className="muted tiny">
                    {[cliente.direccion, cliente.localidad, cliente.provincia]
                      .filter(Boolean)
                      .join(', ')}
                  </div>
                )}
              </div>

              {/* KPI + notas + movimientos */}
              <div style={{ padding: 18, flex: 1, overflow: 'auto' }}>
                {/* KPI row */}
                <div className="row" style={{ marginBottom: 16 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="muted tiny"
                      style={{
                        fontWeight: 600,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                      }}
                    >
                      Saldo actual
                    </div>
                    <div
                      style={{
                        fontSize: 24,
                        fontWeight: 600,
                        letterSpacing: '-0.02em',
                        marginTop: 4,
                      }}
                    >
                      <span className="muted" style={{ fontSize: 12 }}>
                        ARS{' '}
                      </span>
                      <span
                        className={
                          'mono ' +
                          (Number(resumen.saldo) > 0
                            ? 'neg'
                            : Number(resumen.saldo) < 0
                            ? 'pos'
                            : 'muted')
                        }
                      >
                        {fmt(resumen.saldo)}
                      </span>
                    </div>
                    <div className="muted tiny" style={{ marginTop: 2 }}>
                      {Number(resumen.saldo) > 0
                        ? 'Nos debe'
                        : Number(resumen.saldo) < 0
                        ? 'Le debemos'
                        : 'Al día'}
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="muted tiny"
                      style={{
                        fontWeight: 600,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                      }}
                    >
                      Movimientos
                    </div>
                    <div
                      style={{
                        fontSize: 24,
                        fontWeight: 600,
                        letterSpacing: '-0.02em',
                        marginTop: 4,
                      }}
                      className="mono"
                    >
                      {resumen.cant_movimientos || 0}
                    </div>
                    <div className="muted tiny" style={{ marginTop: 2 }}>
                      {resumen.cant_compras || 0} compras en total
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="muted tiny"
                      style={{
                        fontWeight: 600,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                      }}
                    >
                      Total comprado
                    </div>
                    <div
                      style={{
                        fontSize: 24,
                        fontWeight: 600,
                        letterSpacing: '-0.02em',
                        marginTop: 4,
                      }}
                    >
                      <span className="muted" style={{ fontSize: 12 }}>
                        ARS{' '}
                      </span>
                      <span className="mono">{fmt(resumen.total_compras || 0)}</span>
                    </div>
                    <div className="muted tiny" style={{ marginTop: 2 }}>
                      acumulado histórico
                    </div>
                  </div>
                </div>

                {/* Notas */}
                <div className="field" style={{ marginBottom: 16 }}>
                  <div className="field-label">Notas internas</div>
                  <textarea
                    className="input"
                    placeholder="Ej: cobra los viernes, prefiere transferencia"
                    value={cliente.notas || ''}
                    onChange={e => handleNotasChange(e.target.value)}
                    rows={2}
                    style={{ resize: 'vertical', minHeight: 38, padding: 8, height: 'auto' }}
                  />
                </div>

                {/* Quick action buttons */}
                <div className="flex-row" style={{ gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => setShowMovModal(true)}
                  >
                    <Icons.Plus size={13} /> Nuevo mov.
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => setShowMovModal(true)}
                    style={{ color: 'var(--pos)' }}
                  >
                    <Icons.Dollar size={13} /> Registrar pago
                  </button>
                  <button className="btn btn-sm" onClick={() => setShowMovModal(true)}>
                    <Icons.Refresh size={13} /> Devolución
                  </button>
                </div>

                {/* Movements table section label */}
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.10em',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted)',
                    marginBottom: 10,
                  }}
                >
                  Movimientos del cliente
                </div>

                {movimientos.length === 0 ? (
                  <div className="empty">Sin movimientos registrados</div>
                ) : (
                  <table
                    className="tbl"
                    style={{ background: 'var(--surface-2)', borderRadius: 8 }}
                  >
                    <thead>
                      <tr style={{ background: 'transparent' }}>
                        <th style={{ background: 'transparent' }}>Fecha</th>
                        <th style={{ background: 'transparent' }}>Tipo</th>
                        <th style={{ background: 'transparent' }}>Descripción</th>
                        <th style={{ background: 'transparent' }}>Items</th>
                        <th className="num" style={{ background: 'transparent' }}>
                          Monto
                        </th>
                        <th
                          style={{ background: 'transparent', width: 60 }}
                        ></th>
                      </tr>
                    </thead>
                    <tbody>
                      {movimientos.map(m => {
                        const t = TIPO_DISPLAY[m.tipo] || {
                          label: m.tipo,
                          tone: 'default',
                          signo: 1,
                        };
                        return (
                          <tr key={m.id} className="tbl-row-click">
                            <td className="muted mono tiny">{fmtFecha(m.fecha)}</td>
                            <td>
                              <Status tone={t.tone}>{t.label}</Status>
                            </td>
                            <td>
                              {m.descripcion || <span className="dim">—</span>}
                            </td>
                            <td>
                              {m.items && m.items.length > 0 ? (
                                <span className="mono tiny muted">
                                  {m.items.length} item
                                  {m.items.length > 1 ? 's' : ''}
                                </span>
                              ) : (
                                <span className="dim">—</span>
                              )}
                            </td>
                            <td className="num mono" style={{ fontWeight: 700 }}>
                              <span className={t.signo > 0 ? 'neg' : 'pos'}>
                                {t.signo > 0 ? '+' : '-'}ARS {fmt(m.monto_total)}
                              </span>
                            </td>
                            <td>
                              <div
                                className="flex-row"
                                style={{ gap: 4, justifyContent: 'flex-end' }}
                              >
                                <button
                                  className="icon-btn"
                                  title="Eliminar movimiento"
                                  onClick={() => handleDeleteMovimiento(m.id)}
                                >
                                  <Icons.Trash size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {/* Items of latest movement with items */}
                {(() => {
                  const ultConItems = movimientos.find(
                    m => m.items && m.items.length > 0
                  );
                  if (!ultConItems) return null;
                  return (
                    <div
                      style={{
                        marginTop: 14,
                        padding: 14,
                        background: 'var(--bg-elev)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                      }}
                    >
                      <div
                        className="muted tiny"
                        style={{
                          fontWeight: 700,
                          letterSpacing: '0.10em',
                          textTransform: 'uppercase',
                          marginBottom: 10,
                        }}
                      >
                        Items del último movimiento
                        {ultConItems.descripcion ? ' — ' + ultConItems.descripcion : ''}
                      </div>
                      <div className="stack" style={{ gap: 6 }}>
                        {ultConItems.items.map((it, i) => (
                          <div
                            key={i}
                            className="flex-between"
                            style={{
                              padding: '8px 10px',
                              background: 'var(--surface)',
                              borderRadius: 6,
                              fontSize: 12.5,
                            }}
                          >
                            <div className="flex-row" style={{ gap: 10 }}>
                              <span style={{ fontWeight: 600 }}>
                                {[
                                  it.producto,
                                  it.modelo,
                                  it.tamano,
                                  it.color,
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
                              </span>
                              {it.verificado ? (
                                <Badge tone="pos" dot>
                                  IMEI verificado
                                </Badge>
                              ) : (
                                <Badge tone="warn" dot>
                                  Sin verificar
                                </Badge>
                              )}
                            </div>
                            <div className="flex-row" style={{ gap: 14 }}>
                              {it.imei_serial && (
                                <span className="muted mono tiny">
                                  IMEI {it.imei_serial}
                                </span>
                              )}
                              {it.valor != null && (
                                <span className="mono" style={{ fontWeight: 700 }}>
                                  ARS {fmt(it.valor)}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Movement modal */}
      {showMovModal && (
        <MovimientoModal
          clienteId={selectedId}
          onClose={() => setShowMovModal(false)}
          onSuccess={() => {
            setShowMovModal(false);
            reloadDetail();
          }}
        />
      )}

      {/* Nuevo cliente modal */}
      {showClienteModal && (
        <div
          className="modal-overlay"
          onClick={e => e.target === e.currentTarget && setShowClienteModal(false)}
        >
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-hd">
              <h3>Nuevo cliente</h3>
              <button className="icon-btn" onClick={() => setShowClienteModal(false)}>
                <Icons.X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="stack" style={{ gap: 12 }}>
                {/* Row 1: nombre + apellido */}
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">
                      Nombre <span style={{ color: 'var(--neg)' }}>*</span>
                    </label>
                    <input
                      type="text"
                      className="input"
                      placeholder="Ej: Juan"
                      value={clienteForm.nombre}
                      onChange={e => setClienteForm(f => ({ ...f, nombre: e.target.value }))}
                    />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Apellido</label>
                    <input
                      type="text"
                      className="input"
                      placeholder="Ej: García"
                      value={clienteForm.apellido}
                      onChange={e => setClienteForm(f => ({ ...f, apellido: e.target.value }))}
                    />
                  </div>
                </div>

                {/* Row 2: contacto + categoria */}
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Contacto</label>
                    <input
                      type="text"
                      className="input"
                      placeholder="Teléfono / WhatsApp / email"
                      value={clienteForm.contacto}
                      onChange={e => setClienteForm(f => ({ ...f, contacto: e.target.value }))}
                    />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">
                      Categoría <span style={{ color: 'var(--neg)' }}>*</span>
                    </label>
                    <select
                      className="input"
                      value={clienteForm.categoria}
                      onChange={e => setClienteForm(f => ({ ...f, categoria: e.target.value }))}
                    >
                      <option value="VIP">VIP</option>
                      <option value="A+">A+</option>
                      <option value="A-">A-</option>
                    </select>
                  </div>
                </div>

                {/* Row 3: provincia + localidad */}
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Provincia</label>
                    <input
                      type="text"
                      className="input"
                      placeholder="Ej: Buenos Aires"
                      value={clienteForm.provincia}
                      onChange={e => setClienteForm(f => ({ ...f, provincia: e.target.value }))}
                    />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Localidad</label>
                    <input
                      type="text"
                      className="input"
                      placeholder="Ej: Lanús"
                      value={clienteForm.localidad}
                      onChange={e => setClienteForm(f => ({ ...f, localidad: e.target.value }))}
                    />
                  </div>
                </div>

                {/* Row 4: direccion */}
                <div className="field">
                  <label className="field-label">Dirección</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Ej: Av. Rivadavia 1234"
                    value={clienteForm.direccion}
                    onChange={e => setClienteForm(f => ({ ...f, direccion: e.target.value }))}
                  />
                </div>

                {/* Row 5: marca_redes */}
                <div className="field">
                  <label className="field-label">Redes sociales</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Ej: @juangarcia"
                    value={clienteForm.marca_redes}
                    onChange={e => setClienteForm(f => ({ ...f, marca_redes: e.target.value }))}
                  />
                </div>

                {/* Row 6: notas */}
                <div className="field">
                  <label className="field-label">Notas internas</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Ej: cobra los viernes"
                    value={clienteForm.notas}
                    onChange={e => setClienteForm(f => ({ ...f, notas: e.target.value }))}
                  />
                </div>

                {clienteError && (
                  <div style={{ color: 'var(--neg)', fontSize: 13 }}>{clienteError}</div>
                )}
              </div>
            </div>
            <div className="modal-ft">
              <button
                className="btn btn-ghost"
                onClick={() => setShowClienteModal(false)}
                disabled={clienteCreating}
              >
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreateCliente}
                disabled={clienteCreating}
              >
                {clienteCreating ? 'Guardando…' : 'Crear cliente'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useMemo } from 'react';
import { Icons } from '../components/Icons';
import { cajas } from '../lib/api';

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmt(n) {
  const v = Math.abs(Number(n));
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K';
  return Math.round(v).toLocaleString('es-AR');
}
function fmtFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const TIPO_TONE = { amigo: 'info', familiar: 'accent', cliente: 'pos', inversor: 'warn', 'ipro team': 'default' };
const TIPO_LABEL = { amigo: 'Amigo', familiar: 'Familiar', cliente: 'Cliente', inversor: 'Inversor', 'ipro team': 'iPro team' };

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

// ─── Main component ───────────────────────────────────────────────────────────
export default function Cajas() {
  const [tab, setTab] = useState('deudas');

  // Deudas
  const [deudaMovs, setDeudaMovs] = useState([]);
  const [selectedContactoId, setSelectedContactoId] = useState(null);
  const [loadingDeudas, setLoadingDeudas] = useState(false);
  const [contactoMovs, setContactoMovs] = useState([]);
  const [loadingContactoMovs, setLoadingContactoMovs] = useState(false);

  // Inversiones
  const [inversiones, setInversiones] = useState([]);
  const [loadingInv, setLoadingInv] = useState(false);

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
  const totalDeudaARS  = useMemo(() => contactosDeuda.filter(c => c.saldo_ars > 0).reduce((s, c) => s + c.saldo_ars, 0), [contactosDeuda]);
  const totalDeudaUSD  = useMemo(() => contactosDeuda.filter(c => c.saldo_usd > 0).reduce((s, c) => s + c.saldo_usd, 0), [contactosDeuda]);
  const conDeuda       = useMemo(() => contactosDeuda.filter(c => c.saldo_ars > 0 || c.saldo_usd > 0).length, [contactosDeuda]);
  const mayorSaldo     = useMemo(() => contactosDeuda.length ? Math.max(...contactosDeuda.map(c => c.saldo_ars)) : 0, [contactosDeuda]);

  // KPIs for inversiones
  const totalInvARS    = useMemo(() => inversiones.reduce((s, m) => s + (parseFloat(m.monto) || 0), 0), [inversiones]);
  const inversoresActivos = useMemo(() => new Set(inversiones.map(m => m.contacto_id)).size, [inversiones]);

  // Delete deuda movement
  async function handleDeleteDeuda(id) {
    if (!confirm('¿Eliminar este movimiento?')) return;
    try {
      await cajas.deleteDeuda(id);
      setContactoMovs(prev => prev.filter(m => m.id !== id));
      // Reload deudas totals
      cajas.deudas({ limit: 500 }).then(res => setDeudaMovs(res.data || []));
    } catch (e) { alert(e.message); }
  }

  async function handleDeleteInversion(id) {
    if (!confirm('¿Eliminar esta inversión?')) return;
    try {
      await cajas.deleteInversion(id);
      setInversiones(prev => prev.filter(m => m.id !== id));
    } catch (e) { alert(e.message); }
  }

  return (
    <div>
      {/* Page head */}
      <div className="page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Cajas</h1>
          <div className="page-sub">Deudas e inversiones por contacto</div>
        </div>
        <div className="page-actions">
          <div className="tabs">
            {[{ value: 'deudas', label: 'Deudas' }, { value: 'inversiones', label: 'Inversiones' }].map(t => (
              <button key={t.value} className={'tab' + (tab === t.value ? ' active' : '')}
                      onClick={() => { setTab(t.value); setSelectedContactoId(null); }}>
                {t.label}
              </button>
            ))}
          </div>
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
                          {c.saldo_ars !== 0 ? (c.saldo_ars > 0 ? '' : '') + fmt(c.saldo_ars) : <span className="dim">—</span>}
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
                  <button className="icon-btn" onClick={() => setSelectedContactoId(null)}>
                    <Icons.X size={15} />
                  </button>
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
    </div>
  );
}

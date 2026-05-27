import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { cajas, inventario, cuentas, proveedores } from '../lib/api';
import { fmt, fmtFecha } from '../lib/format';

// Origen de cada movimiento del ledger (incluye los módulos financieros nuevos).
const ORIGEN_LABEL = {
  venta: 'Venta', b2b: 'B2B', financiera: 'Financiera', envio: 'Envío',
  egreso: 'Egreso', proveedor: 'Proveedor', transferencia: 'Transferencia',
  ajuste: 'Ajuste', cambio: 'Cambio divisa', tarjeta: 'Tarjeta',
};
const ORIGEN_TONE = {
  venta: 'pos', b2b: 'pos', financiera: 'accent', envio: 'pos',
  egreso: 'neg', proveedor: 'neg', transferencia: 'info', ajuste: 'warn',
  cambio: 'info', tarjeta: 'accent',
};
const Badge = ({ tone = 'default', children }) => <span className={`badge badge-${tone}`}>{children}</span>;
const sym = (m) => (m === 'ARS' ? '$' : 'u$s');

const EMPTY_FILTROS = { caja_id: '', desde: '', hasta: '', origen: '', tipo: '', page: 1 };

export default function Capital() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('capital');          // 'capital' | 'movimientos'
  const [cajasList, setCajasList] = useState([]);
  const [metricas, setMetricas] = useState({});       // valor de inventario a costo (USD/ARS)
  const [resumen, setResumen] = useState({ deudas: [], inversiones: [] }); // deudas a cobrar + inversiones
  const [ccGeneral, setCcGeneral] = useState({});      // cuenta corriente B2B (USD)
  const [provSaldos, setProvSaldos] = useState({});    // lo que le debemos a proveedores (USD)
  const [filtros, setFiltros] = useState(EMPTY_FILTROS);
  const [ledger, setLedger] = useState({ data: [], pagination: { pages: 1, page: 1, total: 0 }, totales: { ingresos_usd: 0, egresos_usd: 0, neto_usd: 0, count: 0 } });
  const [loading, setLoading] = useState(false);
  const setLF = (field, val) => setFiltros(f => ({ ...f, [field]: val, page: field === 'page' ? val : 1 }));

  // Fuentes del patrimonio total: cajas (efectivo), inventario (a costo),
  // cajas/resumen (deudas a cobrar + inversiones) y cuentas B2B (neto a cobrar)
  useEffect(() => {
    cajas.listCajas().then(r => setCajasList(Array.isArray(r) ? r : [])).catch(() => {});
    inventario.metricas().then(r => setMetricas(r || {})).catch(() => {});
    cajas.resumen().then(r => setResumen({ deudas: r?.deudas || [], inversiones: r?.inversiones || [] })).catch(() => {});
    cuentas.resumenGeneral().then(r => setCcGeneral(r || {})).catch(() => {});
    proveedores.saldos().then(r => setProvSaldos(r || {})).catch(() => {});
  }, []);
  // El ledger se carga solo cuando estás en la pestaña Movimientos (serán muchas
  // operaciones diarias; no tiene sentido traerlas mientras mirás el Capital).
  useEffect(() => {
    if (tab !== 'movimientos') return;
    setLoading(true);
    cajas.ledger(filtros).then(setLedger).catch(() => {}).finally(() => setLoading(false));
  }, [filtros, tab]);

  // Patrimonio total: descompone el capital en sus partes, totalizado por moneda
  // (ARS, USD y USDT por separado — no se convierte por TC para no inventar una tasa).
  // "Cajas (todas)" es el agregado; el detalle por caja vive en la tabla de más abajo.
  const patrimonio = useMemo(() => {
    const n = (x) => Number(x || 0);
    const inv = metricas || {};
    const cajasArs  = cajasList.filter(c => c.moneda === 'ARS').reduce((s, c) => s + n(c.saldo_actual), 0);
    const cajasUsd  = cajasList.filter(c => c.moneda === 'USD').reduce((s, c) => s + n(c.saldo_actual), 0);
    const cajasUsdt = cajasList.filter(c => c.moneda === 'USDT').reduce((s, c) => s + n(c.saldo_actual), 0);
    const invArs = n(inv.inv_equipos_ars) + n(inv.inv_accesorios_ars) + n(inv.en_tecnico_ars);
    const invUsd = n(inv.inv_equipos_usd) + n(inv.inv_accesorios_usd) + n(inv.en_tecnico_usd);
    const deudasArs = (resumen.deudas || []).reduce((s, d) => s + n(d.saldo_ars), 0);
    const deudasUsd = (resumen.deudas || []).reduce((s, d) => s + n(d.saldo_usd), 0);
    const b2bUsd = n(ccGeneral.neto);
    // Las inversiones son dinero que nos invirtieron y debemos devolver → restan.
    const inversionesArs = (resumen.inversiones || []).reduce((s, i) => s + n(i.total_invertido), 0);
    // Lo que le debemos a proveedores (USD) → resta.
    const provUsd = n(provSaldos.total_deuda_usd);
    // Cards de composición (lo que suma en verde, lo que resta en rojo).
    // Cada caja entra como su propia fila en "Suman".
    const cajaCards = cajasList.map(c => ({
      label: c.nombre, tone: 'pos', moneda: c.moneda,
      montos: [[sym(c.moneda), n(c.saldo_actual)]],
    }));
    const cards = [
      ...cajaCards,
      { label: 'Deudas de clientes a cobrar',     tone: 'pos', montos: [['$', deudasArs], ['u$s', deudasUsd]] },
      { label: 'Deudas de clientes B2B a cobrar', tone: 'pos', montos: [['u$s', b2bUsd]] },
      { label: 'Stock valorizado',                tone: 'pos', montos: [['$', invArs], ['u$s', invUsd]] },
      { label: 'Inversiones recibidas',           tone: 'neg', montos: [['$', inversionesArs]] },
      { label: 'Deudas a proveedores a pagar',    tone: 'neg', montos: [['u$s', provUsd]] },
    ];
    const totalArs  = cajasArs  + invArs + deudasArs - inversionesArs;
    const totalUsd  = cajasUsd  + invUsd + deudasUsd + b2bUsd - provUsd;
    const totalUsdt = cajasUsdt;
    return { cards, totalArs, totalUsd, totalUsdt };
  }, [cajasList, metricas, resumen, ccGeneral, provSaldos]);

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="icon-btn" title="Volver a Cajas" onClick={() => navigate('/cajas')} style={{ fontSize: 20, lineHeight: 1 }}>←</button>
          <div>
            <h1 className="page-title">360 &amp; Capital</h1>
            <div className="page-sub">Capital total, estado de cada caja y todos los movimientos en un solo lugar</div>
          </div>
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 16 }}>
        {[{ value: 'capital', label: 'Capital' }, { value: 'movimientos', label: 'Movimientos' }].map(t => (
          <button key={t.value} className={'tab' + (tab === t.value ? ' active' : '')} onClick={() => setTab(t.value)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'capital' && <>
      {/* Patrimonio total por moneda (efectivo + inventario + inversiones + a cobrar + B2B) */}
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Patrimonio · ARS</div>
          <div className="kpi-value mono" style={{ color: patrimonio.totalArs >= 0 ? 'var(--pos)' : 'var(--neg)' }}>$ {fmt(patrimonio.totalArs)}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Patrimonio · USD</div>
          <div className="kpi-value mono" style={{ color: patrimonio.totalUsd >= 0 ? 'var(--pos)' : 'var(--neg)' }}>u$s {fmt(patrimonio.totalUsd)}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Patrimonio · USDT</div>
          <div className="kpi-value mono" style={{ color: patrimonio.totalUsdt >= 0 ? 'var(--pos)' : 'var(--neg)' }}>USDT {fmt(patrimonio.totalUsdt)}</div>
        </div>
      </div>

      {/* Composición del patrimonio: panel único agrupado en Suman / Restan */}
      <div className="card card-flush" style={{ marginBottom: 14 }}>
        <div className="card-hd">
          <div style={{ fontWeight: 600, fontSize: 14 }}>Composición del patrimonio</div>
          <div className="muted tiny">Verde suma, rojo resta · cada moneda por separado (sin TC)</div>
        </div>
        {[{ titulo: 'Suman', tone: 'pos' }, { titulo: 'Restan', tone: 'neg' }].map(g => {
          const color = g.tone === 'neg' ? 'var(--neg)' : 'var(--pos)';
          return (
            <div key={g.tone}>
              <div className="kpi-label" style={{ padding: '12px 16px 2px' }}>{g.titulo}</div>
              {patrimonio.cards.filter(c => c.tone === g.tone).map((c, idx) => (
                <div key={c.label + idx} className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flex: '0 0 auto' }} />
                    <span style={{ fontWeight: 600 }}>{c.label}</span>
                    {c.moneda && <span className="ccy" style={{ marginLeft: 2 }}>{c.moneda}</span>}
                  </span>
                  <span className="mono" style={{ display: 'inline-flex', gap: 18, fontWeight: 700 }}>
                    {c.montos.map(([pre, v], i) => {
                      const resta = g.tone === 'neg' || Number(v) < 0;
                      return <span key={i} style={{ color: resta ? 'var(--neg)' : 'var(--pos)' }}>{(resta ? '− ' : '') + pre + ' ' + fmt(v)}</span>;
                    })}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      </>}

      {tab === 'movimientos' && <>
      {/* Totales del ledger (USD) */}
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="card card-tight" style={{ flex: 1 }}><div className="kpi-label">Ingresos · USD</div><div className="kpi-value mono pos">u$s {fmt(ledger.totales.ingresos_usd)}</div></div>
        <div className="card card-tight" style={{ flex: 1 }}><div className="kpi-label">Egresos · USD</div><div className="kpi-value mono neg">u$s {fmt(ledger.totales.egresos_usd)}</div></div>
        <div className="card card-tight" style={{ flex: 1 }}><div className="kpi-label">Neto · USD</div><div className={'kpi-value mono ' + (Number(ledger.totales.neto_usd) >= 0 ? 'pos' : 'neg')}>u$s {fmt(ledger.totales.neto_usd)}</div></div>
        <div className="card card-tight" style={{ flex: 1 }}><div className="kpi-label">Movimientos</div><div className="kpi-value mono">{ledger.totales.count}</div></div>
      </div>

      {/* Filtros */}
      <div className="card card-tight" style={{ marginBottom: 12 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0, minWidth: 160 }}>
            <label className="field-label">Caja</label>
            <select className="input" value={filtros.caja_id} onChange={e => setLF('caja_id', e.target.value)}>
              <option value="">Todas</option>
              {cajasList.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}><label className="field-label">Desde</label><input type="date" className="input" value={filtros.desde} onChange={e => setLF('desde', e.target.value)} /></div>
          <div className="field" style={{ marginBottom: 0 }}><label className="field-label">Hasta</label><input type="date" className="input" value={filtros.hasta} onChange={e => setLF('hasta', e.target.value)} /></div>
          <div className="field" style={{ marginBottom: 0, minWidth: 150 }}>
            <label className="field-label">Origen</label>
            <select className="input" value={filtros.origen} onChange={e => setLF('origen', e.target.value)}>
              <option value="">Todos</option>
              {Object.entries(ORIGEN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, minWidth: 120 }}>
            <label className="field-label">Tipo</label>
            <select className="input" value={filtros.tipo} onChange={e => setLF('tipo', e.target.value)}>
              <option value="">Todos</option><option value="ingreso">Ingreso</option><option value="egreso">Egreso</option>
            </select>
          </div>
          <button className="btn btn-ghost" style={{ marginBottom: 0 }} onClick={() => setFiltros(EMPTY_FILTROS)}>Limpiar</button>
        </div>
      </div>

      {/* Tabla de movimientos */}
      <div className="card card-flush">
        <div className="card-hd">
          <div style={{ fontWeight: 600, fontSize: 14 }}>Movimientos — {ledger.totales.count}</div>
          <div className="muted tiny">Totales en USD (los montos en ARS sin TC aportan 0 al total USD)</div>
        </div>
        {loading ? <div className="empty">Cargando movimientos…</div>
          : ledger.data.length === 0 ? <div className="empty">Sin movimientos para los filtros elegidos.</div>
          : (
            <table className="tbl">
              <thead>
                <tr><th>Fecha</th><th>Caja</th><th>Origen</th><th>Concepto</th><th style={{ textAlign: 'right' }}>Monto</th><th style={{ textAlign: 'right' }}>USD</th></tr>
              </thead>
              <tbody>
                {ledger.data.map(m => {
                  const signo = m.tipo === 'ingreso' ? '+' : '−';
                  const tone = m.tipo === 'ingreso' ? 'pos' : 'neg';
                  return (
                    <tr key={m.id}>
                      <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                      <td>{m.caja_nombre} <span className="muted tiny">{m.moneda}</span></td>
                      <td><Badge tone={ORIGEN_TONE[m.origen] || 'default'}>{ORIGEN_LABEL[m.origen] || m.origen}</Badge></td>
                      <td className="muted tiny">{m.concepto || '—'}</td>
                      <td className={'mono ' + tone} style={{ textAlign: 'right', fontWeight: 700 }}>{signo}{fmt(m.monto)}</td>
                      <td className="mono tiny" style={{ textAlign: 'right' }}>{Number(m.monto_usd) > 0 ? 'u$s ' + fmt(m.monto_usd) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        {ledger.pagination.pages > 1 && (
          <div className="flex-row" style={{ justifyContent: 'center', gap: 12, padding: 12, alignItems: 'center' }}>
            <button className="btn btn-ghost btn-sm" disabled={filtros.page <= 1} onClick={() => setLF('page', filtros.page - 1)}>Anterior</button>
            <span className="muted tiny">Página {ledger.pagination.page} de {ledger.pagination.pages}</span>
            <button className="btn btn-ghost btn-sm" disabled={filtros.page >= ledger.pagination.pages} onClick={() => setLF('page', filtros.page + 1)}>Siguiente</button>
          </div>
        )}
      </div>
      </>}
    </div>
  );
}

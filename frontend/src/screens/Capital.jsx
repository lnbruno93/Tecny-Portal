import { useState, useEffect, useMemo } from 'react';
import { cajas } from '../lib/api';
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
  const [cajasList, setCajasList] = useState([]);
  const [filtros, setFiltros] = useState(EMPTY_FILTROS);
  const [ledger, setLedger] = useState({ data: [], pagination: { pages: 1, page: 1, total: 0 }, totales: { ingresos_usd: 0, egresos_usd: 0, neto_usd: 0, count: 0 } });
  const [loading, setLoading] = useState(false);
  const setLF = (field, val) => setFiltros(f => ({ ...f, [field]: val, page: field === 'page' ? val : 1 }));

  useEffect(() => { cajas.listCajas().then(r => setCajasList(Array.isArray(r) ? r : [])).catch(() => {}); }, []);
  useEffect(() => {
    setLoading(true);
    cajas.ledger(filtros).then(setLedger).catch(() => {}).finally(() => setLoading(false));
  }, [filtros]);

  // Capital total por moneda (suma de saldos actuales de cada caja)
  const capital = useMemo(() => {
    const m = {};
    for (const c of cajasList) m[c.moneda] = (m[c.moneda] || 0) + Number(c.saldo_actual || 0);
    return m;
  }, [cajasList]);
  const monedas = ['ARS', 'USD', 'USDT'].filter(mo => capital[mo] !== undefined);

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="page-title">360 &amp; Capital</h1>
          <div className="page-sub">Capital total, estado de cada caja y todos los movimientos en un solo lugar</div>
        </div>
      </div>

      {/* Capital total por moneda */}
      <div className="row" style={{ marginBottom: 14 }}>
        {monedas.length === 0
          ? <div className="card card-tight" style={{ flex: 1 }}><div className="kpi-label">Capital</div><div className="kpi-value mono">—</div></div>
          : monedas.map(mo => (
            <div key={mo} className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Capital · {mo}</div>
              <div className="kpi-value mono" style={{ color: Number(capital[mo]) >= 0 ? 'var(--pos)' : 'var(--neg)' }}>{sym(mo)} {fmt(capital[mo])}</div>
            </div>
          ))}
      </div>

      {/* Estado de cada caja */}
      <div className="card card-flush" style={{ marginBottom: 14 }}>
        <div className="card-hd"><div style={{ fontWeight: 600, fontSize: 14 }}>Cajas — {cajasList.length}</div></div>
        <table className="tbl">
          <thead>
            <tr><th>Caja</th><th>Moneda</th><th style={{ textAlign: 'right' }}>Saldo actual</th><th>Tipo</th><th>Estado</th></tr>
          </thead>
          <tbody>
            {cajasList.length === 0 && <tr><td colSpan={5} className="empty">Sin cajas. Creá una en Cajas → Config.</td></tr>}
            {cajasList.map(c => (
              <tr key={c.id} style={{ opacity: c.activo ? 1 : 0.55 }}>
                <td style={{ fontWeight: 600 }}>{c.nombre}</td>
                <td><span className="ccy">{c.moneda}</span></td>
                <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{sym(c.moneda)} {fmt(c.saldo_actual)}</td>
                <td>
                  {c.es_financiera ? <Badge tone="accent">Financiera</Badge> : c.es_tarjeta ? <Badge tone="info">Tarjeta {Number(c.comision_pct || 0)}%</Badge> : <span className="dim">—</span>}
                </td>
                <td><Badge tone={c.activo ? 'pos' : 'warn'}>{c.activo ? 'Activa' : 'Inactiva'}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
    </div>
  );
}

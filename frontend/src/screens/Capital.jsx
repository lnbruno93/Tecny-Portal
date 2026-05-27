import { useState, useEffect, useMemo } from 'react';
import { cajas, inventario, cuentas } from '../lib/api';
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
  const [metricas, setMetricas] = useState({});       // valor de inventario a costo (USD/ARS)
  const [resumen, setResumen] = useState({ deudas: [], inversiones: [] }); // deudas a cobrar + inversiones
  const [ccGeneral, setCcGeneral] = useState({});      // cuenta corriente B2B (USD)
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
  }, []);
  useEffect(() => {
    setLoading(true);
    cajas.ledger(filtros).then(setLedger).catch(() => {}).finally(() => setLoading(false));
  }, [filtros]);

  // Capital en efectivo por moneda (suma de saldos actuales de cada caja)
  const capital = useMemo(() => {
    const m = {};
    for (const c of cajasList) m[c.moneda] = (m[c.moneda] || 0) + Number(c.saldo_actual || 0);
    return m;
  }, [cajasList]);

  // Patrimonio total: descompone el capital en sus partes, totalizado por moneda
  // (ARS y USD por separado — no se convierte por TC para no inventar una tasa).
  const patrimonio = useMemo(() => {
    const n = (x) => Number(x || 0);
    const inv = metricas || {};
    const efectivoArs = n(capital.ARS);
    const efectivoUsd = n(capital.USD) + n(capital.USDT);
    const invArs = n(inv.inv_equipos_ars) + n(inv.inv_accesorios_ars) + n(inv.en_tecnico_ars);
    const invUsd = n(inv.inv_equipos_usd) + n(inv.inv_accesorios_usd) + n(inv.en_tecnico_usd);
    const inversionesArs = (resumen.inversiones || []).reduce((s, i) => s + n(i.total_invertido), 0);
    const deudasArs = (resumen.deudas || []).reduce((s, d) => s + n(d.saldo_ars), 0);
    const deudasUsd = (resumen.deudas || []).reduce((s, d) => s + n(d.saldo_usd), 0);
    const ccUsd = n(ccGeneral.neto);
    const rows = [
      { label: 'Efectivo en cajas',    ars: efectivoArs,    usd: efectivoUsd },
      { label: 'Inventario (a costo)', ars: invArs,         usd: invUsd },
      { label: 'Inversiones',          ars: inversionesArs, usd: null },
      { label: 'Deudas a cobrar',      ars: deudasArs,      usd: deudasUsd },
      { label: 'Cuenta corriente B2B', ars: null,           usd: ccUsd },
    ];
    const totalArs = rows.reduce((s, r) => s + (r.ars || 0), 0);
    const totalUsd = rows.reduce((s, r) => s + (r.usd || 0), 0);
    return { rows, totalArs, totalUsd };
  }, [capital, metricas, resumen, ccGeneral]);

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="page-title">360 &amp; Capital</h1>
          <div className="page-sub">Capital total, estado de cada caja y todos los movimientos en un solo lugar</div>
        </div>
      </div>

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
      </div>

      {/* Composición del patrimonio */}
      <div className="card card-flush" style={{ marginBottom: 14 }}>
        <div className="card-hd">
          <div style={{ fontWeight: 600, fontSize: 14 }}>Composición del patrimonio</div>
          <div className="muted tiny">Cada moneda se totaliza por separado (sin conversión por TC)</div>
        </div>
        <table className="tbl">
          <thead>
            <tr><th>Concepto</th><th style={{ textAlign: 'right' }}>ARS</th><th style={{ textAlign: 'right' }}>USD</th></tr>
          </thead>
          <tbody>
            {patrimonio.rows.map(r => (
              <tr key={r.label}>
                <td style={{ fontWeight: 600 }}>{r.label}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{r.ars == null ? <span className="dim">—</span> : '$ ' + fmt(r.ars)}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{r.usd == null ? <span className="dim">—</span> : 'u$s ' + fmt(r.usd)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid var(--border)' }}>
              <td style={{ fontWeight: 800 }}>Total</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 800 }}>$ {fmt(patrimonio.totalArs)}</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 800 }}>u$s {fmt(patrimonio.totalUsd)}</td>
            </tr>
          </tbody>
        </table>
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

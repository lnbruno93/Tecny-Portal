import { useState, useEffect, useMemo } from 'react';
import { cajas, inventario, cuentas, proveedores, tarjetas, cambios } from '../lib/api';
import { fmt, fmtFecha, fmtMoney } from '../lib/format';
// Auditoría 2026-06-30 F-02→05: multi-país. El screen mostraba "ARS" hardcoded
// en labels y símbolo "$" (vía `sym`) para todo lo que no fuese USD — para
// tenants UY (moneda local UYU, símbolo "$U") quedaba inconsistente. Ahora
// las etiquetas y el símbolo de la moneda LOCAL del tenant salen de
// useMonedasTenant + fmtMoney.
import { useMonedasTenant } from '../lib/useMonedasTenant';

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

// Auditoría 2026-06-30 F-02→05: helper local que mapea la moneda al prefijo
// usado en las "Cards de composición" (las que muestran ej. "$ 12.000").
// Antes era `const sym = (m) => (m === 'ARS' ? '$' : 'u$s')` — ignoraba UYU
// y USDT. Ahora reusamos fmtMoney y extraemos solo el prefijo para mantener
// el render legacy `[pre, valor]` que el .map() expecta.
const sym = (m) => {
  if (m === 'ARS')  return '$';
  if (m === 'UYU')  return '$U';
  if (m === 'USDT') return 'USDT';
  return 'u$s'; // USD y default
};

const EMPTY_FILTROS = { caja_id: '', desde: '', hasta: '', origen: '', tipo: '', page: 1 };

export default function Capital() {
  // Auditoría 2026-06-30 F-02→05: moneda local del tenant (ARS para AR,
  // UYU para UY). Reemplaza el "ARS" hardcoded en labels y símbolos.
  const { monedaLocal } = useMonedasTenant();
  const [tab, setTab] = useState('capital');          // 'capital' | 'movimientos'
  const [cajasList, setCajasList] = useState([]);
  const [metricas, setMetricas] = useState({});       // valor de inventario a costo (USD/ARS)
  const [resumen, setResumen] = useState({ deudas: [], inversiones: [] }); // deudas a cobrar + inversiones
  const [ccGeneral, setCcGeneral] = useState({});      // cuenta corriente B2B (USD)
  const [provSaldos, setProvSaldos] = useState({});    // lo que le debemos a proveedores (USD)
  const [tarjSaldos, setTarjSaldos] = useState({});    // saldos pendientes en tarjetas (ARS + USD)
  const [cambSaldos, setCambSaldos] = useState({});    // saldos pendientes en cambios de divisa (USD)
  // Fuentes que fallaron al cargar (no 403). Antes los .catch silenciaban TODO
  // — si tarjetas.saldosResumen tiraba 500, el patrimonio se mostraba como si
  // tarjetas valiera $0 y nadie se enteraba. Ahora trackeamos el fallo para
  // advertir al usuario que el total puede estar incompleto.
  const [fuentesError, setFuentesError] = useState([]);
  const [filtros, setFiltros] = useState(EMPTY_FILTROS);
  const [ledger, setLedger] = useState({ data: [], pagination: { pages: 1, page: 1, total: 0 }, totales: { ingresos_usd: 0, egresos_usd: 0, neto_usd: 0, count: 0 } });
  const [loading, setLoading] = useState(false);
  const setLF = (field, val) => setFiltros(f => ({ ...f, [field]: val, page: field === 'page' ? val : 1 }));

  // Fuentes del patrimonio total: cajas (efectivo), inventario (a costo),
  // cajas/resumen (deudas a cobrar + inversiones), cuentas B2B (neto a cobrar),
  // tarjetas (saldos pendientes de liquidar) y cambios (USD que las financieras
  // todavía nos deben). Cada llamada es independiente — si una falla, el resto
  // sigue cargando, pero registramos la fuente fallida para mostrar warning.
  //
  // Excluimos 403 (sin permiso al módulo): es el estado esperado para users
  // que no tienen acceso a tarjetas/cambios — la línea muestra $0 y no es bug.
  useEffect(() => {
    const onErr = (label) => (err) => {
      if (err?.status === 403) return; // sin permiso al módulo: esperado, no se reporta
      setFuentesError(prev => prev.includes(label) ? prev : [...prev, label]);
    };
    cajas.listCajas().then(r => setCajasList(Array.isArray(r) ? r : [])).catch(onErr('Cajas'));
    inventario.metricas().then(r => setMetricas(r || {})).catch(onErr('Inventario'));
    cajas.resumen().then(r => setResumen({ deudas: r?.deudas || [], inversiones: r?.inversiones || [] })).catch(onErr('Deudas/Inversiones'));
    cuentas.resumenGeneral().then(r => setCcGeneral(r || {})).catch(onErr('Cuentas B2B'));
    proveedores.saldos().then(r => setProvSaldos(r || {})).catch(onErr('Proveedores'));
    tarjetas.saldosResumen().then(r => setTarjSaldos(r || {})).catch(onErr('Tarjetas'));
    cambios.saldosResumen().then(r => setCambSaldos(r || {})).catch(onErr('Cambios de divisa'));
  }, []);
  // El ledger se carga solo cuando estás en la pestaña Movimientos (serán muchas
  // operaciones diarias; no tiene sentido traerlas mientras mirás el Capital).
  useEffect(() => {
    if (tab !== 'movimientos') return;
    setLoading(true);
    cajas.ledger(filtros).then(setLedger).catch(() => {}).finally(() => setLoading(false));
  }, [filtros, tab]);

  // Patrimonio total: descompone el capital en sus partes, totalizado por moneda
  // (moneda local + USD + USDT por separado — no se convierte por TC para no
  // inventar una tasa). "Cajas (todas)" es el agregado; el detalle por caja
  // vive en la tabla de más abajo.
  //
  // Auditoría 2026-06-30 F-02→05: el filtro de cajas usa monedaLocal (ARS para
  // tenants AR, UYU para UY) en vez de la cadena 'ARS' hardcodeada. Los
  // campos del backend (`_ars`, saldo_ars, etc.) siguen llamándose `_ars`
  // por compat con la API actual — para tenants UY el backend todavía devuelve
  // estos campos en moneda local (UYU). El refactor del shape del API es
  // scope separado (F-06 backend).
  const patrimonio = useMemo(() => {
    const n = (x) => Number(x || 0);
    const inv = metricas || {};
    const cajasLocal = cajasList.filter(c => c.moneda === monedaLocal).reduce((s, c) => s + n(c.saldo_actual), 0);
    const cajasUsd   = cajasList.filter(c => c.moneda === 'USD').reduce((s, c) => s + n(c.saldo_actual), 0);
    const cajasUsdt  = cajasList.filter(c => c.moneda === 'USDT').reduce((s, c) => s + n(c.saldo_actual), 0);
    // F3-Fase2b (2026-07-09) → Fase2c (2026-07-11): "Stock valorizado" se
    // calcula desde `inv_por_clase[]` (Fase 2a) — reduce SUM sobre todas
    // las categorías reales del tenant. El `+ en_tecnico_*` sigue igual
    // (equipos en servicio técnico son parte del capital pero no del
    // desglose por-categoría del array).
    //
    // 2026-07-11 Fase 2c: removido el fallback a `inv_equipos_*/inv_accesorios_*`.
    // Backend ya no devuelve esos campos (sunset). Si por algún motivo el
    // array llega vacío o todo redacted (usuario sin `inventario.ver_costos`),
    // el reduce da 0 → Capital muestra 0 en vez de NaN. Es el comportamiento
    // esperado post-Fase 2c.
    const filas = Array.isArray(inv.inv_por_clase) ? inv.inv_por_clase : [];
    const allRedactedUsd = filas.length > 0 && filas.every(r => r.usd === null);
    const allRedactedArs = filas.length > 0 && filas.every(r => r.ars === null);
    const invLocal = allRedactedArs
      ? n(inv.en_tecnico_ars)
      : filas.reduce((s, r) => s + n(r.ars), 0) + n(inv.en_tecnico_ars);
    const invUsd = allRedactedUsd
      ? n(inv.en_tecnico_usd)
      : filas.reduce((s, r) => s + n(r.usd), 0) + n(inv.en_tecnico_usd);
    const deudasLocal = (resumen.deudas || []).reduce((s, d) => s + n(d.saldo_ars), 0);
    const deudasUsd   = (resumen.deudas || []).reduce((s, d) => s + n(d.saldo_usd), 0);
    const b2bUsd = n(ccGeneral.neto);
    // Las inversiones son dinero (en USD) que nos invirtieron y debemos devolver → restan.
    const inversionesUsd = (resumen.inversiones || []).reduce((s, i) => s + n(i.total_invertido), 0);
    // Lo que le debemos a proveedores (USD) → resta.
    const provUsd = n(provSaldos.total_deuda_usd);
    // Saldos pendientes en tarjetas (financiera nos debe depositar) → suma.
    // Conceptualmente equivale a "Deudas de clientes a cobrar" — plata que
    // existe, todavía no la recibimos. La moneda depende del método (las TC
    // en moneda local suman a la local; si hubiera tarjeta USD, sumaría a USD).
    const tarjLocal = n(tarjSaldos.saldo_ars);
    const tarjUsd   = n(tarjSaldos.saldo_usd);
    // Saldos pendientes en cambios de divisa (financiera nos debe USD) → suma.
    const cambUsd = n(cambSaldos.saldo_usd);
    // Cards de composición (lo que suma en verde, lo que resta en rojo).
    // Cada caja entra como su propia fila en "Suman".
    const cajaCards = cajasList.map(c => ({
      label: c.nombre, tone: 'pos', moneda: c.moneda,
      montos: [[sym(c.moneda), n(c.saldo_actual)]],
    }));
    // Símbolo de la moneda local para los montos mixtos (deudas, stock, etc.).
    const localSym = sym(monedaLocal);
    // Cards con TODAS las monedas que puede contener cada concepto. Después
    // filtramos las que están en 0 para no mostrar "$ 0" como ruido visual
    // (típico al arrancar el sistema o cuando un negocio no opera en USD).
    // Las cajas individuales NO se filtran — si una caja tiene saldo 0 es
    // útil verla igual (sabés que existe la caja, no es ruido).
    const cardsRaw = [
      ...cajaCards,
      { label: 'Deudas de clientes a cobrar',     tone: 'pos', montos: [[localSym, deudasLocal], ['u$s', deudasUsd]] },
      { label: 'Deudas de clientes B2B a cobrar', tone: 'pos', montos: [['u$s', b2bUsd]] },
      { label: 'Tarjetas a cobrar',               tone: 'pos', montos: [[localSym, tarjLocal], ['u$s', tarjUsd]] },
      { label: 'Cambios de divisa a cobrar',      tone: 'pos', montos: [['u$s', cambUsd]] },
      { label: 'Stock valorizado',                tone: 'pos', montos: [[localSym, invLocal], ['u$s', invUsd]] },
      { label: 'Inversiones recibidas',           tone: 'neg', montos: [['u$s', inversionesUsd]] },
      { label: 'Deudas a proveedores a pagar',    tone: 'neg', montos: [['u$s', provUsd]] },
    ];
    // Filtrar montos con valor < 0.01 (umbral defensivo para evitar mostrar
    // ruido de redondeo como "$ 0"). Si después de filtrar la card queda sin
    // montos visibles Y no es una caja física (que siempre se muestra),
    // ocultar la card entera.
    const cards = cardsRaw.flatMap(c => {
      if (c.moneda) return [c]; // caja física — no filtrar
      const montos = c.montos.filter(([, v]) => Math.abs(Number(v) || 0) >= 0.01);
      return montos.length > 0 ? [{ ...c, montos }] : [];
    });
    const totalLocal = cajasLocal + invLocal + deudasLocal + tarjLocal;
    const totalUsd   = cajasUsd  + invUsd + deudasUsd + b2bUsd + tarjUsd + cambUsd - provUsd - inversionesUsd;
    const totalUsdt  = cajasUsdt;
    return { cards, totalLocal, totalUsd, totalUsdt };
  }, [cajasList, metricas, resumen, ccGeneral, provSaldos, tarjSaldos, cambSaldos, monedaLocal]);

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title">360 &amp; Capital</h1>
          <div className="page-sub">Capital total, estado de cada caja y todos los movimientos en un solo lugar</div>
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
      {/* Banner de advertencia: si alguna fuente falló (no 403), avisar al
          usuario que el patrimonio total puede estar incompleto. Sin esto,
          un error en cualquier endpoint dejaba la línea en $0 y mentía. */}
      {fuentesError.length > 0 && (
        <div className="card card-tight" style={{
          marginBottom: 14, borderLeft: '3px solid var(--warn, var(--neg))',
          background: 'var(--surface-2)',
        }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            ⚠ El patrimonio mostrado puede estar incompleto
          </div>
          <div className="muted tiny" style={{ marginTop: 4 }}>
            No se pudo cargar: <b>{fuentesError.join(', ')}</b>. Refrescá la página o probá en unos minutos.
          </div>
        </div>
      )}

      {/* Patrimonio total por moneda (efectivo + inventario + inversiones + a cobrar + B2B).
          Auditoría 2026-06-30 F-02→05: labels y símbolos dinámicos por país
          (ARS/$ en AR, UYU/$U en UY) vía useMonedasTenant + fmtMoney. */}
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Patrimonio · {monedaLocal}</div>
          <div className="kpi-value mono" style={{ color: patrimonio.totalLocal >= 0 ? 'var(--pos)' : 'var(--neg)' }}>{fmtMoney(patrimonio.totalLocal, monedaLocal)}</div>
        </div>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Patrimonio · USD</div>
          <div className="kpi-value mono" style={{ color: patrimonio.totalUsd >= 0 ? 'var(--pos)' : 'var(--neg)' }}>{fmtMoney(patrimonio.totalUsd, 'USD')}</div>
        </div>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Patrimonio · USDT</div>
          <div className="kpi-value mono" style={{ color: patrimonio.totalUsdt >= 0 ? 'var(--pos)' : 'var(--neg)' }}>{fmtMoney(patrimonio.totalUsdt, 'USDT')}</div>
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
        <div className="card card-tight u-flex-1"><div className="kpi-label">Ingresos · USD</div><div className="kpi-value mono pos">u$s {fmt(ledger.totales.ingresos_usd)}</div></div>
        <div className="card card-tight u-flex-1"><div className="kpi-label">Egresos · USD</div><div className="kpi-value mono neg">u$s {fmt(ledger.totales.egresos_usd)}</div></div>
        <div className="card card-tight u-flex-1"><div className="kpi-label">Neto · USD</div><div className={'kpi-value mono ' + (Number(ledger.totales.neto_usd) >= 0 ? 'pos' : 'neg')}>u$s {fmt(ledger.totales.neto_usd)}</div></div>
        <div className="card card-tight u-flex-1"><div className="kpi-label">Movimientos</div><div className="kpi-value mono">{ledger.totales.count}</div></div>
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
          <div className="muted tiny">Totales en USD (los montos en {monedaLocal} sin TC aportan 0 al total USD)</div>
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

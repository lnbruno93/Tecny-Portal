import { useState, useEffect, useMemo } from 'react';
import { Icons } from '../components/Icons';
import { tarjetas as tarjetasApi, cajas as cajasApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import CajaSelectHint from '../components/CajaSelectHint';



const todayISO = () => new Date().toLocaleDateString('sv');
const sym = (m) => (m === 'ARS' ? '$' : 'u$s');

export default function Tarjetas() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  const [vista, setVista] = useState('general'); // 'general' (las 3) | 'detalle' (una)
  const [list, setList] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [allMovs, setAllMovs] = useState([]);     // estado de cuenta unificado
  const [selectedId, setSelectedId] = useState(null);
  const [detalle, setDetalle] = useState(null);   // { ...metodo, resumen }
  const [movs, setMovs] = useState([]);
  const [cajas, setCajas] = useState([]);

  // Liquidación (cuando nos pagan)
  const [liq, setLiq] = useState({ fecha: todayISO(), monto: '', caja_id: '' });
  const [savingLiq, setSavingLiq] = useState(false);

  function loadList() {
    setLoadingList(true);
    tarjetasApi.list().then(r => setList(r || [])).catch(e => toast.error(e.message)).finally(() => setLoadingList(false));
    tarjetasApi.movimientosAll().then(r => setAllMovs(r.data || [])).catch(() => {});
  }
  useEffect(() => { loadList(); }, []); // eslint-disable-line
  useEffect(() => { cajasApi.listCajas().then(r => setCajas(Array.isArray(r) ? r : [])).catch(() => {}); }, []);
  useEffect(() => {
    setPrimaryAction(null);
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);
  useEffect(() => { if (list.length > 0 && !selectedId) setSelectedId(list[0].id); }, [list]); // eslint-disable-line

  function loadDetalle() {
    if (!selectedId) { setDetalle(null); setMovs([]); return; }
    Promise.all([tarjetasApi.get(selectedId), tarjetasApi.movimientos(selectedId)])
      .then(([det, m]) => { setDetalle(det); setMovs(m.data || []); })
      .catch(e => toast.error(e.message));
  }
  useEffect(() => { loadDetalle(); setLiq({ fecha: todayISO(), monto: '', caja_id: '' }); }, [selectedId]); // eslint-disable-line

  // Totales globales (de las 3 tarjetas)
  const global = useMemo(() => list.reduce((a, t) => {
    const bruto = Number(t.bruto_total || 0), com = Number(t.comision_total || 0), saldo = Number(t.saldo || 0);
    a.bruto += bruto; a.comision += com; a.saldo += saldo;
    a.liquidado += (bruto - com - saldo); // neto cobrado − pendiente = lo ya recibido
    return a;
  }, { bruto: 0, comision: 0, saldo: 0, liquidado: 0 }), [list]);

  // El estado de cuenta viene del server ya ordenado (más reciente arriba) y con el
  // saldo acumulado calculado (window sobre todo el historial), así que se usa tal cual.
  const estadoCuenta = allMovs;

  async function handleLiquidar(e) {
    e.preventDefault();
    if (!liq.caja_id) { toast.error('Elegí la caja donde entra el dinero.'); return; }
    if (!(parseFloat(liq.monto) > 0)) { toast.error('Ingresá el monto recibido.'); return; }
    setSavingLiq(true);
    try {
      await tarjetasApi.createLiquidacion({ metodo_pago_id: selectedId, fecha: liq.fecha, monto: Number(liq.monto), caja_id: Number(liq.caja_id) });
      setLiq({ fecha: liq.fecha, monto: '', caja_id: '' });
      loadList(); loadDetalle();
      toast.success('Liquidación registrada.');
    } catch (err) { toast.error(err.message); } finally { setSavingLiq(false); }
  }

  async function handleDeleteMov(id) {
    const ok = await confirm({ title: 'Eliminar movimiento', message: 'Si era una liquidación, se revierte la caja.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await tarjetasApi.deleteMovimiento(id); loadList(); loadDetalle(); } catch (err) { toast.error(err.message); }
  }

  const r = detalle?.resumen || {};
  const mon = detalle?.moneda || 'ARS';
  const sinTarjetas = !loadingList && list.length === 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Tarjetas de Crédito</h1>
          <div className="page-sub">Se carga solo desde Ventas · comisión de la financiera, neto que te deben y liquidaciones</div>
        </div>
        {!sinTarjetas && (
          <div className="page-actions">
            <div className="tabs">
              <button className={'tab' + (vista === 'general' ? ' active' : '')} onClick={() => setVista('general')}>General</button>
              <button className={'tab' + (vista === 'detalle' ? ' active' : '')} onClick={() => setVista('detalle')}>Detalle</button>
            </div>
          </div>
        )}
      </div>

      {sinTarjetas ? (
        <div className="card" style={{ padding: 24 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Todavía no hay tarjetas configuradas</div>
          <div className="muted" style={{ fontSize: 13 }}>
            Creá los métodos de pago tarjeta en <b>Cajas → Config Cajas</b> (tildá "Es tarjeta" y poné su % de comisión).
            Después, cada venta cobrada con ellos impacta acá automáticamente.
          </div>
        </div>
      ) : vista === 'general' ? (
        <>
          {/* KPIs globales */}
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Saldo a tu favor</div>
              <div className="kpi-value mono" style={{ color: 'var(--accent)' }}>$ {fmt(global.saldo)}</div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Comisión financiera</div>
              <div className="kpi-value mono" style={{ color: 'var(--neg)' }}>$ {fmt(global.comision)}</div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Ya recibido (liquidado)</div>
              <div className="kpi-value mono">$ {fmt(global.liquidado)}</div>
            </div>
            <div className="card card-tight" style={{ flex: 1 }}>
              <div className="kpi-label">Cobrado bruto</div>
              <div className="kpi-value mono">$ {fmt(global.bruto)}</div>
            </div>
          </div>

          {/* Resumen por tarjeta */}
          <div className="card card-flush" style={{ marginBottom: 14 }}>
            <div className="card-hd"><div style={{ fontWeight: 600, fontSize: 14 }}>Por tarjeta</div></div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Tarjeta</th><th style={{ textAlign: 'right' }}>Comisión</th>
                  <th style={{ textAlign: 'right' }}>Cobrado bruto</th><th style={{ textAlign: 'right' }}>Comisión $</th><th style={{ textAlign: 'right' }}>Te deben</th>
                </tr>
              </thead>
              <tbody>
                {list.map(t => (
                  <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => { setSelectedId(t.id); setVista('detalle'); }}>
                    <td style={{ fontWeight: 600 }}>{t.nombre}</td>
                    <td className="mono tiny" style={{ textAlign: 'right' }}>{Number(t.comision_pct || 0)}%</td>
                    <td className="mono" style={{ textAlign: 'right' }}>$ {fmt(t.bruto_total)}</td>
                    <td className="mono" style={{ textAlign: 'right', color: 'var(--neg)' }}>$ {fmt(t.comision_total)}</td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--accent)' }}>$ {fmt(t.saldo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Estado de cuenta unificado */}
          <div className="card card-flush">
            <div className="card-hd"><div style={{ fontWeight: 600, fontSize: 14 }}>Estado de cuenta</div></div>
            <div style={{ overflow: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Fecha</th><th>Tarjeta</th><th>Tipo</th>
                    <th style={{ textAlign: 'right' }}>Neto</th><th style={{ textAlign: 'right' }}>Saldo acum.</th><th>Origen</th>
                  </tr>
                </thead>
                <tbody>
                  {estadoCuenta.length === 0 && <tr><td colSpan={6} className="empty">Sin movimientos todavía.</td></tr>}
                  {estadoCuenta.map(m => (
                    <tr key={m.id}>
                      <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                      <td className="tiny">{m.metodo_nombre}</td>
                      <td><span className={'badge ' + (m.tipo === 'cobro' ? '' : 'badge-info')}>{m.tipo === 'cobro' ? 'Cobro' : 'Liquidación'}</span></td>
                      <td className="mono" style={{ textAlign: 'right', color: m.tipo === 'cobro' ? 'var(--accent)' : 'var(--neg)' }}>
                        {m.tipo === 'cobro' ? '+' : '−'} {sym(m.moneda)} {fmt(m.monto_neto)}
                      </td>
                      <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>$ {fmt(m.saldo_acum)}</td>
                      <td className="tiny">{m.venta_order_id ? `Venta ${m.venta_order_id}` : (m.caja_nombre || '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>
          {/* Lista de tarjetas (métodos de pago) */}
          <div className="card card-flush" style={{ maxHeight: '78vh', overflow: 'auto' }}>
            {list.map((t, i) => (
              <div key={t.id} onClick={() => setSelectedId(t.id)} style={{
                padding: '10px 13px', cursor: 'pointer',
                borderBottom: i < list.length - 1 ? '1px solid var(--hairline)' : 0,
                background: selectedId === t.id ? 'var(--surface-2)' : 'transparent',
                borderLeft: selectedId === t.id ? '3px solid var(--accent)' : '3px solid transparent',
              }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{t.nombre}</div>
                <div className="muted tiny" style={{ marginTop: 2 }}>Comisión {Number(t.comision_pct || 0)}%</div>
                <div className="mono tiny" style={{ marginTop: 2, color: Number(t.saldo) > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                  Te deben: {sym(t.moneda)} {fmt(t.saldo)}
                </div>
              </div>
            ))}
          </div>

          {/* Detalle */}
          {!detalle ? (
            <div className="card" style={{ minHeight: 200, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Elegí una tarjeta</div>
          ) : (
            <div className="stack" style={{ gap: 14 }}>
              <div className="card">
                <div style={{ fontWeight: 700, fontSize: 18 }}>{detalle.nombre}</div>
                <div className="muted tiny" style={{ marginTop: 4 }}>Comisión de la financiera: {Number(detalle.comision_pct || 0)}%</div>
              </div>

              <div className="row">
                <div className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">Te deben (falta cobrar)</div>
                  <div className="kpi-value mono" style={{ color: 'var(--accent)' }}>{sym(mon)} {fmt(r.saldo)}</div>
                </div>
                <div className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">Comisión financiera</div>
                  <div className="kpi-value mono" style={{ color: 'var(--neg)' }}>{sym(mon)} {fmt(r.comision_total)}</div>
                </div>
                <div className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">Cobrado (bruto)</div>
                  <div className="kpi-value mono">{sym(mon)} {fmt(r.bruto_total)}</div>
                </div>
                <div className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">Movimientos</div>
                  <div className="kpi-value mono">{r.movimientos || 0}</div>
                </div>
              </div>

              {/* Registrar liquidación (cuando nos pagan) */}
              <div className="card">
                <div className="card-hd"><div style={{ fontWeight: 600, fontSize: 14 }}>Registrar liquidación (te pagaron)</div></div>
                <form onSubmit={handleLiquidar} className="flex-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div className="field" style={{ width: 150 }}><label className="field-label tiny">Fecha</label><input type="date" className="input" value={liq.fecha} onChange={e => setLiq(f => ({ ...f, fecha: e.target.value }))} /></div>
                  <div className="field" style={{ width: 150 }}><label className="field-label tiny">Monto recibido</label><input type="number" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" placeholder="0" value={liq.monto} onChange={e => setLiq(f => ({ ...f, monto: e.target.value }))} /></div>
                  <div className="field" style={{ flex: 1, minWidth: 160 }}><label className="field-label tiny">Entra a la caja</label>
                    <select className="input" value={liq.caja_id} onChange={e => setLiq(f => ({ ...f, caja_id: e.target.value }))}>
                      <option value="">Elegí la caja…</option>
                      {cajas.filter(c => !c.es_tarjeta).map(c => <option key={c.id} value={c.id}>{c.nombre}{c.moneda ? ' · ' + c.moneda : ''}</option>)}
                      <CajaSelectHint />
                    </select>
                  </div>
                  <button className="btn btn-primary btn-sm" disabled={savingLiq} type="submit">{savingLiq ? '…' : 'Registrar'}</button>
                </form>
              </div>

              {/* Movimientos */}
              <div className="card card-flush">
                <div style={{ overflow: 'auto' }}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Fecha</th><th>Tipo</th><th style={{ textAlign: 'right' }}>Bruto</th><th style={{ textAlign: 'right' }}>Comisión</th>
                        <th style={{ textAlign: 'right' }}>Neto</th><th>Origen</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {movs.length === 0 && <tr><td colSpan={7} className="empty">Sin movimientos. Cobrá una venta con esta tarjeta.</td></tr>}
                      {movs.map(m => (
                        <tr key={m.id}>
                          <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                          <td><span className={'badge ' + (m.tipo === 'cobro' ? '' : 'badge-info')}>{m.tipo === 'cobro' ? 'Cobro' : 'Liquidación'}</span></td>
                          <td className="mono" style={{ textAlign: 'right' }}>{sym(m.moneda)} {fmt(m.monto_bruto)}</td>
                          <td className="mono tiny" style={{ textAlign: 'right', color: 'var(--neg)' }}>{Number(m.monto_comision) > 0 ? sym(m.moneda) + ' ' + fmt(m.monto_comision) : '—'}</td>
                          <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{sym(m.moneda)} {fmt(m.monto_neto)}</td>
                          <td className="tiny">{m.venta_order_id ? `Venta ${m.venta_order_id}` : (m.caja_nombre || '—')}</td>
                          <td><button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => handleDeleteMov(m.id)}><Icons.Trash size={13} /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

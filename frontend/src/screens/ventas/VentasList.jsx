// VentasList — tabla de ventas listadas con sus acciones inline (cambiar
// estado, editar, ver/descargar comprobante, eliminar).
//
// Componente PRESENTACIONAL — no maneja state propio. Recibe la lista y
// los handlers como props. El padre es dueño de la fuente de verdad.
//
// Diseño de columnas:
//   Estado | Fecha | Cliente | Productos | Pagos | Ganancia | Total | Acciones
//
// El selector de estado en la fila usa el mismo `changeEstado` que el resto
// del flow — cambiar acá dispara update + refresh igual que cambiar desde
// el modal de edición.
import { Icons } from '../../components/Icons';
import Badge from '../../components/Badge';
import { fmt } from '../../lib/format';
import { sym } from './utils';

export default function VentasList({
  lista,
  estadoBadge,
  changeEstado,
  openEdit,
  comprobantePDF,
  openComprob,
  deleteVenta,
}) {
  return (
    <div className="card card-flush">
      <table className="table">
        <thead>
          <tr>
            <th>Estado</th><th>Fecha</th><th>Cliente</th>
            <th>Productos</th><th>Pagos</th>
            <th>Ganancia</th><th>Total</th><th></th>
          </tr>
        </thead>
        <tbody>
          {lista.map(v => {
            // 2026-06-09: ahora la grilla incluye ventas B2B (movimientos_cc).
            // Difieren en: no tienen estado editable inline (siempre 'pendiente'
            // en esta vista — el saldo es por cliente, no por mov), no aplican
            // comprobantes, "Editar" abre el cliente en CuentasCC en vez del
            // modal de venta retail. Distinguimos con el origen y un badge.
            const esB2B = v.origen === 'b2b';
            return (
            <tr key={v.id}>
              <td>
                {estadoBadge(v.estado)}
                <div className="muted tiny mono" style={{ marginTop: 3 }}>{v.order_id}</div>
                {esB2B && (
                  <div style={{ marginTop: 4 }}>
                    <Badge tone="primary">B2B</Badge>
                  </div>
                )}
              </td>
              <td className="muted tiny" style={{ whiteSpace: 'nowrap' }}>
                {(v.fecha || '').substring(0, 10)}
                {v.hora ? <><br />{v.hora.substring(0, 5)}</> : ''}
              </td>
              <td>
                {v.cliente_nombre || '—'}
                {!esB2B && v.etiqueta_nombre && <><br /><Badge tone="default">{v.etiqueta_nombre}</Badge></>}
              </td>
              <td style={{ fontSize: 12 }}>
                {(v.items || []).map((i, k) => {
                  // 2026-06-09: costo + precio bajo el nombre del producto. Lucas
                  // pidió ver de un vistazo cuánto le costó vs cuánto vendió cada
                  // item. Retail usa `costo` + `precio_vendido`; B2B mapea ambos al
                  // mismo shape desde el backend.
                  // Items B2B devueltos vienen con devuelto_at != null — los
                  // tachamos para consistencia con el desglose del cliente.
                  const costo  = i.costo != null ? Number(i.costo) : null;
                  const precio = i.precio_vendido != null ? Number(i.precio_vendido) : null;
                  const mon    = i.moneda || 'USD';
                  const sufMon = mon === 'USD' ? 'u$s' : (mon === 'ARS' ? '$' : mon + ' ');
                  const devuelto = !!i.devuelto_at;
                  const itemStyle = devuelto
                    ? { marginBottom: 2, textDecoration: 'line-through', color: 'var(--text-muted)' }
                    : { marginBottom: 2 };
                  return (
                    <div key={k} style={itemStyle}>
                      <div>
                        {i.descripcion}{i.cantidad > 1 ? ' ×' + i.cantidad : ''}
                        {esB2B && i.imei && <span className="muted tiny mono" style={{ marginLeft: 6 }}>{i.imei}</span>}
                        {devuelto && (
                          <span style={{
                            marginLeft: 6, padding: '0 5px', borderRadius: 3,
                            background: 'var(--neg)', color: 'white', fontSize: 9,
                            textDecoration: 'none', fontWeight: 600, verticalAlign: 'middle',
                          }}>↺ Devuelto</span>
                        )}
                      </div>
                      {(costo != null || precio != null) && (
                        <div className="muted tiny" style={{ marginTop: 1 }}>
                          {costo  != null && <>costo {sufMon}{fmt(costo)}</>}
                          {costo != null && precio != null && <span style={{ margin: '0 4px', opacity: 0.5 }}>·</span>}
                          {precio != null && <>venta {sufMon}{fmt(precio)}</>}
                        </div>
                      )}
                    </div>
                  );
                })}
                {(v.canjes || []).map((c, k) => (
                  <div key={'c' + k} style={{ color: 'var(--warn)', fontSize: 11 }}>
                    ↺ {c.descripcion}
                  </div>
                ))}
              </td>
              <td className="muted" style={{ fontSize: 12 }}>
                {esB2B
                  ? <span className="tiny">Cuenta corriente</span>
                  : (v.pagos || []).map((p, k) => (
                      <div key={k}>{p.metodo_nombre}: {sym(p.moneda)}{fmt(p.monto)}</div>
                    ))}
              </td>
              <td className="mono pos" style={{ fontWeight: 600 }}>u$s{fmt(v.ganancia_usd)}</td>
              <td className="mono" style={{ fontWeight: 600 }}>u$s{fmt(v.total_usd)}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {!esB2B ? (
                  <>
                    <select
                      className="input"
                      style={{ width: 'auto', display: 'inline-block', padding: '4px 6px', fontSize: 11 }}
                      value={v.estado}
                      onChange={e => changeEstado(v.id, e.target.value)}
                    >
                      <option value="acreditado">Acreditado</option>
                      <option value="pendiente">Pendiente</option>
                      <option value="cancelado">Cancelado</option>
                    </select>{' '}
                  </>
                ) : (
                  <span className="muted tiny" style={{ marginRight: 6 }}>—</span>
                )}
                <button className="icon-btn" title={esB2B ? 'Ir al cliente B2B' : 'Editar venta'} onClick={() => openEdit(v)}>
                  <Icons.Edit size={14} />
                </button>
                {!esB2B && (
                  <button className="icon-btn" title="Comprobante (imprimir/PDF)" onClick={() => comprobantePDF(v)}>
                    <Icons.Print size={14} />
                  </button>
                )}
                {!esB2B && Number(v.comprobantes_count) > 0 && (
                  <button className="icon-btn" title="Comprobantes adjuntos" onClick={() => openComprob(v.id)}>
                    <Icons.Eye size={14} />
                  </button>
                )}
                <button
                  className="icon-btn"
                  style={{ color: 'var(--neg)' }}
                  title="Eliminar"
                  onClick={() => deleteVenta(v)}
                >
                  <Icons.Trash size={14} />
                </button>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

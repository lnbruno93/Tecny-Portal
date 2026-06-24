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

// 2026-06-24: removida la prop `estadoBadge` — el componente renderiza el
// estado como <select> estilizado inline (línea ~58), no usa el helper Badge.
// La prop seguía declarada como dead code desde el rediseño 2026-06-09/10
// "estado editable inline". El caller (Ventas.jsx) sigue pasándola; React
// ignora props extra — limpieza del caller queda como follow-up.
export default function VentasList({
  lista,
  changeEstado,
  openEdit,
  comprobantePDF,
  openComprob,
  deleteVenta,
  confirmarEntrega,
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
            // 2026-06-09/10: grilla unificada retail + B2B con estado editable
            // inline en el badge de la izquierda (no select extra a la derecha).
            // El select se estiliza como badge y cambia de color al variar:
            //   acreditado → verde · pendiente → amarillo · cancelado → rojo
            // B2B solo tiene 2 opciones (acreditado/pendiente); retail tiene 3.
            const esB2B = v.origen === 'b2b';
            const estadoTone = { acreditado: 'pos', pendiente: 'warn', cancelado: 'neg' }[v.estado] || 'default';
            // Mismos colores que usa el componente Badge — replicamos inline
            // para que el <select> herede el look pero siga siendo nativo.
            const estadoColors = {
              pos:     { bg: 'rgba(34,197,94,0.12)',  fg: 'var(--pos)',  bd: 'rgba(34,197,94,0.45)' },
              warn:    { bg: 'rgba(245,158,11,0.14)', fg: 'var(--warn, #f59e0b)', bd: 'rgba(245,158,11,0.45)' },
              neg:     { bg: 'rgba(220,38,38,0.12)',  fg: 'var(--neg)',  bd: 'rgba(220,38,38,0.45)' },
              default: { bg: 'var(--surface-2)',      fg: 'var(--text-muted)', bd: 'var(--border)' },
            }[estadoTone];
            return (
            <tr key={v.id}>
              <td>
                <select
                  value={v.estado}
                  onChange={e => changeEstado(v, e.target.value)}
                  title="Cambiar estado"
                  style={{
                    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
                    background: estadoColors.bg, color: estadoColors.fg,
                    border: `1px solid ${estadoColors.bd}`,
                    borderRadius: 12, padding: '2px 22px 2px 9px',
                    fontSize: 11, fontWeight: 600, lineHeight: 1.4,
                    cursor: 'pointer', outline: 'none',
                    // Flechita custom para que se vea claramente que es editable.
                    backgroundImage: 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'10\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'3\'><polyline points=\'6 9 12 15 18 9\'/></svg>")',
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'right 6px center',
                    backgroundSize: '10px 10px',
                  }}
                >
                  <option value="acreditado">Acreditado</option>
                  <option value="pendiente">Pendiente</option>
                  {!esB2B && <option value="cancelado">Cancelado</option>}
                </select>
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
                {/* 2026-06-10: select de estado movido al badge de la izquierda.
                    Esta celda solo tiene íconos de acción ahora. */}
                {/* "Confirmar entrega": solo cuando la venta nació de un envío
                    todavía no entregado ni cancelado. En 1 click marca envío
                    como 'Entregado' y la venta pasa a 'acreditado' (entra al
                    neto del día). */}
                {confirmarEntrega && v.envio?.id && v.envio.estado !== 'Entregado' && v.envio.estado !== 'Cancelado' && (
                  <button
                    className="btn btn-sm"
                    style={{ marginRight: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}
                    title="Confirmar entrega del envío y acreditar la venta"
                    onClick={() => confirmarEntrega(v)}
                  >
                    ✓ Confirmar entrega
                  </button>
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

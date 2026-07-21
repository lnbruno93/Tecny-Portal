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
//
// Auditoría 2026-07-05 TANDA 1 sub-fase C (Performance P1 #5): fila extraída
// a componente memoizado `VentaRow`. Para que el memo evite re-renders debe
// ir acompañado de `useCallback` en los handlers del caller (Ventas.jsx).
// El caller HOY define los handlers como funciones inline dentro del
// componente — se recrean cada render, por lo que el memo se invalida.
// La memoización preventiva queda igual porque: (a) es la buena práctica
// estructural, (b) beneficia cuando el caller migre a useCallback,
// (c) reduce el trabajo de reconciliación al no reconstruir el árbol de
// JSX inline cada render (aunque re-render, la comparación es más rápida).
// Follow-up: envolver los 7 handlers en useCallback en Ventas.jsx.
import { memo } from 'react';
import { Icons } from '../../components/Icons';
import Badge from '../../components/Badge';
import { fmt, fmtImei } from '../../lib/format';
import { sym } from './utils';

// Colores del "badge" de estado, replicados inline para que el <select>
// nativo herede el look de Badge sin perder accesibilidad. Definidos a nivel
// de módulo para no reconstruir el objeto por fila.
const ESTADO_COLORS = {
  pos:     { bg: 'rgba(34,197,94,0.12)',  fg: 'var(--pos)',           bd: 'rgba(34,197,94,0.45)' },
  warn:    { bg: 'rgba(245,158,11,0.14)', fg: 'var(--warn, #f59e0b)', bd: 'rgba(245,158,11,0.45)' },
  neg:     { bg: 'rgba(220,38,38,0.12)',  fg: 'var(--neg)',           bd: 'rgba(220,38,38,0.45)' },
  default: { bg: 'var(--surface-2)',      fg: 'var(--text-muted)',    bd: 'var(--border)' },
};
const ESTADO_TONE_BY_ESTADO = { acreditado: 'pos', pendiente: 'warn', cancelado: 'neg' };

// Flechita SVG del <select> — string estático para evitar reconstruirlo por fila.
const SELECT_ARROW_BG =
  'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'10\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'3\'><polyline points=\'6 9 12 15 18 9\'/></svg>")';

// Fila individual — memoizada. Sólo re-renderea cuando cambian sus props.
// Si el caller usa useCallback para los handlers, sólo la fila que cambió
// (`v` mutado) se re-renderea; las demás quedan intactas.
const VentaRow = memo(function VentaRow({
  v,
  showGanancia,
  changeEstado,
  openEdit,
  comprobantePDF,
  openComprob,
  deleteVenta,
  confirmarEntrega,
  openEditarVendedor,
}) {
  // 2026-06-09/10: grilla unificada retail + B2B con estado editable
  // inline en el badge de la izquierda (no select extra a la derecha).
  // El select se estiliza como badge y cambia de color al variar:
  //   acreditado → verde · pendiente → amarillo · cancelado → rojo
  // B2B solo tiene 2 opciones (acreditado/pendiente); retail tiene 3.
  const esB2B = v.origen === 'b2b';
  const estadoTone = ESTADO_TONE_BY_ESTADO[v.estado] || 'default';
  const estadoColors = ESTADO_COLORS[estadoTone];
  return (
    <tr>
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
            backgroundImage: SELECT_ARROW_BG,
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
          <div className="u-mt-4">
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
      <td className="u-fs-12">
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
                {/* 2026-06-24: IMEI ahora se muestra también para retail
                    (antes solo B2B). El user pidió ver el IMEI en el
                    listado de ventas para identificar el equipo de un
                    vistazo, especialmente útil con canjes en parte de
                    pago. Para batería de items retail necesitamos un
                    backend join con productos (queda como follow-up). */}
                {i.imei && <span className="muted tiny mono" style={{ marginLeft: 6 }}>IMEI {fmtImei(i.imei)}</span>}
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
        {/* 2026-06-24: enriquecer la fila del canje con IMEI, batería y
            sobre todo el valor del Tomado (lo que pagaste por el equipo
            recibido). Antes solo se veía "↺ iPhone 17" sin precio —
            Lucas pidió ver "Tomado: $410" igual que su referencia. */}
        {(v.canjes || []).map((c, k) => {
          const cMon    = c.moneda || 'USD';
          const cSufMon = cMon === 'USD' ? 'u$s' : (cMon === 'ARS' ? '$' : cMon + ' ');
          const valTom  = c.valor_toma != null ? Number(c.valor_toma) : 0;
          return (
            <div key={'c' + k} style={{ color: 'var(--warn)', fontSize: 11, marginTop: 4 }}>
              <div>
                ↺ {c.descripcion}
                {c.imei && <span className="muted tiny mono" style={{ marginLeft: 6, color: 'var(--warn)' }}>IMEI {fmtImei(c.imei)}</span>}
                {c.bateria != null && c.bateria > 0 && (
                  <span className="muted tiny" style={{ marginLeft: 6, color: 'var(--warn)' }}>· 🔋 {c.bateria}%</span>
                )}
              </div>
              {valTom > 0 && (
                <div className="tiny" style={{ marginTop: 1, fontWeight: 600 }}>
                  Tomado: {cSufMon}{fmt(valTom)}
                </div>
              )}
            </div>
          );
        })}
      </td>
      <td className="muted u-fs-12">
        {esB2B
          ? <span className="tiny">Cuenta corriente</span>
          : (v.pagos || []).map((p, k) => (
              <div key={k}>{p.metodo_nombre}: {sym(p.moneda)}{fmt(p.monto)}</div>
            ))}
      </td>
      {showGanancia && (
        <td className="mono pos u-fw-600">u$s{fmt(v.ganancia_usd)}</td>
      )}
      <td className="mono u-fw-600">u$s{fmt(v.total_usd)}</td>
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
        {/* #509 — Editar vendedor del comprobante. Solo retail (B2B no
            imprime este comprobante). Icono Users pega bien conceptualmente. */}
        {!esB2B && openEditarVendedor && (
          <button className="icon-btn" title="Editar vendedor del comprobante" onClick={() => openEditarVendedor(v)}>
            <Icons.Users size={14} />
          </button>
        )}
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
          className="icon-btn u-color-neg"
          title="Eliminar"
          onClick={() => deleteVenta(v)}
        >
          <Icons.Trash size={14} />
        </button>
      </td>
    </tr>
  );
});

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
  // #509 — abre el modal focalizado para editar solo el nombre del vendedor
  // que sale en el comprobante. Opcional: si no se pasa, no renderizamos el botón.
  openEditarVendedor,
}) {
  // 2026-07-04 (ventas.ver_ganancias): backend redacta `ganancia_usd` cuando
  // el user no tiene la cap. Si ninguna fila lo trae, ocultamos la columna
  // entera (header + celda). Detectamos por presencia de la key en la
  // primera fila — todas vienen del mismo shape unificado del endpoint.
  // Owner/admin: siempre presente (bypass). Vendedor sin override: siempre
  // ausente. No mezclamos filas con/sin — todas responden al mismo user.
  const showGanancia = lista.length > 0 && 'ganancia_usd' in lista[0];
  return (
    <div className="card card-flush">
      <table className="table">
        <thead>
          <tr>
            <th>Estado</th><th>Fecha</th><th>Cliente</th>
            <th>Productos</th><th>Pagos</th>
            {showGanancia && <th data-testid="th-ganancia">Ganancia</th>}
            <th>Total</th><th></th>
          </tr>
        </thead>
        <tbody>
          {lista.map(v => (
            <VentaRow
              key={v.id}
              v={v}
              showGanancia={showGanancia}
              changeEstado={changeEstado}
              openEdit={openEdit}
              comprobantePDF={comprobantePDF}
              openComprob={openComprob}
              deleteVenta={deleteVenta}
              confirmarEntrega={confirmarEntrega}
              openEditarVendedor={openEditarVendedor}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

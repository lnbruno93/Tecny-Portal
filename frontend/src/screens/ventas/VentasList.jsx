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

// Sprint 87 CSP: el color del select de estado ahora se resuelve por clase
// `.u-vlist-estado-select.u-vlist-estado-{tone}`. Bg / fg / border + la
// flecha SVG del select viven en styles.css. Mantengo solo el mapping
// estado → tone acá porque depende del valor del enum.
const ESTADO_TONE_BY_ESTADO = { acreditado: 'pos', pendiente: 'warn', cancelado: 'neg' };

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
  return (
    <tr>
      <td>
        <select
          value={v.estado}
          onChange={e => changeEstado(v, e.target.value)}
          title="Cambiar estado"
          className={`u-vlist-estado-select u-vlist-estado-${estadoTone}`}
        >
          <option value="acreditado">Acreditado</option>
          <option value="pendiente">Pendiente</option>
          {!esB2B && <option value="cancelado">Cancelado</option>}
        </select>
        <div className="muted tiny mono u-mt-3">{v.order_id}</div>
        {esB2B && (
          <div className="u-mt-4">
            <Badge tone="primary">B2B</Badge>
          </div>
        )}
      </td>
      <td className="muted tiny u-nowrap">
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
          return (
            <div key={k} className={'u-vlist-item' + (devuelto ? ' u-vlist-item-devuelto' : '')}>
              <div>
                {i.descripcion}{i.cantidad > 1 ? ' ×' + i.cantidad : ''}
                {/* 2026-06-24: IMEI ahora se muestra también para retail
                    (antes solo B2B). El user pidió ver el IMEI en el
                    listado de ventas para identificar el equipo de un
                    vistazo, especialmente útil con canjes en parte de
                    pago. Para batería de items retail necesitamos un
                    backend join con productos (queda como follow-up). */}
                {i.imei && <span className="muted tiny mono u-ml-6">IMEI {fmtImei(i.imei)}</span>}
                {devuelto && (
                  <span className="u-vlist-devuelto-badge">↺ Devuelto</span>
                )}
              </div>
              {(costo != null || precio != null) && (
                <div className="muted tiny u-vlist-item-cost-row">
                  {costo  != null && <>costo {sufMon}{fmt(costo)}</>}
                  {costo != null && precio != null && <span className="u-vlist-item-sep">·</span>}
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
            <div key={'c' + k} className="u-vlist-canje-row">
              <div>
                ↺ {c.descripcion}
                {c.imei && <span className="muted tiny mono u-ml-6-color-warn">IMEI {fmtImei(c.imei)}</span>}
                {c.bateria != null && c.bateria > 0 && (
                  <span className="muted tiny u-ml-6-color-warn">· 🔋 {c.bateria}%</span>
                )}
              </div>
              {valTom > 0 && (
                <div className="tiny u-vlist-canje-tomado">
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
      <td className="u-text-right-nowrap">
        {/* 2026-06-10: select de estado movido al badge de la izquierda.
            Esta celda solo tiene íconos de acción ahora. */}
        {/* "Confirmar entrega": solo cuando la venta nació de un envío
            todavía no entregado ni cancelado. En 1 click marca envío
            como 'Entregado' y la venta pasa a 'acreditado' (entra al
            neto del día). */}
        {confirmarEntrega && v.envio?.id && v.envio.estado !== 'Entregado' && v.envio.estado !== 'Cancelado' && (
          <button
            className="btn btn-sm u-vlist-btn-confirmar"
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

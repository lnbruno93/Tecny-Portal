/**
 * MovimientoCCDetalleModal — vista de detalle de un movimiento B2B (cuentas
 * corrientes de clientes).
 *
 * Fase A (pedido Lautaro Bisman 2026-08-03): vista read-only con todos los
 * items del movimiento, notas, fecha, monto total. Mismo patrón visual del
 * CompraProveedorDetalleModal (task #261) — reusable UX que el user ya conoce.
 *
 * Fase B (deferred): edit inline de items + sync inventario. Simétrico a la
 * Fase B del proveedores (task #262). No es urgente porque los movimientos
 * B2B ya se pueden anular (delete) y recargar si el user necesita corregir.
 *
 * Contexto: en CuentasCC.jsx (tab B2B), cada fila de la tabla de movimientos
 * muestra los campos principales (fecha, tipo, primer producto, monto). Si
 * la venta tuvo varios items, solo se veía el primero + "+N" a menos que el
 * user expandiera el drilldown inline (chevron). Este modal es una vista
 * alternativa más limpia y accesible desde click en la fila completa.
 */
import { useRef, useEffect } from 'react';
import useModal from '../lib/useModal';
import { Icons } from './Icons';

// Formato helper — matchea el pattern del CompraProveedorDetalleModal.
function fmt(n) {
  const num = Number(n);
  if (!isFinite(num)) return '—';
  return num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtFecha(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

// Etiqueta del tipo — matchea TIPO_DISPLAY.label de CuentasCC.jsx. Se
// duplica intencionalmente acá (no import) porque el modal es autónomo
// y el TIPO_DISPLAY de CuentasCC tiene lógica extra (tone/signo) que no
// aplica al modal.
const TIPO_LABEL = {
  compra:              'Compra',
  pago:                'Cobro',   // "Me pagan" en la tabla, "Cobro" en el modal es más neutro
  devolucion:          'Devolución',
  parte_de_pago:       'Parte de pago',
  entrega_mercaderia:  'Entrega de mercadería',
  saldo_inicial:       'Saldo inicial',
  mercaderia_recibida: 'Mercadería recibida',
};

export default function MovimientoCCDetalleModal({ movimiento, cliente, onClose }) {
  const overlayRef = useRef(null);

  // useModal: cierre por Escape + click fuera. Mismo pattern del resto.
  useModal({ open: true, onClose, overlayRef });

  // Foco inicial en el botón Cerrar cuando abre — mejora accesibilidad.
  const closeBtnRef = useRef(null);
  useEffect(() => {
    if (closeBtnRef.current) closeBtnRef.current.focus();
  }, []);

  if (!movimiento) return null;

  const items = Array.isArray(movimiento.items) ? movimiento.items : [];
  const tipoLabel = TIPO_LABEL[movimiento.tipo] || movimiento.tipo;

  // Suma de valores de items — útil para chequear que matchee monto_total
  // (puede haber discrepancias legítimas si hubo descuentos/ajustes).
  const sumaItems = items.reduce((sum, it) => sum + (Number(it.valor) || 0), 0);
  const montoTotal = Number(movimiento.monto_total) || 0;
  const hayDiscrepancia = items.length > 0 && Math.abs(sumaItems - montoTotal) > 0.01;

  return (
    <div ref={overlayRef} className="modal-overlay" role="dialog" aria-modal="true"
         aria-labelledby="mov-cc-detalle-title"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal u-mw-720" onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <div>
            <h3 id="mov-cc-detalle-title">
              {tipoLabel} — {fmtFecha(movimiento.fecha)}
            </h3>
            <div className="page-sub">
              {cliente?.nombre} {cliente?.apellido || ''}
              {' · '}
              <span className="mono">USD {fmt(montoTotal)}</span>
              {movimiento.descripcion && (
                <> {' · '}<span className="muted">{movimiento.descripcion}</span></>
              )}
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Cerrar"
            title="Cerrar"
          >
            <Icons.X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {movimiento.notas && (
            <div className="field">
              <div className="field-label">Notas</div>
              <div className="u-color-text-2">{movimiento.notas}</div>
            </div>
          )}

          {items.length === 0 && (
            <div className="u-empty-p-24-16">
              Este movimiento no tiene productos asociados (pago, ajuste, o registro
              sin desglose).
            </div>
          )}

          {items.length > 0 && (
            <div className="u-overflow-auto">
              <table className="table u-fs-13">
                <thead>
                  <tr>
                    <th className="u-fs-12">Producto</th>
                    <th className="u-fs-12">Modelo</th>
                    <th className="u-fs-12">Cap.</th>
                    <th className="u-fs-12">Color</th>
                    <th className="u-fs-12">IMEI / Serial</th>
                    <th className="u-fs-12 u-td-right-fw-700">Valor USD</th>
                    <th className="u-fs-12 u-text-center">✓</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => (
                    <tr key={it.id ?? idx}>
                      <td>
                        {it.producto || <span className="dim">—</span>}
                        {it.notas && <div className="muted tiny">{it.notas}</div>}
                      </td>
                      <td className="u-color-text-2">{it.modelo || <span className="dim">—</span>}</td>
                      <td className="u-color-text-2">{it.tamano || <span className="dim">—</span>}</td>
                      <td className="u-color-text-2">{it.color || <span className="dim">—</span>}</td>
                      <td className="u-mono u-fs-12">{it.imei_serial || <span className="dim">—</span>}</td>
                      <td className="u-td-right-fw-700 mono">
                        {it.valor != null ? fmt(it.valor) : <span className="dim">—</span>}
                      </td>
                      <td className="u-text-center">
                        {it.verificado
                          ? <span className="u-color-pos-fs-14" title="Verificado">✓</span>
                          : <span className="dim u-fs-11">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {items.length > 1 && (
                  <tfoot>
                    <tr>
                      <td colSpan={5} className="u-td-right-fw-700 muted">
                        Suma de valores ({items.length} items):
                      </td>
                      <td className="u-td-right-fw-700 mono">USD {fmt(sumaItems)}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
              {hayDiscrepancia && (
                <div className="muted tiny u-mt-8">
                  Nota: el monto total (USD {fmt(montoTotal)}) difiere de la suma de
                  items — puede ser normal si hubo descuentos, ajustes o si algunos
                  items se registraron sin valor.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-ft">
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

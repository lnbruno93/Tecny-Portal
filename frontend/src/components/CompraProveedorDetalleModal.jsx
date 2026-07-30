/**
 * CompraProveedorDetalleModal — vista read-only del detalle completo de una
 * compra (o cualquier movimiento con items) a proveedor.
 *
 * Fase A del pedido de Gianfranco Amato (2026-07-30):
 *   > "Necesito poder ver las compras enteras y no la cantidad de productos
 *   > (+3) y que haya un botón para editar las compras"
 *
 * Este modal cubre la primera mitad: mostrar TODOS los items de la compra
 * (producto, modelo, capacidad, color, IMEI/serial, valor, verificado, notas).
 * La grid del listado de proveedor.jsx solo muestra el primer item + "+N"
 * porque el ancho no alcanza para N filas — este modal desglosa.
 *
 * La segunda mitad (edición) queda en task backlog: requiere endpoint PUT
 * backend + guards (productos ya vendidos no removibles, ajuste de saldo y
 * caja si era contado). ~5-7h de scope aparte.
 *
 * Aplica cuando `movimiento.items?.length > 0` — tipos que califican:
 *   - compra   (canon: N productos comprados)
 *   - devolucion (N productos devueltos al proveedor)
 *   - entrega_mercaderia (N productos entregados como pago)
 *
 * Otros tipos (pago, saldo_inicial, relevo_*) no tienen items → no se
 * renderiza el trigger de apertura.
 *
 * Estilo: sigue el pattern de RelevoProveedorModal (mismo tenant visual —
 * useModal, modal-hd + modal-body, botón Cerrar en el footer).
 */
import { useRef } from 'react';
import useModal from '../lib/useModal';
import { Icons } from './Icons';

// Formato helper compartido con la grilla.
function fmt(n) {
  const num = Number(n);
  if (!isFinite(num)) return '—';
  return num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Etiqueta del tipo — matchea TIPO_DISPLAY de Proveedores.jsx (labels visibles).
const TIPO_LABEL = {
  compra: 'Compra',
  devolucion: 'Devolución',
  entrega_mercaderia: 'Entrega de mercadería',
};

function fmtFecha(iso) {
  if (!iso) return '—';
  // Backend devuelve 'YYYY-MM-DD' — mostramos DD/MM/YY consistente con la grilla.
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

export default function CompraProveedorDetalleModal({ movimiento, proveedor, onClose }) {
  const overlayRef = useRef(null);
  useModal({ open: !!movimiento, onClose, overlayRef });

  if (!movimiento) return null;

  const items = movimiento.items || [];
  const tipoLabel = TIPO_LABEL[movimiento.tipo] || movimiento.tipo;
  const isCredito = !movimiento.caja_id; // sin caja → suma deuda (CC)
  const cajaText = movimiento.caja_nombre || (isCredito ? 'A crédito (CC)' : '—');

  // Total sumando valores de items — sanity check contra `monto` del movimiento.
  // Si difiere, mostramos ambos para que el operador se dé cuenta.
  const sumaItemsMoneda = items.reduce((acc, it) => acc + (Number(it.valor) || 0), 0);
  const montoMovMoneda  = Number(movimiento.monto) || 0;
  const hayDiscrepancia = items.length > 0 && Math.abs(sumaItemsMoneda - montoMovMoneda) > 0.01;

  return (
    <div className="modal-overlay" ref={overlayRef} onMouseDown={(e) => {
      if (e.target === overlayRef.current) onClose();
    }}>
      <div className="modal u-mw-720" role="dialog" aria-labelledby="compra-detalle-title">
        <div className="modal-hd">
          <div>
            <h3 id="compra-detalle-title">
              {tipoLabel} — {fmtFecha(movimiento.fecha)}
            </h3>
            <div className="page-sub">
              {proveedor?.nombre || 'Proveedor'}
              {' · '}
              <span className="mono">USD {fmt(movimiento.monto_usd)}</span>
              {' · '}
              <span className="muted">{cajaText}</span>
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar" title="Cerrar">
            <Icons.X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Notas del movimiento — si el usuario cargó texto libre. */}
          {movimiento.notas && (
            <div className="field">
              <div className="field-label">Notas</div>
              <div className="u-color-text-2">{movimiento.notas}</div>
            </div>
          )}

          {/* Grid de items */}
          {items.length === 0 ? (
            <div className="u-empty-p-24-16">
              Este movimiento no tiene productos asociados.
            </div>
          ) : (
            <div className="u-overflow-auto">
              <table className="table u-fs-13">
                <thead>
                  <tr>
                    <th className="u-fs-12">Producto</th>
                    <th className="u-fs-12">Modelo</th>
                    <th className="u-fs-12">Cap.</th>
                    <th className="u-fs-12">Color</th>
                    <th className="u-fs-12">IMEI / Serial</th>
                    <th className="u-fs-12 u-td-right-fw-700">Valor</th>
                    <th className="u-fs-12 u-text-center">✓</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => (
                    <tr key={it.id ?? idx}>
                      <td>
                        {it.producto || <span className="dim">—</span>}
                        {it.notas && (
                          <div className="muted tiny">{it.notas}</div>
                        )}
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
                      <td className="u-td-right-fw-700 mono">
                        {fmt(sumaItemsMoneda)}
                        {movimiento.moneda && ` ${movimiento.moneda}`}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
              {hayDiscrepancia && (
                <div className="muted tiny u-mt-8">
                  Nota: el monto del movimiento ({fmt(montoMovMoneda)} {movimiento.moneda || ''}) difiere
                  de la suma de items — puede ser normal si la compra incluyó descuentos, envío o ajustes
                  que no están imputados a un producto específico.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-ft">
          <button
            type="button"
            className="btn btn-ghost"
            disabled
            title="Próximamente — por ahora podés eliminar la compra y volver a cargarla."
            aria-label="Editar (próximamente)"
          >
            <Icons.Edit size={14} /> Editar (próximamente)
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

// EditarVendedorModal — edita SOLO el nombre del vendedor mostrado en el
// comprobante impreso (#509). No re-corre los sync de caja/CC/etc del PUT
// completo — llama al PATCH focalizado /api/ventas/:id/vendedor-nombre.
//
// Contexto de negocio: el comprobante muestra "ATENDIDO POR ..." a partir
// del vendedor_id del primer item con vendedor. Owners piden poder editar
// ese label (o poner iniciales, o un nombre distinto) sin tocar el catálogo
// real de vendedores. Este modal es esa entrada de UI.
//
// Estado esperado en el padre:
//   const [editarVendedor, setEditarVendedor] = useState({ open: false, venta: null });
//   const openEditarVendedor = (v) => setEditarVendedor({ open: true, venta: v });
//   const closeEditarVendedor = () => setEditarVendedor({ open: false, venta: null });
//
// Pattern coherente con DiffModal / ExitoModal: useModal para Esc + body lock,
// overlayRef en el div overlay, click-outside cierra (e.target===currentTarget).
import { useRef, useState, useEffect } from 'react';
import useModal from '../../lib/useModal';

export default function EditarVendedorModal({ state, onClose, onSave, vendedores = [] }) {
  const overlayRef = useRef(null);
  useModal({ open: state.open, onClose, overlayRef });
  const venta = state.venta;

  // Nombre efectivo actual: prioriza el override en la venta, cae al fallback
  // derivado del vendedor_id del primer item (mismo cálculo que el PDF).
  const fallbackNombre = (() => {
    if (!venta) return '';
    if (venta.vendedor_nombre) return venta.vendedor_nombre;
    const vendedorId = (venta.items || []).find(i => i.vendedor_id)?.vendedor_id;
    if (!vendedorId) return '';
    return vendedores.find(x => String(x.id) === String(vendedorId))?.nombre || '';
  })();

  const [valor, setValor] = useState(fallbackNombre);
  const [guardando, setGuardando] = useState(false);

  // Re-sincronizamos cada vez que se abre el modal con una venta distinta
  // (evita mostrar el valor de la venta previa si el user abrió → cerró → abrió otra).
  useEffect(() => {
    if (state.open) {
      setValor(fallbackNombre);
      setGuardando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, venta?.id]);

  if (!state.open || !venta) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    if (guardando) return;
    setGuardando(true);
    try {
      // Empty string → null (borra el override → PDF vuelve al fallback).
      const trimmed = valor.trim();
      await onSave(venta.id, trimmed ? trimmed : null);
      onClose();
    } catch (err) {
      // El padre muestra el toast — acá solo desbloqueamos el botón.
      setGuardando(false);
    }
  }

  function handleOverlayClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      ref={overlayRef}
      className="modal-overlay u-z-600"
      role="dialog"
      aria-modal="true"
      aria-labelledby="editar-vendedor-title"
      onClick={handleOverlayClick}
    >
      <div className="modal u-mw-460" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="modal-hd">
            <h3 id="editar-vendedor-title">Editar vendedor del comprobante</h3>
          </div>
          <div className="modal-body u-ev-body">
            <p className="u-ev-help">
              Cambia el nombre que aparece en la línea "ATENDIDO POR" del comprobante impreso.
              No afecta reportería ni el vendedor asignado en los ítems.
            </p>
            <label className="u-ev-label">
              Nombre a mostrar
            </label>
            {/* Fix incidental: había 2 className props — el primero ('input')
                era silenciosamente ignorado por React. Consolidado en uno. */}
            <input
              type="text"
              className="input u-w-100"
              value={valor}
              onChange={e => setValor(e.target.value)}
              placeholder="Ej: Lautaro B. — o dejar vacío para volver al automático"
              maxLength={120}
              autoFocus
              disabled={guardando}
            />
            <div className="u-ev-hint">
              Máx. 120 caracteres. Vacío = usar el vendedor asignado en los ítems.
            </div>
          </div>
          <div className="modal-ft u-gap-8-justify-end">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={guardando}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-primary" disabled={guardando}>
              {guardando ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

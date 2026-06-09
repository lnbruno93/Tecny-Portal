/**
 * DiagnoseStockPanel — diagnostica y restaura productos del stock.
 *
 * Vive dentro de Config → Mantenimiento (solo admin). Surgió el 2026-06-09
 * tras el bug de los 7 productos que quedaron en estado='vendido' después
 * de borrar la venta B2B que los descontó: no había forma sin abrir SQL
 * directo de inspeccionar el historial completo de un producto.
 *
 * Flow:
 *   1. Operador pega un IMEI/serial → "Diagnosticar".
 *   2. Mostramos TODOS los productos con ese IMEI (incluso soft-deleted) +
 *      el árbol completo de items_movimiento_cc que los referencian, con
 *      info del movimiento padre (vivo o borrado) y cliente.
 *   3. Si un producto vivo quedó en estado='vendido' por error, el botón
 *      "Restaurar al stock" abre un modal que pide cantidad + razón (mínimo
 *      5 chars, auditado en audit_logs).
 */
import { useState, useRef } from 'react';
import { admin as adminApi } from '../../lib/api';
import { Icons } from '../Icons';
import { useToast } from '../../contexts/ToastContext';
import { useModal } from '../../lib/useModal';

function fmtDateTime(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return s;
  }
}

function fmtDate(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleDateString('es-AR');
  } catch {
    return s;
  }
}

function fmtMoney(n, moneda = 'USD') {
  const v = (Number(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${moneda === 'USD' ? 'US$' : '$'} ${v}`;
}

// ─── Modal de restore ────────────────────────────────────────────────────────
function RestoreModal({ producto, onClose, onDone }) {
  const { toast } = useToast();
  const [cantidad, setCantidad] = useState(1);
  const [reason, setReason]     = useState('');
  const [submitting, setSubmitting] = useState(false);
  const overlayRef = useRef(null);
  const reasonOk = reason.trim().length >= 5;

  useModal({ open: true, onClose, overlayRef });

  async function handleRestore() {
    if (!reasonOk) return;
    setSubmitting(true);
    try {
      const r = await adminApi.restoreProducto({
        producto_id: producto.id,
        cantidad: Number(cantidad) || 1,
        reason: reason.trim(),
      });
      toast.success(`Producto restaurado: ${r.producto.nombre} (cantidad ${r.producto.cantidad}).`);
      onDone(r.producto);
    } catch (e) {
      toast.error(e.message || 'No se pudo restaurar el producto.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="restore-modal-title"
      style={{ zIndex: 500 }}
    >
      <div
        className="modal"
        style={{ maxWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-hd">
          <h3 id="restore-modal-title" style={{ margin: 0 }}>Restaurar producto al stock</h3>
        </div>
        <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
          <div style={{ padding: 10, background: 'var(--surface-2)', borderRadius: 6, fontSize: 13 }}>
            <div><b>{producto.nombre}</b></div>
            <div className="tiny muted">IMEI: <span className="mono">{producto.imei || '—'}</span></div>
            <div className="tiny muted">
              Estado actual: <b style={{ color: 'var(--neg)' }}>{producto.estado}</b> · cantidad {producto.cantidad}
            </div>
          </div>

          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Cantidad a restaurar</span>
            <input
              type="number" min="1" step="1"
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
              disabled={submitting}
            />
            <span className="tiny muted">Para unitarios (celulares, tablets) dejar en 1.</span>
          </label>

          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Razón <span style={{ color: 'var(--neg)' }}>*</span>
            </span>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder='Ej: "limpieza bug venta B2B iConnect 2026-06-09"'
              disabled={submitting}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
              data-autofocus
            />
            <span className="tiny muted">
              Obligatoria, mínimo 5 caracteres. Queda en audit_logs.
            </span>
          </label>
        </div>
        <div className="modal-ft" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancelar</button>
          <button
            className="btn btn-primary"
            onClick={handleRestore}
            disabled={!reasonOk || submitting}
          >
            {submitting ? 'Restaurando…' : 'Confirmar restauración'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Render por producto + su trail ──────────────────────────────────────────
function ProductoCard({ producto, trail, onRestore }) {
  const esVivo    = !producto.deleted_at;
  const esVendido = producto.estado === 'vendido';
  const puedeRestaurar = esVivo && esVendido;
  return (
    <div
      style={{
        border: '1px solid var(--border)', borderRadius: 8, padding: 14,
        marginBottom: 12, background: 'var(--surface-1)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {producto.nombre}
            <span className="tiny muted" style={{ marginLeft: 8 }}>#{producto.id}</span>
          </div>
          <div className="tiny muted" style={{ marginTop: 2 }}>
            IMEI: <span className="mono">{producto.imei || '—'}</span> · {producto.clase}
          </div>
          <div className="tiny" style={{ marginTop: 6 }}>
            Estado:{' '}
            <b style={{ color: esVendido ? 'var(--neg)' : 'var(--pos)' }}>
              {producto.estado}
            </b>
            {' · '}cantidad <b>{producto.cantidad}</b>
            {' · '}costo {fmtMoney(producto.costo, producto.costo_moneda)}
          </div>
          {producto.deleted_at && (
            <div className="tiny" style={{ marginTop: 4, color: 'var(--text-muted)' }}>
              <Icons.Trash size={11} aria-hidden="true"/> Soft-deleted el {fmtDateTime(producto.deleted_at)}
            </div>
          )}
        </div>
        {puedeRestaurar && (
          <button className="btn btn-primary" onClick={() => onRestore(producto)}>
            Restaurar al stock
          </button>
        )}
      </div>

      {/* Trail de movimientos B2B que tocaron este producto */}
      <div style={{ marginTop: 12 }}>
        <div className="tiny" style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-muted)' }}>
          Historial de movimientos B2B que tocaron este producto ({trail.length})
        </div>
        {trail.length === 0 ? (
          <div className="tiny muted">— Ninguno —</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Cliente</th>
                  <th>Tipo</th>
                  <th style={{ textAlign: 'right' }}>Cant.</th>
                  <th>Estado mov.</th>
                  <th>Creado</th>
                </tr>
              </thead>
              <tbody>
                {trail.map(t => (
                  <tr key={t.item_id}>
                    <td className="mono tiny">{fmtDate(t.mov_fecha)}</td>
                    <td className="tiny">
                      {[t.cliente_nombre, t.cliente_apellido].filter(Boolean).join(' ') || '—'}
                    </td>
                    <td className="tiny"><b>{t.mov_tipo}</b></td>
                    <td className="mono tiny" style={{ textAlign: 'right' }}>{t.item_cantidad}</td>
                    <td className="tiny">
                      {t.mov_deleted_at ? (
                        <span style={{ color: 'var(--neg)' }}>
                          Borrado {fmtDateTime(t.mov_deleted_at)}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--pos)' }}>Vivo</span>
                      )}
                    </td>
                    <td className="tiny muted">{fmtDateTime(t.mov_created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Panel principal ─────────────────────────────────────────────────────────
export default function DiagnoseStockPanel() {
  const { toast } = useToast();
  const [imei, setImei]           = useState('');
  const [loading, setLoading]     = useState(false);
  const [data, setData]           = useState(null); // { productos, movimientos_cc, query }
  const [restoreFor, setRestoreFor] = useState(null);

  async function handleDiagnose(e) {
    e?.preventDefault?.();
    const q = imei.trim();
    if (!q) return;
    setLoading(true);
    try {
      const r = await adminApi.diagnoseProducto({ imei: q });
      setData({ ...r, query: q });
    } catch (err) {
      toast.error(err.message || 'Error al consultar.');
    } finally {
      setLoading(false);
    }
  }

  function handleRestoreDone(updatedProducto) {
    // Actualizar el producto en el estado local para que el botón ya no aparezca.
    setData(prev => prev ? {
      ...prev,
      productos: prev.productos.map(p =>
        p.id === updatedProducto.id
          ? { ...p, estado: updatedProducto.estado, cantidad: Number(updatedProducto.cantidad) }
          : p
      ),
    } : prev);
    setRestoreFor(null);
  }

  // Agrupar trail por producto_id para pasar a cada card.
  const trailByProducto = data
    ? data.movimientos_cc.reduce((acc, t) => {
        const k = t.producto_id;
        (acc[k] = acc[k] || []).push(t);
        return acc;
      }, {})
    : {};

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Diagnóstico de stock</h3>
        <p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: 13.5 }}>
          Inspeccioná el historial completo de un producto por IMEI/serial: estado actual + todos
          los movimientos B2B que lo tocaron (incluso los borrados). Si un producto vivo quedó
          incorrectamente en <code>vendido</code>, podés restaurarlo al stock con auditoría.
        </p>
      </div>

      <form onSubmit={handleDiagnose} style={{ padding: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="IMEI o serial (ej: 350900000000123)"
          value={imei}
          onChange={(e) => setImei(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
          disabled={loading}
        />
        <button className="btn btn-primary" type="submit" disabled={loading || !imei.trim()}>
          {loading ? 'Buscando…' : 'Diagnosticar'}
        </button>
      </form>

      {data && (
        <div style={{ padding: '0 16px 16px' }}>
          {data.productos.length === 0 ? (
            <div className="tiny muted" style={{ padding: 12 }}>
              Sin productos con IMEI/serial <span className="mono">{data.query}</span>.
            </div>
          ) : (
            <>
              <div className="tiny muted" style={{ marginBottom: 10 }}>
                {data.productos.length} producto(s) encontrado(s) ·
                {' '}{data.movimientos_cc.length} movimiento(s) B2B en el trail.
              </div>
              {data.productos.map(p => (
                <ProductoCard
                  key={p.id}
                  producto={p}
                  trail={trailByProducto[p.id] || []}
                  onRestore={setRestoreFor}
                />
              ))}
            </>
          )}
        </div>
      )}

      {restoreFor && (
        <RestoreModal
          producto={restoreFor}
          onClose={() => setRestoreFor(null)}
          onDone={handleRestoreDone}
        />
      )}
    </div>
  );
}

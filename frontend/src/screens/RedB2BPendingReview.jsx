// Red B2B Pendientes de revisión (F2 #455).
//
// Pantalla buyer-side para revisar productos auto-creados por operaciones
// cross-tenant (el trigger del auto-create viene en F3 — por ahora estos
// productos se insertan manualmente en backend para testear el flow).
//
// Acciones por fila:
//   · Confirmar nuevo  → POST /:id/confirm-new  (clearea el flag)
//   · Mergear con...   → abre modal con picker de productos del catálogo,
//                        submit → POST /:id/merge-into { target_producto_id }
//
// Empty state explica qué son productos pending review para que el operador
// nuevo entienda de dónde vinieron sin tener que abrir el design doc.
//
// PR-X3 #465: split en `RedB2BPendingReviewContent` (named export, sin
// page-head) + default export wrapper standalone. El Content se renderea
// dentro del tab "Pendientes Red B2B" de Inventario (sin duplicar el
// header de la pantalla huésped). El wrapper standalone se mantiene para
// retro-compat con la ruta /red-b2b/pending-review (que ahora redirige al
// nuevo home, pero el componente sigue funcional si lo importamos directo
// en tests o lo montamos a futuro).

import { useState, useEffect, useCallback, useMemo } from 'react';
import { redB2b, inventario } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { Icons } from '../components/Icons';

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatPrice(n) {
  if (n == null || n === '') return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Content (sin page-head) ──────────────────────────────────────────────────
// PR-X3 #465: este es el corazón de la pantalla, sin el header propio.
// Lo embebemos como tab dentro de Inventario para que el operador encuentre
// los productos pendientes en el mismo módulo donde ya gestiona stock —
// menos saltos, menos pantallas que descubrir.
//
// Props:
//   - onCountChange (opcional): callback que recibe la cantidad de pendientes
//     cada vez que se refresca el listado. Sirve para que el huésped
//     (Inventario tab badge) actualice su counter sin un fetch adicional.
//
// Cuando el componente se monta y existe `onCountChange`, dispara el callback
// con el count inicial. Idem en cada refresh post-acción (confirmar/mergear).
export function RedB2BPendingReviewContent({ onCountChange } = {}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [pendientes, setPendientes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null);
  const [mergeOpen, setMergeOpen] = useState(null); // el producto pending que estamos por mergear

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await redB2b.productosPendingReview.list();
      const list = r.pendientes || [];
      setPendientes(list);
      if (typeof onCountChange === 'function') onCountChange(list.length);
    } catch (err) {
      toast.error(err.message || 'No pudimos cargar los productos pendientes');
      setPendientes([]);
      if (typeof onCountChange === 'function') onCountChange(0);
    } finally {
      setLoading(false);
    }
  }, [toast, onCountChange]);

  useEffect(() => { load(); }, [load]);

  async function handleConfirm(p) {
    const ok = await confirm({
      title: 'Confirmar como nuevo',
      message: `¿Confirmás "${p.nombre}" como nuevo producto en tu catálogo? Quedará disponible para vender.`,
      confirmLabel: 'Confirmar',
    });
    if (!ok) return;
    setActing(p.id);
    try {
      await redB2b.productosPendingReview.confirmNew(p.id);
      toast.success('Producto confirmado en el catálogo');
      await load();
    } catch (err) {
      toast.error(err.message || 'No pudimos confirmar el producto');
    } finally {
      setActing(null);
    }
  }

  function openMerge(p) {
    setMergeOpen(p);
  }

  async function handleMergeSubmit(targetId) {
    if (!mergeOpen) return;
    setActing(mergeOpen.id);
    try {
      const r = await redB2b.productosPendingReview.mergeInto(mergeOpen.id, targetId);
      toast.success(`Mergeado — ${r.stock_added} unidades agregadas al destino`);
      setMergeOpen(null);
      await load();
    } catch (err) {
      toast.error(err.message || 'No pudimos mergear el producto');
    } finally {
      setActing(null);
    }
  }

  return (
    <div>
      <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
        Productos que tus partners Red B2B agregaron a tu catálogo automáticamente
        a través de operaciones cross-tenant. Confirmalos como nuevos o mergealos
        con productos que ya tenés.
      </p>

      {loading ? (
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
          Cargando productos pendientes...
        </div>
      ) : pendientes.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="card">
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Partner</th>
                <th>Producto</th>
                <th style={{ textAlign: 'right' }}>Stock recibido</th>
                <th>Recibido</th>
                <th style={{ textAlign: 'right' }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {pendientes.map((p) => (
                <PendingRow
                  key={p.id}
                  p={p}
                  acting={acting === p.id}
                  onConfirm={() => handleConfirm(p)}
                  onMerge={() => openMerge(p)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {mergeOpen && (
        <MergeModal
          source={mergeOpen}
          onClose={() => setMergeOpen(null)}
          onSubmit={handleMergeSubmit}
        />
      )}
    </div>
  );
}

// ── Wrapper standalone (con page-head) ──────────────────────────────────────
// Preservado por retro-compat. La ruta /red-b2b/pending-review en App.jsx
// ahora redirige a /inventario?tab=red-b2b-pending (PR-X3 cleanup), pero
// dejamos el wrapper exportado por si un test viejo o un futuro PR lo
// necesita montar standalone.
export default function RedB2BPendingReview() {
  return (
    <div>
      <div className="page-head" style={{ marginBottom: 20 }}>
        <h1>Productos pendientes de revisión</h1>
      </div>
      <RedB2BPendingReviewContent />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state" style={{ padding: 32, textAlign: 'center' }}>
      <p style={{ fontWeight: 600, marginBottom: 4 }}>Sin productos pendientes</p>
      <p className="muted" style={{ marginBottom: 12 }}>
        Cuando un partner Red B2B te envíe una venta cross-tenant, los productos
        nuevos aparecerán acá para que los confirmes en tu catálogo o los
        mergees con productos que ya tenés.
      </p>
    </div>
  );
}

function PendingRow({ p, acting, onConfirm, onMerge }) {
  const partner = p.partner || {};
  return (
    <tr>
      <td>
        {partner.nombre ? (
          <>
            <div style={{ fontWeight: 600 }}>{partner.nombre}</div>
            <div className="muted tiny">{partner.slug}</div>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <div style={{ fontWeight: 600 }}>{p.nombre}</div>
        {p.sku && <div className="muted tiny">SKU: {p.sku}</div>}
        {p.precio != null && (
          <div className="muted tiny">Precio: {formatPrice(p.precio)}</div>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>{p.stock ?? 0}</td>
      <td>{formatDate(p.created_at)}</td>
      <td style={{ textAlign: 'right' }}>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={acting}
            onClick={onConfirm}
          >
            Confirmar
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={acting}
            onClick={onMerge}
          >
            Mergear
          </button>
        </div>
      </td>
    </tr>
  );
}

// Modal con picker simple de productos del catálogo del buyer. Filtramos
// el source mismo y los productos deleted/pending (queremos mergear sobre
// catálogo "normal").
function MergeModal({ source, onClose, onSubmit }) {
  const { toast } = useToast();
  const [productos, setProductos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    inventario.productos({ limit: 500 })
      .then((r) => {
        if (cancelled) return;
        // El endpoint inventario.productos devuelve la respuesta paginada o
        // una lista. Tomamos `items` si existe, sino la raíz.
        const list = Array.isArray(r) ? r : (r.items || r.productos || r.rows || []);
        // Filtrar: no incluir el source ni otros pending (queremos mergear
        // en productos del catálogo regular). El endpoint inventario por
        // default ya filtra soft-deleted.
        setProductos(list.filter((x) =>
          x.id !== source.id && !x.pending_cross_tenant_review
        ));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err.message || 'No pudimos cargar el catálogo');
        setProductos([]);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [source.id, toast]);

  const filtered = useMemo(() => {
    if (!query.trim()) return productos.slice(0, 200);
    const q = query.toLowerCase();
    return productos
      .filter((p) => (p.nombre || '').toLowerCase().includes(q))
      .slice(0, 200);
  }, [productos, query]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!selectedId) return;
    setSubmitting(true);
    try {
      await onSubmit(selectedId);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="merge-modal-title"
        style={{ maxWidth: 600 }}
      >
        <h2 id="merge-modal-title">Mergear con producto existente</h2>
        <p className="muted" style={{ marginTop: -8, marginBottom: 12 }}>
          Vas a mergear <strong>{source.nombre}</strong> ({source.stock ?? 0}{' '}
          unidades) en un producto existente de tu catálogo. El stock se sumará
          al destino y el producto pendiente quedará archivado.
        </p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="merge-search" style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>
            Buscar producto destino
          </label>
          <input
            id="merge-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Escribí parte del nombre..."
            autoFocus
            disabled={submitting}
            style={{ width: '100%', marginBottom: 12 }}
          />
          <div
            style={{
              maxHeight: 280,
              overflowY: 'auto',
              border: '1px solid var(--border, #ddd)',
              borderRadius: 4,
              marginBottom: 12,
            }}
          >
            {loading ? (
              <div className="muted" style={{ padding: 16, textAlign: 'center' }}>
                Cargando catálogo...
              </div>
            ) : filtered.length === 0 ? (
              <div className="muted" style={{ padding: 16, textAlign: 'center' }}>
                {query ? 'Sin resultados' : 'No hay productos en tu catálogo'}
              </div>
            ) : (
              filtered.map((p) => (
                <label
                  key={p.id}
                  style={{
                    display: 'flex',
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border-light, #eee)',
                    cursor: 'pointer',
                    background: selectedId === p.id ? 'var(--accent-soft, #eef)' : 'transparent',
                  }}
                >
                  <input
                    type="radio"
                    name="merge-target"
                    value={p.id}
                    checked={selectedId === p.id}
                    onChange={() => setSelectedId(p.id)}
                    disabled={submitting}
                    style={{ marginRight: 10 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{p.nombre}</div>
                    <div className="muted tiny">
                      Stock actual: {p.cantidad ?? 0}
                      {p.imei && ` · IMEI: ${p.imei}`}
                    </div>
                  </div>
                </label>
              ))
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={submitting}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!selectedId || submitting}
            >
              {submitting ? 'Mergeando...' : 'Mergear'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Helper export para que el sidebar / Shell pueda fetchear el contador.
// Simplemente reusa el GET / y devuelve la cantidad — sin endpoint
// dedicado para mantener simple la integración (sugerencia del spec).
export async function fetchPendingReviewCount() {
  try {
    const r = await redB2b.productosPendingReview.list();
    return Array.isArray(r.pendientes) ? r.pendientes.length : 0;
  } catch {
    return 0;
  }
}
